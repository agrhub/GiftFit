/**
 * Hardened fetcher for ARBITRARY public URLs (owner: A10; ADR-055 store-URL preview). The allow-listed
 * /api/ingest path keeps using politeness.ts; this file is only for hosts a visitor typed in.
 *
 * SSRF guards (all mandatory, all re-applied on every redirect hop):
 *   - https only, no userinfo, default port only (443), no IP-literal hosts, no single-label or
 *     internal-looking names, never `metadata` / `metadata.google.internal`;
 *   - the hostname is resolved (A and AAAA, `lookup(all)`), and the fetch is refused when ANY address is
 *     private, loopback, link-local, CGNAT, multicast, unspecified, reserved, documentation, IPv4-mapped
 *     IPv6, ULA, NAT64/6to4/Teredo, or 169.254.169.254 (IPv6: only 2000::/3 global unicast is allowed);
 *   - the TCP connection goes to the vetted address itself (custom `lookup` on the request, SNI and Host
 *     = the hostname), so a second DNS answer (rebinding) can never change where we connect; the socket's
 *     remote address is checked again after connect;
 *   - redirects are manual, ≤ 3, each hop validated and resolved from scratch;
 *   - timeouts: connect 5 s, total 10 s per fetch (redirects included);
 *   - response size caps enforced while streaming (after decompression): HTML / JSON / XML ≤ 2 MB,
 *     robots.txt ≤ 256 KB; content-type checked per expected kind;
 *   - honest User-Agent; robots.txt honoured for `GiftFitPreviewBot` (and `*`); ≤ 1 request / s / host,
 *     serial; 403 / 429 / 503 stop the host for the rest of the run; ≤ 30 fetches per preview (robots and
 *     every redirect hop count).
 * Errors never carry resolved IP addresses or full URLs with query strings.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP, type Socket } from "node:net";
import type { Readable } from "node:stream";
import zlib from "node:zlib";
import robotsParser from "robots-parser";

export const PREVIEW_BOT = "GiftFitPreviewBot";
export const PREVIEW_INFO_URL = "https://giftfit-469920173665.us-central1.run.app/merchants";
export const PREVIEW_USER_AGENT = `${PREVIEW_BOT}/1.0 (+${PREVIEW_INFO_URL})`;

export const CONNECT_TIMEOUT_MS = 5_000;
export const TOTAL_TIMEOUT_MS = 10_000;
export const MAX_REDIRECTS = 3;
export const PREVIEW_FETCH_BUDGET = 30;
export const MIN_INTERVAL_MS = 1_000;
/** A robots.txt Crawl-delay above this stops the host (a preview must finish in about a minute). */
export const MAX_CRAWL_DELAY_MS = 5_000;

export type BodyKind = "html" | "json" | "xml" | "robots";
const MB = 1024 * 1024;
export const SIZE_CAPS: Record<BodyKind, number> = { html: 2 * MB, json: 2 * MB, xml: 2 * MB, robots: 256 * 1024 };

const ACCEPT: Record<BodyKind, string> = {
  html: "text/html,application/xhtml+xml;q=0.9",
  json: "application/json",
  xml: "application/xml,text/xml;q=0.9",
  robots: "text/plain",
};
const CONTENT_TYPES: Record<BodyKind, RegExp> = {
  html: /^(text\/html|application\/xhtml\+xml)\b/i,
  json: /^(application\/([\w.-]+\+)?json|text\/json)\b/i,
  xml: /^((application|text)\/([\w.-]+\+)?xml)\b/i,
  robots: /^text\/plain\b/i,
};

export type SafeFetchErrorCode =
  | "invalid_url"
  | "blocked_url"
  | "dns_failed"
  | "too_many_redirects"
  | "timeout"
  | "too_large"
  | "bad_content_type"
  | "bad_encoding"
  | "robots_disallowed"
  | "budget_exceeded"
  | "host_stopped"
  | "network";

export class SafeFetchError extends Error {
  constructor(
    readonly code: SafeFetchErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = "SafeFetchError";
  }
}

export const isSafeFetchError = (e: unknown, code?: SafeFetchErrorCode): e is SafeFetchError =>
  e instanceof SafeFetchError && (code === undefined || e.code === code);

/** "https://shop.example/products/x" without query or fragment, for logs and errors. */
export function redactUrl(u: URL | string): string {
  try {
    const url = typeof u === "string" ? new URL(u) : u;
    return `${url.protocol}//${url.hostname}${url.pathname.length > 80 ? `${url.pathname.slice(0, 80)}…` : url.pathname}`;
  } catch {
    return "<invalid url>";
  }
}

// ---------------------------------------------------------------------------------------------------
// URL and address policy
// ---------------------------------------------------------------------------------------------------

const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata", "metadata.google.internal", "metadata.goog", "instance-data", "kubernetes.default", "kubernetes.default.svc"]);
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".corp", ".home", ".lan", ".localdomain", ".home.arpa", ".arpa", ".svc", ".cluster.local", ".onion"];

/** Normalised host for policy checks: lower-case, no brackets, no trailing dot. */
function policyHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
}

/**
 * Parses and checks a URL against the static policy (no DNS). Throws `invalid_url` for anything that is
 * not an absolute https URL, `blocked_url` for userinfo, a custom port, an IP literal or an internal name.
 */
export function checkUrl(raw: string | URL): URL {
  let url: URL;
  try {
    url = typeof raw === "string" ? new URL(raw.trim()) : new URL(raw.href);
  } catch {
    throw new SafeFetchError("invalid_url", "not a valid absolute URL");
  }
  if (url.protocol !== "https:") throw new SafeFetchError(url.protocol === "http:" ? "blocked_url" : "invalid_url", "only https URLs are fetched");
  if (url.username || url.password) throw new SafeFetchError("blocked_url", "credentials in URLs are not allowed");
  if (url.port !== "" && url.port !== "443") throw new SafeFetchError("blocked_url", "only the default https port is allowed");
  const host = policyHost(url.hostname);
  if (!host || host.length > 253) throw new SafeFetchError("invalid_url", "missing host");
  if (isIP(host) !== 0) throw new SafeFetchError("blocked_url", "IP-address hosts are not allowed");
  // WHATWG URL already turns decimal/hex/octal IPv4 forms into dotted quads; reject anything numeric-looking left.
  if (/^[0-9.]+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) throw new SafeFetchError("blocked_url", "IP-address hosts are not allowed");
  if (!host.includes(".")) throw new SafeFetchError("blocked_url", "single-label hosts are not allowed");
  if (BLOCKED_HOSTNAMES.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) throw new SafeFetchError("blocked_url", "internal host names are not allowed");
  if (!/^[a-z0-9.-]+$/.test(host)) throw new SafeFetchError("invalid_url", "host name has invalid characters");
  url.hash = "";
  return url;
}

const BLOCKED_V4 = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this network", unspecified
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (incl. 169.254.169.254 metadata)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.31.196.0", 24], // AS112
  ["192.52.193.0", 24], // AMT
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["192.175.48.0", 24], // AS112
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
] as const) {
  BLOCKED_V4.addSubnet(net, prefix, "ipv4");
}

/** IPv6: only global unicast 2000::/3 is reachable, minus the special-purpose ranges inside it. */
const ALLOWED_V6 = new BlockList();
ALLOWED_V6.addSubnet("2000::", 3, "ipv6");
const BLOCKED_V6 = new BlockList();
for (const [net, prefix] of [
  ["2001::", 23], // IETF protocol assignments (Teredo 2001::/32, ORCHID, benchmarking, ...)
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4 (embeds an IPv4 address)
  ["3fff::", 20], // documentation (RFC 9637)
] as const) {
  BLOCKED_V6.addSubnet(net, prefix, "ipv6");
}

/**
 * True when the address must never be connected to. Unknown formats are blocked. IPv4-mapped (::ffff:0:0/96),
 * IPv4-compatible, NAT64 (64:ff9b::/96), ULA (fc00::/7), link-local (fe80::/10), multicast (ff00::/8),
 * loopback (::1) and unspecified (::) fall outside 2000::/3 and are blocked.
 */
export function isBlockedAddress(address: string): boolean {
  const a = address.trim().replace(/^\[|\]$/g, "");
  if (a.includes("%")) return true; // zone ids are link-local by definition
  const family = isIP(a);
  if (family === 4) return BLOCKED_V4.check(a, "ipv4");
  if (family === 6) {
    // Node's BlockList matches IPv4-mapped IPv6 against IPv4 rules; an explicit mapped check keeps this obvious.
    if (/^(0{0,4}:){0,5}:?ffff:/i.test(a) || /^::(ffff:)?\d+\.\d+\.\d+\.\d+$/i.test(a)) return true;
    if (!ALLOWED_V6.check(a, "ipv6")) return true;
    return BLOCKED_V6.check(a, "ipv6");
  }
  return true;
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export const systemResolver: Resolver = async (hostname) => {
  const found = await dnsLookup(hostname, { all: true, verbatim: true });
  return found.map((f) => ({ address: f.address, family: f.family === 6 ? 6 : 4 }));
};

/**
 * Resolves the hostname and returns ONE vetted address to connect to. Throws `blocked_url` when any
 * address is blocked (an attacker controlling the zone could otherwise mix a public and a private
 * answer), `dns_failed` when nothing resolves.
 */
export async function vetHost(hostname: string, resolver: Resolver = systemResolver, isBlocked: (ip: string) => boolean = isBlockedAddress): Promise<ResolvedAddress> {
  let addrs: ResolvedAddress[];
  try {
    addrs = await resolver(policyHost(hostname));
  } catch {
    throw new SafeFetchError("dns_failed", "the host name does not resolve");
  }
  if (!addrs.length) throw new SafeFetchError("dns_failed", "the host name does not resolve");
  if (addrs.some((a) => isBlocked(a.address))) throw new SafeFetchError("blocked_url", "the host resolves to a non-public address");
  const first = addrs.find((a) => a.family === 4) ?? addrs[0];
  return { address: first.address, family: isIP(first.address) === 6 ? 6 : 4 };
}

/** Static check + DNS vetting, for validating a URL a visitor submitted before queueing work. */
export async function assertPublicUrl(raw: string | URL, resolver?: Resolver): Promise<URL> {
  const url = checkUrl(raw);
  await vetHost(url.hostname, resolver);
  return url;
}

// ---------------------------------------------------------------------------------------------------
// Pinned transport
// ---------------------------------------------------------------------------------------------------

export interface PinnedRequest {
  url: URL;
  /** The vetted address the socket must connect to. */
  address: string;
  family: 4 | 6;
  headers: Record<string, string>;
  maxBytes: number;
  connectTimeoutMs: number;
  /** Absolute deadline (ms since epoch) for the whole response. */
  deadline: number;
}
export interface PinnedResponse {
  status: number;
  headers: Record<string, string>;
  /** Decompressed body (≤ maxBytes); empty for non-2xx responses. */
  body: Buffer;
}
export type Transport = (req: PinnedRequest) => Promise<PinnedResponse>;

export interface PinnedRequestOptions {
  /** Tests only: plain HTTP to a local server. Production is always https on 443. */
  protocol?: "https:" | "http:";
  port?: number;
  ca?: string | Buffer;
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | { address: string; family: number }[], family?: number) => void;

/**
 * One GET to `req.address` (never re-resolved): `lookup` is pinned to the vetted address, TLS SNI and the
 * Host header carry the hostname, certificate verification is the default one against the hostname.
 */
export function pinnedRequest(req: PinnedRequest, opts: PinnedRequestOptions = {}): Promise<PinnedResponse> {
  const protocol = opts.protocol ?? "https:";
  const mod = protocol === "http:" ? http : https;
  const { url, address, family } = req;
  return new Promise<PinnedResponse>((resolve, reject) => {
    let settled = false;
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      clearTimeout(connectTimer);
      reject(err instanceof SafeFetchError ? err : new SafeFetchError("network", "the request failed"));
    };
    const lookup = (_host: string, options: unknown, cb?: LookupCb) => {
      const callback = (typeof options === "function" ? options : cb) as LookupCb;
      const all = typeof options === "object" && options !== null && (options as { all?: boolean }).all;
      if (all) callback(null, [{ address, family }]);
      else callback(null, address, family);
    };
    const r = mod.request({
      protocol,
      hostname: url.hostname,
      port: opts.port ?? 443,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: { ...req.headers, host: url.hostname },
      lookup: lookup as never,
      agent: false,
      ...(protocol === "https:" ? { servername: url.hostname, ...(opts.ca ? { ca: opts.ca } : {}) } : {}),
    });
    /** Settles with `err` first (an error after the response started may never reach r's "error"), then tears down. */
    const abort = (err: SafeFetchError) => {
      fail(err);
      r.destroy();
    };
    const totalTimer = setTimeout(() => abort(new SafeFetchError("timeout", "the request timed out")), Math.max(1, req.deadline - Date.now()));
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    r.on("socket", (socket: Socket) => {
      connectTimer = setTimeout(() => abort(new SafeFetchError("timeout", "connect timed out")), req.connectTimeoutMs);
      socket.once("connect", () => {
        clearTimeout(connectTimer);
        // Defence in depth: the kernel-level peer must be the vetted address.
        const peer = socket.remoteAddress?.replace(/^::ffff:/i, "");
        if (peer && peer !== address.replace(/^::ffff:/i, "")) abort(new SafeFetchError("blocked_url", "connected to an unexpected address"));
      });
    });
    r.on("error", fail);
    r.on("response", (res) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
      const status = res.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        res.resume();
        res.destroy();
        settled = true;
        clearTimeout(totalTimer);
        resolve({ status, headers, body: Buffer.alloc(0) });
        return;
      }
      const declared = Number(headers["content-length"]);
      if (Number.isFinite(declared) && declared > req.maxBytes) {
        abort(new SafeFetchError("too_large", "the response is too large"));
        res.destroy();
        return;
      }
      const enc = (headers["content-encoding"] ?? "identity").toLowerCase().trim();
      let stream: Readable = res;
      if (enc === "gzip" || enc === "x-gzip") stream = res.pipe(zlib.createGunzip());
      else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
      else if (enc === "br") stream = res.pipe(zlib.createBrotliDecompress());
      else if (enc !== "identity" && enc !== "") {
        abort(new SafeFetchError("bad_encoding", "unsupported content encoding"));
        res.destroy();
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      stream.on("data", (c: Buffer) => {
        total += c.length;
        if (total > req.maxBytes) {
          abort(new SafeFetchError("too_large", "the response is too large"));
          res.destroy();
          if (stream !== res) stream.destroy();
          return;
        }
        chunks.push(c);
      });
      stream.on("error", (e) => abort(e instanceof SafeFetchError ? e : new SafeFetchError(stream === res ? "network" : "bad_encoding", "the response could not be read")));
      res.on("aborted", () => fail(new SafeFetchError("network", "the response was cut off")));
      stream.on("end", () => {
        if (settled) return;
        settled = true;
        clearTimeout(totalTimer);
        resolve({ status, headers, body: Buffer.concat(chunks) });
      });
    });
    r.end();
  });
}

export const httpsPinnedTransport: Transport = (req) => pinnedRequest(req);

// ---------------------------------------------------------------------------------------------------
// The per-preview fetcher: robots, budget, rate, redirects
// ---------------------------------------------------------------------------------------------------

export interface SafeResponse {
  /** Final URL after redirects. */
  url: string;
  status: number;
  contentType: string;
  headers: Record<string, string>;
  body: string;
}

export interface SafeFetcherOptions {
  resolver?: Resolver;
  transport?: Transport;
  /** Address policy; tests may relax it to reach a local server. Default: isBlockedAddress. */
  isBlocked?: (ip: string) => boolean;
  budget?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  userAgent?: string;
  connectTimeoutMs?: number;
  totalTimeoutMs?: number;
}

interface RobotsEntry {
  allowAll: boolean;
  disallowAll: boolean;
  robot?: ReturnType<typeof robotsParser>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function decode(body: Buffer, contentType: string): string {
  const cs = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  if (cs && !/^utf-?8$/i.test(cs)) {
    try {
      return new TextDecoder(cs).decode(body);
    } catch {
      /* fall back to UTF-8 */
    }
  }
  return new TextDecoder("utf-8").decode(body);
}

export class SafeFetcher {
  readonly userAgent: string;
  readonly budget: number;
  private readonly resolver: Resolver;
  private readonly transport: Transport;
  private readonly isBlocked: (ip: string) => boolean;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly connectTimeoutMs: number;
  private readonly totalTimeoutMs: number;
  private readonly robots = new Map<string, Promise<RobotsEntry>>();
  private readonly stopped = new Map<string, string>();
  private readonly nextSlot = new Map<string, number>();
  private chain: Promise<void> = Promise.resolve();
  private used = 0;
  private responses = 0;

  constructor(opts: SafeFetcherOptions = {}) {
    this.resolver = opts.resolver ?? systemResolver;
    this.transport = opts.transport ?? httpsPinnedTransport;
    this.isBlocked = opts.isBlocked ?? isBlockedAddress;
    this.budget = Math.min(PREVIEW_FETCH_BUDGET, opts.budget ?? PREVIEW_FETCH_BUDGET);
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? defaultSleep;
    this.userAgent = opts.userAgent ?? PREVIEW_USER_AGENT;
    this.connectTimeoutMs = Math.min(CONNECT_TIMEOUT_MS, opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);
    this.totalTimeoutMs = Math.min(TOTAL_TIMEOUT_MS, opts.totalTimeoutMs ?? TOTAL_TIMEOUT_MS);
  }

  /** Fetches spent (robots and redirect hops included). */
  get fetches(): number {
    return this.used;
  }
  get remaining(): number {
    return Math.max(0, this.budget - this.used);
  }
  /** HTTP responses received (any status); 0 means the host never answered. */
  get answered(): number {
    return this.responses;
  }

  /** robots.txt verdict for the URL (fetches the host's robots.txt once per run). */
  async isAllowed(raw: string | URL): Promise<boolean> {
    const url = checkUrl(raw);
    const entry = await this.robotsFor(url);
    if (entry.disallowAll) return false;
    if (entry.allowAll || !entry.robot) return true;
    return entry.robot.isAllowed(url.href, PREVIEW_BOT) !== false;
  }

  /** Sitemap URLs declared in the host's robots.txt. */
  async sitemapsFor(raw: string | URL): Promise<string[]> {
    const entry = await this.robotsFor(checkUrl(raw));
    return entry.robot ? entry.robot.getSitemaps() : [];
  }

  /** Robots-checked GET with manual, re-validated redirects. Non-2xx statuses are returned, not thrown. */
  async get(raw: string | URL, kind: Exclude<BodyKind, "robots">): Promise<SafeResponse> {
    return this.fetch(checkUrl(raw), kind, true);
  }

  private async fetch(start: URL, kind: BodyKind, checkRobots: boolean): Promise<SafeResponse> {
    const deadline = this.now() + this.totalTimeoutMs;
    let url = start;
    for (let hop = 0; ; hop++) {
      if (checkRobots && !(await this.isAllowed(url))) throw new SafeFetchError("robots_disallowed", `robots.txt disallows ${redactUrl(url)}`);
      const res = await this.once(url, kind, deadline);
      if (res.status >= 300 && res.status < 400 && res.headers.location) {
        if (hop >= MAX_REDIRECTS) throw new SafeFetchError("too_many_redirects", "too many redirects");
        let next: URL;
        try {
          next = new URL(res.headers.location, url);
        } catch {
          throw new SafeFetchError("invalid_url", "invalid redirect target");
        }
        url = checkUrl(next);
        continue;
      }
      const contentType = res.headers["content-type"] ?? "";
      if (res.status >= 200 && res.status < 300 && kind !== "robots" && !CONTENT_TYPES[kind].test(contentType.trim())) {
        throw new SafeFetchError("bad_content_type", `unexpected content type for ${kind}`);
      }
      return { url: url.href, status: res.status, contentType, headers: res.headers, body: decode(res.body, contentType) };
    }
  }

  /** One request: host stop flag, budget, rate slot, DNS vetting, pinned transport. */
  private async once(url: URL, kind: BodyKind, deadline: number): Promise<PinnedResponse> {
    const host = url.hostname.toLowerCase();
    const stop = this.stopped.get(host);
    if (stop) throw new SafeFetchError("host_stopped", `host stopped: ${stop}`);
    const interval = kind === "robots" ? MIN_INTERVAL_MS : await this.intervalFor(url);
    if (this.used >= this.budget) throw new SafeFetchError("budget_exceeded", `fetch budget of ${this.budget} reached`);
    this.used++;
    const release = await this.slot(host, interval);
    try {
      if (this.now() >= deadline) throw new SafeFetchError("timeout", "the request timed out");
      const { address, family } = await vetHost(url.hostname, this.resolver, this.isBlocked);
      const res = await this.transport({
        url,
        address,
        family,
        headers: { "user-agent": this.userAgent, accept: ACCEPT[kind], "accept-encoding": "gzip, deflate, br", "accept-language": "en;q=0.9, *;q=0.5" },
        maxBytes: SIZE_CAPS[kind],
        connectTimeoutMs: this.connectTimeoutMs,
        deadline,
      });
      this.responses++;
      if (res.status === 403 || res.status === 429 || res.status === 503) this.stopped.set(host, `HTTP ${res.status}`);
      return res;
    } finally {
      release();
    }
  }

  private async intervalFor(url: URL): Promise<number> {
    const entry = await this.robotsFor(url);
    const delay = entry.robot?.getCrawlDelay(PREVIEW_BOT);
    const ms = delay && Number.isFinite(delay) ? delay * 1_000 : 0;
    if (ms > MAX_CRAWL_DELAY_MS) {
      this.stopped.set(url.hostname.toLowerCase(), "Crawl-delay too long");
      throw new SafeFetchError("host_stopped", "robots.txt asks for a longer crawl delay than a preview allows");
    }
    return Math.max(MIN_INTERVAL_MS, ms);
  }

  private robotsFor(url: URL): Promise<RobotsEntry> {
    const origin = url.origin;
    let p = this.robots.get(origin);
    if (!p) {
      p = this.loadRobots(url);
      this.robots.set(origin, p);
    }
    return p;
  }

  private async loadRobots(url: URL): Promise<RobotsEntry> {
    const robotsUrl = new URL("/robots.txt", url.origin);
    try {
      const res = await this.fetch(robotsUrl, "robots", false);
      if (res.status >= 200 && res.status < 300) return { allowAll: false, disallowAll: false, robot: robotsParser(robotsUrl.href, res.body) };
      if (res.status >= 400 && res.status < 500 && res.status !== 429) return { allowAll: true, disallowAll: false };
      return { allowAll: false, disallowAll: true };
    } catch (err) {
      // Budget or policy errors must surface; network trouble on robots.txt means "disallow all" for this run.
      if (isSafeFetchError(err, "budget_exceeded") || isSafeFetchError(err, "blocked_url")) throw err;
      return { allowAll: false, disallowAll: true };
    }
  }

  /** Serial requests (one in flight per fetcher) and ≥ interval between requests to the same host. */
  private async slot(host: string, intervalMs: number): Promise<() => void> {
    const prev = this.chain;
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    this.chain = prev.then(() => mine);
    await prev;
    const wait = (this.nextSlot.get(host) ?? 0) - this.now();
    if (wait > 0) await this.sleep(wait);
    this.nextSlot.set(host, this.now() + intervalMs);
    return release;
  }
}

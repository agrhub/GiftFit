/**
 * Polite HTTP access for ingest (docs/ingest-policy.md, hard rules):
 * - robots.txt fetched and honored per host before any other request (4xx → allow all; 5xx or network
 *   error → disallow all for this run). Crawl-delay is honored when longer than our own interval.
 * - ≤ 1 request / second / host, serial per host (one request in flight per host).
 * - 24 h response cache; nothing older is served or kept.
 * - Identifying User-Agent.
 * - Back-off: 403 stops the host at once; 429/503 retry at most twice (Retry-After or 2 s, 4 s), then stop.
 * - Page cap per run.
 * Clock, sleep and fetch are injectable so tests run without network or real time.
 */
import robotsParser from "robots-parser";

export const ROBOTS_AGENT = "GiftFitIngest";
export const MIN_INTERVAL_MS = 1_000;
export const CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
export const MAX_RETRIES = 2;
export const BACKOFF_BASE_MS = 2_000;
/** Longest Crawl-delay / Retry-After we wait for; beyond that the host is stopped. */
export const MAX_WAIT_MS = 30_000;
export const REQUEST_TIMEOUT_MS = 20_000;

export function userAgent(infoUrl?: string): string {
  return `${ROBOTS_AGENT}/0.1 (GiftFit hackathon demo catalog crawler; public product data only${infoUrl ? `; +${infoUrl}` : ""})`;
}

export interface HttpResponse {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  fromCache: boolean;
  fetchedAt: number;
}

export interface FetchLikeResponse {
  status: number;
  url?: string;
  headers: { forEach(cb: (value: string, key: string) => void): void };
  text(): Promise<string>;
}
export type FetchLike = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<FetchLikeResponse>;

export class RobotsDisallowedError extends Error {
  constructor(public readonly url: string) {
    super(`robots.txt disallows ${url}`);
    this.name = "RobotsDisallowedError";
  }
}
export class HostStoppedError extends Error {
  constructor(public readonly host: string, public readonly reason: string) {
    super(`host ${host} stopped: ${reason}`);
    this.name = "HostStoppedError";
  }
}
export class PageCapError extends Error {
  constructor(public readonly cap: number) {
    super(`page cap of ${cap} requests reached for this run`);
    this.name = "PageCapError";
  }
}

export interface PoliteFetcherOptions {
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  infoUrl?: string;
  minIntervalMs?: number;
  cacheTtlMs?: number;
  maxPages?: number;
}

interface RobotsEntry {
  fetchedAt: number;
  allowAll: boolean;
  disallowAll: boolean;
  robot?: ReturnType<typeof robotsParser>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const defaultFetch: FetchLike = (url, init) =>
  fetch(url, { headers: init.headers, signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: "follow" });

export class PoliteFetcher {
  readonly userAgent: string;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly minIntervalMs: number;
  private readonly cacheTtlMs: number;
  readonly maxPages: number;
  private readonly cache = new Map<string, HttpResponse>();
  private readonly robots = new Map<string, RobotsEntry>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly nextSlot = new Map<string, number>();
  private readonly stopped = new Map<string, string>();
  private pages = 0;
  private requests = 0;
  private cacheHits = 0;

  constructor(opts: PoliteFetcherOptions = {}) {
    this.fetchImpl = opts.fetch ?? defaultFetch;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? defaultSleep;
    this.minIntervalMs = Math.max(MIN_INTERVAL_MS, opts.minIntervalMs ?? MIN_INTERVAL_MS);
    this.cacheTtlMs = Math.min(CACHE_TTL_MS, opts.cacheTtlMs ?? CACHE_TTL_MS);
    this.maxPages = opts.maxPages ?? 400;
    this.userAgent = userAgent(opts.infoUrl);
  }

  stats() {
    return { requests: this.requests, pages: this.pages, cacheHits: this.cacheHits, stoppedHosts: [...this.stopped.keys()] };
  }

  /** Whether robots.txt lets us fetch this URL (fetches robots.txt once per host per 24 h). */
  async isAllowed(rawUrl: string): Promise<boolean> {
    const url = new URL(rawUrl);
    const entry = await this.robotsFor(url);
    if (entry.disallowAll) return false;
    if (entry.allowAll || !entry.robot) return true;
    return entry.robot.isAllowed(url.href, ROBOTS_AGENT) !== false;
  }

  /** Sitemap URLs declared in robots.txt. */
  async sitemapsFor(rawUrl: string): Promise<string[]> {
    const entry = await this.robotsFor(new URL(rawUrl));
    return entry.robot ? entry.robot.getSitemaps() : [];
  }

  /**
   * Reserve a polite slot for a navigation done by someone else (the Playwright renderer): checks
   * robots, the page cap and the host's stop flag, waits for the host's rate slot, and returns a
   * release function to call when the navigation finishes.
   */
  async acquire(rawUrl: string): Promise<() => void> {
    const url = new URL(rawUrl);
    this.assertRunning(url.host);
    if (!(await this.isAllowed(url.href))) throw new RobotsDisallowedError(url.href);
    this.countPage();
    return this.slot(url.host, await this.intervalFor(url));
  }

  /** Polite GET. Serves from the 24 h cache when possible. */
  async get(rawUrl: string): Promise<HttpResponse> {
    const url = new URL(rawUrl);
    const cached = this.fromCache(url.href);
    if (cached) return cached;
    this.assertRunning(url.host);
    if (!(await this.isAllowed(url.href))) throw new RobotsDisallowedError(url.href);
    this.countPage();
    const interval = await this.intervalFor(url);
    for (let attempt = 0; ; attempt++) {
      const release = await this.slot(url.host, interval);
      let res: HttpResponse;
      try {
        res = await this.rawGet(url.href);
      } finally {
        release();
      }
      if (res.status === 403) this.stop(url.host, "HTTP 403");
      if (res.status === 429 || res.status === 503) {
        const wait = this.retryWait(res, attempt);
        if (attempt >= MAX_RETRIES || wait > MAX_WAIT_MS) this.stop(url.host, `HTTP ${res.status} after ${attempt} retries`);
        await this.sleep(wait);
        continue;
      }
      if (res.status === 200) this.cache.set(url.href, res);
      return res;
    }
  }

  private retryWait(res: HttpResponse, attempt: number): number {
    const ra = res.headers["retry-after"];
    const secs = ra !== undefined ? Number(ra) : NaN;
    return Number.isFinite(secs) && secs >= 0 ? secs * 1_000 : BACKOFF_BASE_MS * 2 ** attempt;
  }

  private fromCache(href: string): HttpResponse | undefined {
    const hit = this.cache.get(href);
    if (!hit) return undefined;
    if (this.now() - hit.fetchedAt >= this.cacheTtlMs) {
      this.cache.delete(href);
      return undefined;
    }
    this.cacheHits++;
    return { ...hit, fromCache: true };
  }

  /** Drop everything older than the TTL (call between runs; also applied lazily on read). */
  purgeExpired(): void {
    const t = this.now();
    for (const [k, v] of this.cache) if (t - v.fetchedAt >= this.cacheTtlMs) this.cache.delete(k);
    for (const [k, v] of this.robots) if (t - v.fetchedAt >= this.cacheTtlMs) this.robots.delete(k);
  }

  private countPage(): void {
    if (this.pages >= this.maxPages) throw new PageCapError(this.maxPages);
    this.pages++;
  }

  private assertRunning(host: string): void {
    const reason = this.stopped.get(host);
    if (reason) throw new HostStoppedError(host, reason);
  }

  private stop(host: string, reason: string): never {
    this.stopped.set(host, reason);
    throw new HostStoppedError(host, reason);
  }

  private async intervalFor(url: URL): Promise<number> {
    const entry = await this.robotsFor(url);
    const delay = entry.robot?.getCrawlDelay(ROBOTS_AGENT);
    const ms = delay && Number.isFinite(delay) ? delay * 1_000 : 0;
    if (ms > MAX_WAIT_MS) this.stop(url.host, `Crawl-delay ${delay}s exceeds our ${MAX_WAIT_MS / 1000}s limit`);
    return Math.max(this.minIntervalMs, ms);
  }

  private async robotsFor(url: URL): Promise<RobotsEntry> {
    const key = `${url.protocol}//${url.host}`;
    const hit = this.robots.get(key);
    if (hit && this.now() - hit.fetchedAt < this.cacheTtlMs) return hit;
    this.assertRunning(url.host);
    const robotsUrl = `${key}/robots.txt`;
    let entry: RobotsEntry;
    const release = await this.slot(url.host, this.minIntervalMs);
    try {
      const res = await this.rawGet(robotsUrl);
      if (res.status >= 200 && res.status < 300) {
        entry = { fetchedAt: this.now(), allowAll: false, disallowAll: false, robot: robotsParser(robotsUrl, res.body) };
      } else if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        entry = { fetchedAt: this.now(), allowAll: true, disallowAll: false };
      } else {
        entry = { fetchedAt: this.now(), allowAll: false, disallowAll: true };
      }
    } catch {
      entry = { fetchedAt: this.now(), allowAll: false, disallowAll: true };
    } finally {
      release();
    }
    this.robots.set(key, entry);
    return entry;
  }

  /** Serial per host: waits for the previous request on the host and for the next free slot. */
  private async slot(host: string, intervalMs: number): Promise<() => void> {
    const prev = this.chains.get(host) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    this.chains.set(
      host,
      prev.then(() => mine),
    );
    await prev;
    const wait = (this.nextSlot.get(host) ?? 0) - this.now();
    if (wait > 0) await this.sleep(wait);
    this.nextSlot.set(host, this.now() + intervalMs);
    return release;
  }

  private async rawGet(href: string): Promise<HttpResponse> {
    this.requests++;
    const res = await this.fetchImpl(href, { headers: { "user-agent": this.userAgent, accept: "text/html,application/json,application/xml;q=0.9,*/*;q=0.5" } });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    const finalUrl = res.url || href;
    if (new URL(finalUrl).host !== new URL(href).host) {
      return { url: finalUrl, status: 599, headers, body: "", fromCache: false, fetchedAt: this.now() };
    }
    return { url: finalUrl, status: res.status, headers, body: await res.text(), fromCache: false, fetchedAt: this.now() };
  }
}

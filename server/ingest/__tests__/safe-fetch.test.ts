/**
 * SSRF and politeness guards of the hardened preview fetcher (ADR-055). Keyless and offline: a fake
 * transport/resolver for policy tests, and a local HTTP(S) server on 127.0.0.1 for the pinned transport
 * (size caps while streaming, timeouts, DNS pinning, TLS SNI/Host).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import path from "node:path";
import zlib from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeNet, PUBLIC_IP } from "@/server/preview/__tests__/fake-site";
import {
  checkUrl,
  isBlockedAddress,
  MAX_REDIRECTS,
  pinnedRequest,
  PREVIEW_FETCH_BUDGET,
  PREVIEW_USER_AGENT,
  SafeFetcher,
  SafeFetchError,
  SIZE_CAPS,
  vetHost,
  type PinnedRequest,
  type Resolver,
} from "../safe-fetch";

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof SafeFetchError ? e.code : `other:${(e as Error).message}`;
  }
};
const codeSync = (fn: () => unknown): string => {
  try {
    fn();
    return "ok";
  } catch (e) {
    return e instanceof SafeFetchError ? e.code : `other:${(e as Error).message}`;
  }
};

describe("checkUrl (static policy)", () => {
  it.each([
    ["http://shop.example.com/", "blocked_url"],
    ["https://shop.example.com:8443/", "blocked_url"],
    ["https://shop.example.com:80/", "blocked_url"],
    ["https://user:pw@shop.example.com/", "blocked_url"],
    ["https://user@shop.example.com/", "blocked_url"],
    ["https://127.0.0.1/", "blocked_url"],
    ["https://[::1]/", "blocked_url"],
    ["https://2130706433/", "blocked_url"],
    ["https://0x7f000001/", "blocked_url"],
    ["https://169.254.169.254/latest/meta-data", "blocked_url"],
    ["https://metadata.google.internal/computeMetadata/v1/", "blocked_url"],
    ["https://METADATA.GOOGLE.INTERNAL./", "blocked_url"],
    ["https://metadata/", "blocked_url"],
    ["https://localhost/", "blocked_url"],
    ["https://api.localhost/", "blocked_url"],
    ["https://db.internal/", "blocked_url"],
    ["https://printer.local/", "blocked_url"],
    ["ftp://shop.example.com/", "invalid_url"],
    ["file:///etc/passwd", "invalid_url"],
    ["not a url", "invalid_url"],
  ])("%s → %s", (u, expected) => {
    expect(codeSync(() => checkUrl(u))).toBe(expected);
  });

  it("accepts a public https URL (explicit :443 is the default port) and drops the fragment", () => {
    expect(checkUrl("https://shop.example.com:443/a?b=1#frag").href).toBe("https://shop.example.com/a?b=1");
  });
});

describe("isBlockedAddress", () => {
  it.each([
    "10.0.0.1",
    "10.255.255.255",
    "127.0.0.1",
    "127.1.2.3",
    "169.254.169.254",
    "169.254.1.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "239.255.255.250",
    "240.0.0.1",
    "255.255.255.255",
    "192.0.2.1",
    "198.18.0.1",
    "::",
    "::1",
    "fd00::1",
    "fc00::1",
    "fe80::1",
    "fe80::1%eth0",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "::ffff:7f00:1",
    "::ffff:a9fe:a9fe",
    "::127.0.0.1",
    "64:ff9b::a00:1",
    "2002:a00:1::1",
    "2001::1",
    "2001:db8::1",
    "not-an-ip",
  ])("blocks %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(["93.184.215.14", "8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "2a00:1450:4009:81f::200e"])("allows public %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe("vetHost (DNS)", () => {
  const resolverOf =
    (addrs: string[]): Resolver =>
    async () =>
      addrs.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

  it.each([["10.1.2.3"], ["127.0.0.1"], ["169.254.169.254"], ["::1"], ["fd00::1"], ["::ffff:127.0.0.1"]])("refuses a host resolving to %s", async (ip) => {
    expect(await code(vetHost("shop.example.com", resolverOf([ip])))).toBe("blocked_url");
  });

  it("refuses when ANY address is private (mixed A/AAAA answers)", async () => {
    expect(await code(vetHost("shop.example.com", resolverOf([PUBLIC_IP, "10.0.0.7"])))).toBe("blocked_url");
    expect(await code(vetHost("shop.example.com", resolverOf(["2606:4700::1", "fe80::1"])))).toBe("blocked_url");
  });

  it("returns one vetted public address (IPv4 preferred)", async () => {
    expect(await vetHost("shop.example.com", resolverOf(["2606:4700::1", PUBLIC_IP]))).toEqual({ address: PUBLIC_IP, family: 4 });
  });

  it("maps resolution failures to dns_failed without leaking details", async () => {
    expect(await code(vetHost("nx.example.com", async () => [])).catch(() => "x")).toBe("dns_failed");
    expect(
      await code(
        vetHost("nx.example.com", async () => {
          throw new Error("ENOTFOUND 10.0.0.1");
        }),
      ),
    ).toBe("dns_failed");
  });
});

describe("SafeFetcher policy (fake network)", () => {
  const ROBOTS_OK = "User-agent: *\nAllow: /\n";

  it("refuses a hostname resolving to a private address before any request is sent", async () => {
    for (const ip of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "::1", "fd00::1", "::ffff:127.0.0.1"]) {
      const net = fakeNet({}, { "evil.test": [ip] });
      const f = new SafeFetcher(net.options);
      expect(await code(f.get("https://evil.test/products.json", "json"))).toBe("blocked_url");
      expect(net.calls).toHaveLength(0);
    }
  });

  it("refuses a public first hop that redirects to a private address (re-validated per hop)", async () => {
    const net = fakeNet(
      {
        "https://shop.test/robots.txt": ROBOTS_OK,
        "https://shop.test/go": { status: 302, headers: { location: "https://rebind.test/latest/meta-data" } },
      },
      { "rebind.test": ["169.254.169.254"] },
    );
    const f = new SafeFetcher(net.options);
    expect(await code(f.get("https://shop.test/go", "html"))).toBe("blocked_url");
    expect(net.calls.map((c) => c.address)).toEqual([PUBLIC_IP, PUBLIC_IP]);
    expect(net.calls.some((c) => c.url.hostname === "rebind.test")).toBe(false);
  });

  it.each([
    ["http://shop.test/x", "blocked_url"],
    ["https://shop.test:8080/x", "blocked_url"],
    ["https://u:p@shop.test/x", "blocked_url"],
    ["https://127.0.0.1/x", "blocked_url"],
    ["https://metadata.google.internal/x", "blocked_url"],
    ["gopher://shop.test/x", "invalid_url"],
  ])("refuses a redirect to %s", async (location, expected) => {
    const net = fakeNet({ "https://shop.test/robots.txt": ROBOTS_OK, "https://shop.test/go": { status: 301, headers: { location } } });
    expect(await code(new SafeFetcher(net.options).get("https://shop.test/go", "html"))).toBe(expected);
  });

  it(`follows at most ${MAX_REDIRECTS} redirects`, async () => {
    const routes: Record<string, { status: number; headers: Record<string, string> } | string> = { "https://shop.test/robots.txt": ROBOTS_OK, "https://shop.test/r3": "<html>end</html>" };
    for (let i = 0; i < 3; i++) routes[`https://shop.test/r${i}`] = { status: 302, headers: { location: `/r${i + 1}` } };
    const ok = fakeNet(routes);
    const res = await new SafeFetcher(ok.options).get("https://shop.test/r0", "html");
    expect(res.url).toBe("https://shop.test/r3");
    expect(res.body).toContain("end");

    routes["https://shop.test/r3"] = { status: 302, headers: { location: "/r4" } };
    routes["https://shop.test/r4"] = "<html>too far</html>";
    const tooMany = fakeNet(routes);
    expect(await code(new SafeFetcher(tooMany.options).get("https://shop.test/r0", "html"))).toBe("too_many_redirects");
    expect(tooMany.hrefs()).not.toContain("https://shop.test/r4");
  });

  it("honours robots.txt for GiftFitPreviewBot and for *", async () => {
    const net = fakeNet({
      "https://shop.test/robots.txt": "User-agent: GiftFitPreviewBot\nDisallow: /products.json\n\nUser-agent: *\nDisallow: /private\n",
      "https://shop.test/ok": "<html>fine</html>",
    });
    const f = new SafeFetcher(net.options);
    expect(await code(f.get("https://shop.test/products.json?limit=50", "json"))).toBe("robots_disallowed");
    expect(await f.isAllowed("https://shop.test/private/x")).toBe(true); // our group replaces *
    expect((await f.get("https://shop.test/ok", "html")).status).toBe(200);
    expect(net.hrefs()).toEqual(["https://shop.test/robots.txt", "https://shop.test/ok"]);

    const star = fakeNet({ "https://shop.test/robots.txt": "User-agent: *\nDisallow: /\n" });
    expect(await code(new SafeFetcher(star.options).get("https://shop.test/", "html"))).toBe("robots_disallowed");
    expect(star.hrefs()).toEqual(["https://shop.test/robots.txt"]);
  });

  it("robots.txt: 404 allows all, 5xx or a network error disallows all", async () => {
    const missing = fakeNet({ "https://shop.test/robots.txt": { status: 404 }, "https://shop.test/": "<html></html>" });
    expect((await new SafeFetcher(missing.options).get("https://shop.test/", "html")).status).toBe(200);
    const broken = fakeNet({ "https://shop.test/robots.txt": { status: 500 }, "https://shop.test/": "<html></html>" });
    expect(await code(new SafeFetcher(broken.options).get("https://shop.test/", "html"))).toBe("robots_disallowed");
    const down = fakeNet({ "https://shop.test/robots.txt": { status: -1 }, "https://shop.test/": "<html></html>" });
    expect(await code(new SafeFetcher(down.options).get("https://shop.test/", "html"))).toBe("robots_disallowed");
  });

  it(`never exceeds the per-preview fetch budget (≤ ${PREVIEW_FETCH_BUDGET}, robots and redirects included)`, async () => {
    const routes: Record<string, string> = { "https://shop.test/robots.txt": "" };
    for (let i = 0; i < 40; i++) routes[`https://shop.test/p/${i}`] = "<html></html>";
    const net = fakeNet(routes);
    const f = new SafeFetcher({ ...net.options, budget: 1000 });
    expect(f.budget).toBe(PREVIEW_FETCH_BUDGET);
    let ok = 0;
    let last = "ok";
    for (let i = 0; i < 40; i++) {
      last = await code(f.get(`https://shop.test/p/${i}`, "html"));
      if (last === "ok") ok++;
      else break;
    }
    expect(ok).toBe(PREVIEW_FETCH_BUDGET - 1);
    expect(last).toBe("budget_exceeded");
    expect(net.calls).toHaveLength(PREVIEW_FETCH_BUDGET);

    const small = fakeNet({ "https://shop.test/robots.txt": "", "https://shop.test/a": { status: 302, headers: { location: "/b" } }, "https://shop.test/b": "<html></html>" });
    const g = new SafeFetcher({ ...small.options, budget: 2 });
    expect(await code(g.get("https://shop.test/a", "html"))).toBe("budget_exceeded");
  });

  it("checks the content type for the expected kind", async () => {
    const net = fakeNet({ "https://shop.test/robots.txt": "", "https://shop.test/products.json": { type: "text/html", body: "<html>not json</html>" } });
    expect(await code(new SafeFetcher(net.options).get("https://shop.test/products.json", "json"))).toBe("bad_content_type");
  });

  it("passes the size cap of the kind to the transport", async () => {
    const net = fakeNet({ "https://shop.test/robots.txt": "", "https://shop.test/a.json": "{}" });
    await new SafeFetcher(net.options).get("https://shop.test/a.json", "json");
    expect(net.calls.map((c) => c.maxBytes)).toEqual([SIZE_CAPS.robots, SIZE_CAPS.json]);
    expect(SIZE_CAPS.html).toBe(2 * 1024 * 1024);
    expect(SIZE_CAPS.robots).toBe(256 * 1024);
  });

  it("stops a host after 403/429/503 and sends an honest User-Agent", async () => {
    const net = fakeNet({ "https://shop.test/robots.txt": "", "https://shop.test/a": { status: 429 }, "https://shop.test/b": "<html></html>" });
    const f = new SafeFetcher(net.options);
    expect((await f.get("https://shop.test/a", "html")).status).toBe(429);
    expect(await code(f.get("https://shop.test/b", "html"))).toBe("host_stopped");
    expect(net.calls[0].headers["user-agent"]).toBe(PREVIEW_USER_AGENT);
    expect(PREVIEW_USER_AGENT).toMatch(/^GiftFitPreviewBot\/1\.0 \(\+https:\/\/giftfit-469920173665\.us-central1\.run\.app\/merchants\)$/);
  });

  it("waits ≥ 1 s between requests to the same host and honours a short Crawl-delay", async () => {
    let t = 0;
    const waits: number[] = [];
    const net = fakeNet({ "https://shop.test/robots.txt": "User-agent: *\nCrawl-delay: 2\n", "https://shop.test/a": "<html></html>", "https://shop.test/b": "<html></html>" });
    const f = new SafeFetcher({
      ...net.options,
      now: () => t,
      sleep: async (ms) => {
        waits.push(ms);
        t += ms;
      },
    });
    await f.get("https://shop.test/a", "html");
    await f.get("https://shop.test/b", "html");
    expect(waits).toEqual([1000, 2000]);

    const slow = fakeNet({ "https://shop.test/robots.txt": "User-agent: *\nCrawl-delay: 60\n" });
    expect(await code(new SafeFetcher(slow.options).get("https://shop.test/a", "html"))).toBe("host_stopped");
  });

  it("re-resolves and re-vets every request: a rebinding answer on the next lookup is refused, never connected", async () => {
    let n = 0;
    const answers = [PUBLIC_IP, "10.66.0.1"];
    const resolver: Resolver = async () => [{ address: answers[Math.min(n++, 1)], family: 4 }];
    const net = fakeNet({ "https://shop.test/robots.txt": { status: 404 }, "https://shop.test/a": "<html></html>" });
    const f = new SafeFetcher({ ...net.options, resolver });
    expect(await code(f.get("https://shop.test/a", "html"))).toBe("blocked_url");
    expect(net.calls.map((c) => c.address)).toEqual([PUBLIC_IP]);
  });
});

// ---------------------------------------------------------------------------------------------------
// Real sockets: pinned transport against a local server
// ---------------------------------------------------------------------------------------------------

describe("pinnedRequest (local server)", () => {
  let server: http.Server;
  let port = 0;
  const seen: { host?: string; path?: string; closedEarly?: boolean }[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const entry: (typeof seen)[number] = { host: req.headers.host, path: req.url };
      seen.push(entry);
      res.on("close", () => {
        if (!res.writableFinished) entry.closedEarly = true;
      });
      if (req.url === "/big") {
        res.writeHead(200, { "content-type": "text/html" });
        const chunk = Buffer.alloc(64 * 1024, 97);
        let sent = 0;
        const pump = () => {
          while (sent < 8 * 1024 * 1024) {
            sent += chunk.length;
            if (!res.write(chunk)) return void res.once("drain", pump);
          }
          res.end();
        };
        pump();
      } else if (req.url === "/declared") {
        res.writeHead(200, { "content-type": "text/html", "content-length": String(3 * 1024 * 1024) });
        res.write("<html>");
      } else if (req.url === "/bomb") {
        const gz = zlib.gzipSync(Buffer.alloc(6 * 1024 * 1024, 0));
        res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip", "content-length": String(gz.length) });
        res.end(gz);
      } else if (req.url === "/gz") {
        const gz = zlib.gzipSync(Buffer.from('{"ok":true}'));
        res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
        res.end(gz);
      } else if (req.url === "/hang") {
        res.writeHead(200, { "content-type": "text/html" });
        res.write("<html>"); // never ends
      } else if (req.url === "/redirect") {
        res.writeHead(302, { location: "http://169.254.169.254/" });
        res.end();
      } else {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html>pinned ok</html>");
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  const req = (p: string, over: Partial<PinnedRequest> = {}): PinnedRequest => ({
    url: new URL(`http://rebind-check.invalid${p}`),
    address: "127.0.0.1",
    family: 4,
    headers: { "user-agent": PREVIEW_USER_AGENT },
    maxBytes: 2 * 1024 * 1024,
    connectTimeoutMs: 5_000,
    deadline: Date.now() + 10_000,
    ...over,
  });
  const local = () => ({ protocol: "http:" as const, port });

  it("connects to the vetted address without any DNS lookup, with Host = hostname", async () => {
    // `.invalid` never resolves: success proves the socket used the pinned address, not a fresh lookup.
    const res = await pinnedRequest(req("/hello"), local());
    expect(res.status).toBe(200);
    expect(res.body.toString()).toContain("pinned ok");
    expect(seen.at(-1)?.host).toBe("rebind-check.invalid");
  });

  it("DNS rebinding: first lookup public, second private — the connection stays on the vetted address", async () => {
    let lookups = 0;
    const resolver: Resolver = async () => [{ address: lookups++ === 0 ? "127.0.0.1" : "10.66.0.1", family: 4 }];
    // 127.0.0.1 stands in for "the public address" here (the only server a unit test can reach).
    const vetted = await vetHost("rebind-check.invalid", resolver, (ip) => ip.startsWith("10."));
    expect(vetted.address).toBe("127.0.0.1");
    const res = await pinnedRequest(req("/after-rebind", { address: vetted.address }), local());
    expect(res.status).toBe(200);
    expect(lookups).toBe(1); // nobody resolved again between vetting and connecting
    expect(seen.at(-1)?.path).toBe("/after-rebind");
  });

  it("cuts an oversize streamed body off at the cap", async () => {
    const t0 = Date.now();
    expect(await code(pinnedRequest(req("/big"), local()))).toBe("too_large");
    expect(Date.now() - t0).toBeLessThan(5_000);
    await new Promise((r) => setTimeout(r, 100));
    expect(seen.find((s) => s.path === "/big")?.closedEarly).toBe(true);
  });

  it("refuses a declared Content-Length above the cap before reading", async () => {
    expect(await code(pinnedRequest(req("/declared"), local()))).toBe("too_large");
  });

  it("A16 image heads (truncate): keeps exactly the first maxBytes of a server that ignores Range, then hangs up", async () => {
    const res = await pinnedRequest(req("/big", { maxBytes: 32 * 1024, truncate: true }), local());
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(32 * 1024);
    await new Promise((r) => setTimeout(r, 100));
    expect(seen.filter((s) => s.path === "/big").at(-1)?.closedEarly).toBe(true);
  });

  it("caps the DECOMPRESSED size (gzip bomb) and decodes normal gzip", async () => {
    expect(await code(pinnedRequest(req("/bomb"), local()))).toBe("too_large");
    const ok = await pinnedRequest(req("/gz"), local());
    expect(ok.body.toString()).toBe('{"ok":true}');
  });

  it("times out at the total deadline", async () => {
    const t0 = Date.now();
    expect(await code(pinnedRequest(req("/hang", { deadline: Date.now() + 300 }), local()))).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(3_000);
  });

  it("returns redirects without following them (the fetcher re-validates the target)", async () => {
    const res = await pinnedRequest(req("/redirect"), local());
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("http://169.254.169.254/");
  });

  it("SafeFetcher end to end over a real socket: robots, then the page, every hop pinned", async () => {
    const calls: string[] = [];
    const f = new SafeFetcher({
      resolver: async () => [{ address: "127.0.0.1", family: 4 }],
      isBlocked: () => false, // unit-test stand-in for a public address
      sleep: async () => {},
      transport: (r) => {
        calls.push(`${r.address} ${r.url.pathname}`);
        return pinnedRequest(r, local());
      },
    });
    const res = await f.get("https://pinned-e2e.example.com/hello", "html");
    expect(res.status).toBe(200);
    expect(calls).toEqual(["127.0.0.1 /robots.txt", "127.0.0.1 /hello"]);
  });
});

// TLS: SNI and certificate verification use the hostname while the socket goes to the pinned IP.
const opensslBin = [process.env.OPENSSL_BIN, "openssl", "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe", "C:\\Program Files\\Git\\usr\\bin\\openssl.exe"].find((b) => {
  if (!b) return false;
  try {
    execFileSync(b, ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
});

describe.skipIf(!opensslBin)("pinnedRequest over TLS (self-signed test certificate)", () => {
  let server: https.Server;
  let port = 0;
  let cert = "";
  let dir = "";
  let lastSni: string | undefined;
  let lastHost: string | undefined;

  beforeAll(async () => {
    const base = path.join(process.cwd(), ".giftfit", "tmp");
    mkdirSync(base, { recursive: true });
    dir = mkdtempSync(path.join(base, "tls-"));
    const key = path.join(dir, "key.pem");
    const crt = path.join(dir, "cert.pem");
    execFileSync(opensslBin!, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", crt, "-days", "2", "-subj", "/CN=pinned-tls.test", "-addext", "subjectAltName=DNS:pinned-tls.test"], { stdio: "ignore" });
    if (!existsSync(crt)) throw new Error("openssl did not write a certificate");
    cert = readFileSync(crt, "utf8");
    server = https.createServer({ key: readFileSync(key), cert }, (req, res) => {
      lastSni = (req.socket as unknown as { servername?: string }).servername;
      lastHost = req.headers.host;
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>tls ok</html>");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    server?.closeAllConnections();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const tlsReq = (host: string): PinnedRequest => ({
    url: new URL(`https://${host}/`),
    address: "127.0.0.1",
    family: 4,
    headers: {},
    maxBytes: 1024 * 1024,
    connectTimeoutMs: 5_000,
    deadline: Date.now() + 10_000,
  });

  it("sends SNI and Host = hostname and verifies the certificate against the hostname", async () => {
    const res = await pinnedRequest(tlsReq("pinned-tls.test"), { port, ca: cert });
    expect(res.body.toString()).toContain("tls ok");
    expect(lastSni).toBe("pinned-tls.test");
    expect(lastHost).toBe("pinned-tls.test");
  });

  it("refuses when the certificate does not match the hostname", async () => {
    expect(await code(pinnedRequest(tlsReq("other-host.test"), { port, ca: cert }))).toBe("network");
  });
});

import { describe, expect, it } from "vitest";
import {
  CACHE_TTL_MS,
  HostStoppedError,
  PageCapError,
  PoliteFetcher,
  RobotsDisallowedError,
  type FetchLike,
  userAgent,
} from "@/server/ingest/politeness";

type Route = { status: number; body?: string; headers?: Record<string, string>; url?: string };

function harness(routes: Record<string, Route | Route[]>, opts: { maxPages?: number } = {}) {
  let t = 0;
  const calls: { url: string; at: number; ua: string }[] = [];
  const hits = new Map<string, number>();
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, at: t, ua: init.headers["user-agent"] });
    const r = routes[url];
    const n = hits.get(url) ?? 0;
    hits.set(url, n + 1);
    const route = Array.isArray(r) ? r[Math.min(n, r.length - 1)] : r ?? { status: 404 };
    return { status: route.status, url: route.url ?? url, headers: new Headers(route.headers ?? {}), text: async () => route.body ?? "" };
  };
  const fetcher = new PoliteFetcher({
    fetch,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    maxPages: opts.maxPages,
    infoUrl: "https://example.test/bot",
  });
  return { fetcher, calls, advance: (ms: number) => (t += ms) };
}

const ROBOTS = "User-agent: *\nDisallow: /cart\n\nUser-agent: GiftFitIngest\nDisallow: /private/\nDisallow: /cart\n";
const ok = (body = "<html></html>"): Route => ({ status: 200, body });

describe("PoliteFetcher", () => {
  it("fetches robots.txt first and sends an identifying User-Agent", async () => {
    const { fetcher, calls } = harness({ "https://s.test/robots.txt": ok(ROBOTS), "https://s.test/a": ok() });
    await fetcher.get("https://s.test/a");
    expect(calls.map((c) => c.url)).toEqual(["https://s.test/robots.txt", "https://s.test/a"]);
    expect(calls[1].ua).toBe(userAgent("https://example.test/bot"));
    expect(calls[1].ua).toMatch(/^GiftFitIngest\/0\.1 \(.*\+https:\/\/example\.test\/bot\)$/);
  });

  it("honors Disallow rules, including the GiftFitIngest group, without requesting the page", async () => {
    const { fetcher, calls } = harness({ "https://s.test/robots.txt": ok(ROBOTS) });
    await expect(fetcher.get("https://s.test/cart")).rejects.toBeInstanceOf(RobotsDisallowedError);
    await expect(fetcher.get("https://s.test/private/x")).rejects.toBeInstanceOf(RobotsDisallowedError);
    expect(await fetcher.isAllowed("https://s.test/products/x")).toBe(true);
    expect(calls.map((c) => c.url)).toEqual(["https://s.test/robots.txt"]);
  });

  it("treats a missing robots.txt as allow-all and a 5xx robots.txt as disallow-all", async () => {
    const a = harness({ "https://a.test/robots.txt": { status: 404 }, "https://a.test/x": ok() });
    expect((await a.fetcher.get("https://a.test/x")).status).toBe(200);
    const b = harness({ "https://b.test/robots.txt": { status: 500 } });
    await expect(b.fetcher.get("https://b.test/x")).rejects.toBeInstanceOf(RobotsDisallowedError);
  });

  it("spaces requests to one host at least 1 s apart, serially, even when called concurrently", async () => {
    const { fetcher, calls } = harness({ "https://s.test/robots.txt": ok(ROBOTS), "https://s.test/1": ok(), "https://s.test/2": ok(), "https://s.test/3": ok() });
    await Promise.all(["1", "2", "3"].map((p) => fetcher.get(`https://s.test/${p}`)));
    const starts = calls.map((c) => c.at);
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(1_000);
  });

  it("honors a longer Crawl-delay", async () => {
    const { fetcher, calls } = harness({ "https://s.test/robots.txt": ok("User-agent: *\nCrawl-delay: 5\n"), "https://s.test/1": ok(), "https://s.test/2": ok() });
    await fetcher.get("https://s.test/1");
    await fetcher.get("https://s.test/2");
    expect(calls[2].at - calls[1].at).toBeGreaterThanOrEqual(5_000);
  });

  it("serves repeats from a 24 h cache, then refetches", async () => {
    const { fetcher, calls, advance } = harness({ "https://s.test/robots.txt": ok(ROBOTS), "https://s.test/a": ok("v1") });
    await fetcher.get("https://s.test/a");
    const again = await fetcher.get("https://s.test/a");
    expect(again.fromCache).toBe(true);
    expect(calls).toHaveLength(2);
    advance(CACHE_TTL_MS);
    expect((await fetcher.get("https://s.test/a")).fromCache).toBe(false);
    expect(calls.filter((c) => c.url.endsWith("/a"))).toHaveLength(2);
    expect(fetcher.stats().cacheHits).toBe(1);
  });

  it("stops a host at once on 403", async () => {
    const { fetcher, calls } = harness({ "https://s.test/robots.txt": ok(ROBOTS), "https://s.test/a": { status: 403 } });
    await expect(fetcher.get("https://s.test/a")).rejects.toBeInstanceOf(HostStoppedError);
    await expect(fetcher.get("https://s.test/b")).rejects.toBeInstanceOf(HostStoppedError);
    expect(calls).toHaveLength(2);
  });

  it("retries 429 after Retry-After, and stops after two failed retries on 503", async () => {
    const a = harness({ "https://s.test/robots.txt": ok(ROBOTS), "https://s.test/a": [{ status: 429, headers: { "retry-after": "3" } }, ok()] });
    const res = await a.fetcher.get("https://s.test/a");
    expect(res.status).toBe(200);
    expect(a.calls[2].at - a.calls[1].at).toBeGreaterThanOrEqual(3_000);
    const b = harness({ "https://s.test/robots.txt": ok(ROBOTS), "https://s.test/a": { status: 503 } });
    await expect(b.fetcher.get("https://s.test/a")).rejects.toBeInstanceOf(HostStoppedError);
    expect(b.calls.filter((c) => c.url.endsWith("/a"))).toHaveLength(3);
  });

  it("enforces the page cap per run", async () => {
    const { fetcher } = harness({ "https://s.test/robots.txt": ok(ROBOTS), "https://s.test/1": ok(), "https://s.test/2": ok() }, { maxPages: 1 });
    await fetcher.get("https://s.test/1");
    await expect(fetcher.get("https://s.test/2")).rejects.toBeInstanceOf(PageCapError);
  });

  it("refuses a redirect to another host", async () => {
    const { fetcher } = harness({ "https://s.test/robots.txt": ok(ROBOTS), "https://s.test/a": { status: 200, url: "https://evil.test/a", body: "x" } });
    const res = await fetcher.get("https://s.test/a");
    expect(res.status).toBe(599);
    expect(res.body).toBe("");
  });

  it("gives the renderer polite navigation slots via acquire()", async () => {
    const { fetcher, calls, advance } = harness({ "https://s.test/robots.txt": ok(ROBOTS) });
    const release = await fetcher.acquire("https://s.test/products/a");
    release();
    await expect(fetcher.acquire("https://s.test/cart")).rejects.toBeInstanceOf(RobotsDisallowedError);
    const t0 = calls[0].at;
    advance(0);
    const r2 = await fetcher.acquire("https://s.test/products/b");
    r2();
    expect(fetcher.stats().pages).toBe(2);
    expect(t0).toBe(0);
  });
});

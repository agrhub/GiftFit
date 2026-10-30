/**
 * POST /api/preview and GET /api/preview/<key> (A10, ADR-055): the 202 contract, status transitions,
 * SSRF refusals (no resolved IP echoed), durable caps (5/IP/day, 100/day, fail closed), the hashed owner
 * token, cold-start handling, the Firestore repo, and the giver guard on every response.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findGiverLeaks } from "@/server/privacy/giver-guard";
import { setRateLimitOverride } from "@/server/privacy/rate-limit";
import { PREVIEW_COLLECTION, FirestorePreviewRepo, MemoryPreviewRepo, PREVIEW_TTL_MS, DEFAULT_PREVIEW_SETTINGS, type PreviewRecord } from "@/server/preview/repo";
import { drainPreviewJobsForTests, setPreviewDepsForTests } from "@/server/preview/service";
import { hashOwnerToken, ownerTokenMatches } from "@/server/preview/tokens";
import type { StoreIngestResult } from "@/server/preview/types";
import { fakeNet, html, PUBLIC_IP, shopifyProducts } from "@/server/preview/__tests__/fake-site";
import { MemoryDailyCounterStore, dailyCounterKey, type DailyCounterStore } from "@/server/store/daily-counter";
import { FakeFirestore } from "@/server/store/__tests__/fake-firestore";
import type { Resolver } from "@/server/ingest/safe-fetch";
import { POST } from "../route";
import { GET } from "../[key]/route";

const T0 = Date.parse("2026-10-27T10:00:00Z");
// Freeze Date at T0: the memory repos also read the wall clock, and T0 + 24 h is already in the past.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());
let ip = 0;
const post = (body: unknown, from = `198.51.100.${(ip++ % 200) + 1}`) =>
  POST(new Request("http://app.test/api/preview", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": from }, body: typeof body === "string" ? body : JSON.stringify(body) }));
const status = (key: string) => GET(new Request(`http://app.test/api/preview/${key}`, { headers: { "x-forwarded-for": "198.51.100.250" } }), { params: Promise.resolve({ key }) });

const resolver: Resolver = async (host) => {
  const table: Record<string, string> = { "private.example.com": "10.0.0.5", "meta.example.com": "169.254.169.254", "v6.example.com": "fd00::1" };
  if (host === "nx.example.com") throw new Error("ENOTFOUND");
  const a = table[host] ?? PUBLIC_IP;
  return [{ address: a, family: a.includes(":") ? 6 : 4 }];
};

function ready(n = 4): StoreIngestResult {
  const products = shopifyProducts(n).map((p, i) => ({
    id: String(p.id),
    title: p.title,
    url: `https://shop.example.com/products/${p.handle}`,
    images: [`https://cdn.example.com/${i}.jpg`],
    price: 100 + i,
    currency: "USD",
    categoryText: "Rings",
    category: "ring" as const,
    metal: "silver" as const,
    style: null,
    tags: [],
    summary: null,
    available: true,
  }));
  return { outcome: "ready", domain: "shop.example.com", origin: "https://shop.example.com", storeName: "Example Shop", platform: "shopify", products, currency: "USD", fetches: 4, ms: 12 };
}

let repo: MemoryPreviewRepo;
let counters: MemoryDailyCounterStore;
let now = T0;

beforeEach(() => {
  repo = new MemoryPreviewRepo();
  counters = new MemoryDailyCounterStore();
  now = T0;
  setPreviewDepsForTests({ repo, counters, resolver, now: () => now, ingest: async () => ready(), env: { NODE_ENV: "test", PREVIEW_SNAPSHOT: "off" } });
});
afterEach(async () => {
  await drainPreviewJobsForTests();
  setPreviewDepsForTests(undefined);
  setRateLimitOverride(undefined);
});

async function json(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  const body = JSON.parse(text) as Record<string, unknown>;
  expect(findGiverLeaks(body), text).toEqual([]);
  expect(res.headers.get("cache-control")).toContain("no-store");
  return body;
}

describe("POST /api/preview", () => {
  it("202 with key, previewPath, statusPath and a one-time ownerPath; only the token hash is stored", async () => {
    const res = await post({ url: "https://shop.example.com/collections/all?ref=abc" });
    expect(res.status).toBe(202);
    const body = await json(res);
    expect(Object.keys(body).sort()).toEqual(["key", "ownerPath", "previewPath", "statusPath"]);
    const key = String(body.key);
    expect(key).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(body.previewPath).toBe(`/s/${key}`);
    expect(body.statusPath).toBe(`/api/preview/${key}`);
    const m = new RegExp(`^/admin/${key}#t=([A-Za-z0-9_-]{43})$`).exec(String(body.ownerPath));
    expect(m).not.toBeNull();
    const token = m![1];
    const rec = repo.records.get(key)!;
    expect(rec.ownerTokenHash).toBe(hashOwnerToken(token));
    expect(JSON.stringify(rec)).not.toContain(token);
    expect(ownerTokenMatches(rec.ownerTokenHash, token)).toBe(true);
    expect(ownerTokenMatches(rec.ownerTokenHash, `${token.slice(0, -1)}x`)).toBe(false);
    expect(rec.storeUrl).toBe("https://shop.example.com"); // origin only: no path or query string stored
    expect(rec.expiresAt.getTime() - rec.createdAt.getTime()).toBe(PREVIEW_TTL_MS);
    expect(rec.settings).toEqual({ version: 0 });
  });

  it("accepts a bare domain (https assumed)", async () => {
    expect((await post({ url: "shop.example.com" })).status).toBe(202);
  });

  it.each([[{}], [{ url: "" }], [{ url: 42 }], [{ url: "ftp://shop.example.com/" }], [{ url: "https://" }], ["not json"], [[1]], [{ url: `https://shop.example.com/${"a".repeat(3000)}` }], [{ url: "https://nx.example.com/" }]])(
    "400 invalid_url for %j",
    async (body) => {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(await json(res)).toEqual({ error: "invalid_url" });
    },
  );

  it.each([
    "http://shop.example.com/",
    "https://shop.example.com:8443/",
    "https://user:pw@shop.example.com/",
    "https://10.0.0.1/",
    "https://[::1]/",
    "https://metadata.google.internal/",
    "https://private.example.com/",
    "https://meta.example.com/",
    "https://v6.example.com/",
  ])("400 blocked_url for %s, never echoing a resolved address", async (url) => {
    const res = await post({ url });
    expect(res.status).toBe(400);
    const text = await res.clone().text();
    expect(await json(res)).toEqual({ error: "blocked_url" });
    for (const leak of ["10.0.0.5", "169.254", "fd00", PUBLIC_IP]) expect(text).not.toContain(leak);
    expect(repo.records.size).toBe(0);
  });

  it("caps 5 previews per IP per day (429 rate_limited) without touching other IPs", async () => {
    for (let i = 0; i < 5; i++) expect((await post({ url: "https://shop.example.com/" }, "203.0.113.9")).status).toBe(202);
    const sixth = await post({ url: "https://shop.example.com/" }, "203.0.113.9");
    expect(sixth.status).toBe(429);
    expect(Number(sixth.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await json(sixth)).toEqual({ error: "rate_limited" });
    expect((await post({ url: "https://shop.example.com/" }, "203.0.113.10")).status).toBe(202);
    // Only salted hashes in counter keys; the refused attempt did not consume the global budget.
    const keys = [...counters.counts.keys()];
    expect(keys.some((k) => k.includes("203.0.113"))).toBe(false);
    expect(counters.counts.get(dailyCounterKey("preview", T0))).toBe(6);
    expect(keys.filter((k) => k.startsWith("previewip-")).every((k) => /^previewip-[0-9a-f]{32}-2026-10-27$/.test(k))).toBe(true);
  });

  it("the next UTC day starts a new allowance", async () => {
    for (let i = 0; i < 5; i++) await post({ url: "https://shop.example.com/" }, "203.0.113.11");
    expect((await post({ url: "https://shop.example.com/" }, "203.0.113.11")).status).toBe(429);
    now = T0 + 24 * 3600_000;
    expect((await post({ url: "https://shop.example.com/" }, "203.0.113.11")).status).toBe(202);
  });

  it("caps 100 previews per day globally (429 daily_cap)", async () => {
    await counters.tryReserve(dailyCounterKey("preview", T0), 100, 100);
    const res = await post({ url: "https://shop.example.com/" });
    expect(res.status).toBe(429);
    expect(await json(res)).toEqual({ error: "daily_cap" });
    expect(repo.records.size).toBe(0);
  });

  it("fails closed when the counters are unavailable (503, nothing queued)", async () => {
    const broken: DailyCounterStore = { kind: "broken", get: async () => 0, tryReserve: async () => Promise.reject(new Error("firestore down")), refund: async () => 0 };
    setPreviewDepsForTests({ repo, counters: broken, resolver, now: () => now, ingest: async () => ready(), env: { NODE_ENV: "test" } });
    const res = await post({ url: "https://shop.example.com/" });
    expect(res.status).toBe(503);
    expect(await json(res)).toEqual({ error: "unavailable" });
    expect(repo.records.size).toBe(0);
  });

  it("10 attempts per hour per IP (valid or not) when rate limits are on", async () => {
    setRateLimitOverride(true);
    for (let i = 0; i < 10; i++) await post({ url: "http://shop.example.com/" }, "203.0.113.77");
    const res = await post({ url: "https://shop.example.com/" }, "203.0.113.77");
    expect(res.status).toBe(429);
    expect(await json(res)).toEqual({ error: "rate_limited" });
  });

  it("PREVIEW_ENABLED=off disables the endpoint", async () => {
    setPreviewDepsForTests({ repo, counters, resolver, now: () => now, ingest: async () => ready(), env: { NODE_ENV: "test", PREVIEW_ENABLED: "off" } });
    const res = await post({ url: "https://shop.example.com/" });
    expect(res.status).toBe(503);
    expect(await json(res)).toEqual({ error: "disabled" });
  });
});

describe("GET /api/preview/<key>", () => {
  it("goes queued → crawling → ready with name and product count", async () => {
    let finish!: (r: StoreIngestResult) => void;
    setPreviewDepsForTests({ repo, counters, resolver, now: () => now, ingest: () => new Promise((r) => (finish = r)), env: { NODE_ENV: "test" } });
    const { key } = (await json(await post({ url: "https://shop.example.com/" }))) as { key: string };
    const first = await json(await status(key));
    expect(["queued", "crawling"]).toContain(first.state);
    expect(first.domain).toBe("shop.example.com");
    await new Promise((r) => setTimeout(r, 0));
    expect((await json(await status(key))).state).toBe("crawling");
    finish(ready(7));
    await drainPreviewJobsForTests();
    expect(await json(await status(key))).toEqual({ state: "ready", domain: "shop.example.com", name: "Example Shop", productCount: 7, look: { mode: "template", reason: expect.any(String) } }); // A15: its fake network has no copyable home page
    expect(repo.records.get(key)!.products).toHaveLength(7);
  });

  it("reports refused with its reason and stores no products", async () => {
    setPreviewDepsForTests({
      repo,
      counters,
      resolver,
      now: () => now,
      ingest: async () => ({ ...ready(2), outcome: "refused", reason: "not_a_store", products: [], storeName: "Tiny Blog" }),
      env: { NODE_ENV: "test" },
    });
    const { key } = (await json(await post({ url: "https://shop.example.com/" }))) as { key: string };
    await drainPreviewJobsForTests();
    expect(await json(await status(key))).toEqual({ state: "refused", domain: "shop.example.com", name: "Tiny Blog", reason: "not_a_store" });
    expect(repo.records.get(key)!.products).toEqual([]);
  });

  it("a crash inside the crawl ends as failed/internal", async () => {
    setPreviewDepsForTests({ repo, counters, resolver, now: () => now, ingest: async () => Promise.reject(new Error("boom")), env: { NODE_ENV: "test" } });
    const { key } = (await json(await post({ url: "https://shop.example.com/" }))) as { key: string };
    await drainPreviewJobsForTests();
    expect(await json(await status(key))).toMatchObject({ state: "failed", reason: "internal" });
  });

  it("a crawl lost to a restart (another instance, or stale) is reported and stored as failed/interrupted", async () => {
    const base: PreviewRecord = {
      key: "BBBBBBBBBBBBBBBBBBBBBB",
      domain: "shop.example.com",
      storeUrl: "https://shop.example.com",
      state: "crawling",
      reason: null,
      storeName: null,
      platform: null,
      currency: null,
      products: [],
      productCount: 0,
      fetches: null,
      createdAt: new Date(T0),
      updatedAt: new Date(T0),
      expiresAt: new Date(T0 + PREVIEW_TTL_MS),
      ownerTokenHash: "0".repeat(64),
      runner: "an-instance-that-is-gone",
      settings: { ...DEFAULT_PREVIEW_SETTINGS },
    };
    await repo.create(base);
    expect(await json(await status(base.key))).toEqual({ state: "failed", domain: "shop.example.com", reason: "interrupted" });
    expect(repo.records.get(base.key)!.state).toBe("failed");
  });

  it("404 for unknown, malformed and expired keys", async () => {
    expect((await status("CCCCCCCCCCCCCCCCCCCCCC")).status).toBe(404);
    expect((await status("../../etc")).status).toBe(404);
    const { key } = (await json(await post({ url: "https://shop.example.com/" }))) as { key: string };
    await drainPreviewJobsForTests();
    now = T0 + PREVIEW_TTL_MS + 1;
    const res = await status(key);
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: "not_found" });
  });

  it("end to end with the real crawler on a fake network", async () => {
    const SHOP = "https://shop.example.com";
    const net = fakeNet({
      [`${SHOP}/robots.txt`]: "",
      [`${SHOP}/`]: html('<meta property="og:site_name" content="Fixture Shop">cdn.shopify.com'),
      [`${SHOP}/products.json?limit=50`]: JSON.stringify({ products: shopifyProducts(3) }),
    });
    setPreviewDepsForTests({ repo, counters, resolver, now: () => now, fetcherOptions: net.options, env: { NODE_ENV: "test" } });
    const { key } = (await json(await post({ url: SHOP }))) as { key: string };
    await drainPreviewJobsForTests();
    expect(await json(await status(key))).toEqual({ state: "ready", domain: "shop.example.com", name: "Fixture Shop", productCount: 3, look: { mode: "template", reason: "too_little_text" } }); // A15: the bare fixture home page can't be copied
  });
});

describe("FirestorePreviewRepo", () => {
  it(`stores one document per key in ${PREVIEW_COLLECTION} with expiresAt for the TTL policy`, async () => {
    const db = new FakeFirestore();
    const fs = new FirestorePreviewRepo(async () => db);
    const r = ready(3);
    const rec: PreviewRecord = {
      key: "DDDDDDDDDDDDDDDDDDDDDD",
      domain: r.domain,
      storeUrl: r.origin,
      state: "queued",
      reason: null,
      storeName: null,
      platform: null,
      currency: null,
      products: [],
      productCount: 0,
      fetches: null,
      createdAt: new Date(T0),
      updatedAt: new Date(T0),
      expiresAt: new Date(T0 + PREVIEW_TTL_MS),
      ownerTokenHash: hashOwnerToken("t".repeat(43)),
      runner: "i1",
      settings: { ...DEFAULT_PREVIEW_SETTINGS },
    };
    await fs.create(rec);
    await expect(fs.create(rec)).rejects.toThrow(/collision/);
    await fs.update(rec.key, { state: "ready", products: r.products, productCount: 3, storeName: "Example Shop", updatedAt: new Date(T0 + 5) });
    const got = await fs.get(rec.key, T0 + 10);
    expect(got).toMatchObject({ state: "ready", productCount: 3, storeName: "Example Shop", runner: "i1" });
    expect(got!.products[0].images).toEqual(["https://cdn.example.com/0.jpg"]);
    expect(got!.expiresAt.getTime()).toBe(T0 + PREVIEW_TTL_MS);
    const raw = db.docs(PREVIEW_COLLECTION);
    expect(raw.map((d) => d.id)).toEqual([rec.key]);
    expect(raw[0].data.expiresAt).toBeDefined();
    expect(JSON.stringify(raw[0].data)).not.toContain("t".repeat(43));
    expect(await fs.get(rec.key, T0 + PREVIEW_TTL_MS)).toBeNull();
    expect(await fs.get("bad/key")).toBeNull();
    await expect(fs.update("EEEEEEEEEEEEEEEEEEEEEE", { state: "failed" })).rejects.toThrow(/not found/);
  });
});

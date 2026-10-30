/** End-to-end ingest in INGEST_FIXTURE=1 mode: no network, no browser, no keys. */
import { describe, expect, it, vi } from "vitest";

// Full Tier 3 runs parse ~22 pages several times; give them room when the suite runs in parallel.
vi.setConfig({ testTimeout: 60_000 });
import { EMBEDDING_DIM } from "@/server/db/schema";
import { isHostAllowed, loadIngestConfig } from "@/server/ingest/config";
import { HashEmbedder } from "@/server/ingest/embed";
import { createIngestDeps } from "@/server/ingest/index";
import { runIngest } from "@/server/ingest/pipeline";
import { PoliteFetcher, type FetchLike } from "@/server/ingest/politeness";
import { InMemoryCatalogSink } from "@/server/ingest/store";
import type { IngestProgress } from "@/server/ingest/types";

const FIXTURE_ENV = { INGEST_FIXTURE: "1" };

describe("runIngest (fixture mode)", () => {
  it("Tier 3: renders the client-rendered Aurum fixture store, follows pagination, extracts 20 SKUs", async () => {
    const phases: IngestProgress["phase"][] = [];
    const deps = await createIngestDeps(FIXTURE_ENV, { onProgress: (p) => phases.push(p.phase) });
    const r = await runIngest({ url: "https://aurum-fixture.test/" }, deps);
    expect(r).toMatchObject({ status: "done", platform: "render", tier: 3, discovered: 20, extractor: "heuristic" });
    expect(r.detectionSignals.join(" ")).toMatch(/app-root/);
    expect(r.skus).toHaveLength(20);
    expect(r.coverage).toMatchObject({ total: 20, withAll3: 17, withPrice: 19, withImages: 20 });
    expect(r.errors).toEqual([]);
    const sink = deps.sink as InMemoryCatalogSink;
    const rows = sink.skusOf(r.storeId);
    expect(rows).toHaveLength(20);
    expect(rows.every((s) => s.embedding?.length === EMBEDDING_DIM)).toBe(true);
    expect(sink.stores.get(r.storeId)).toMatchObject({ ingestStatus: "done", skuCount: 20, ingestTier: 3, platform: "render" });
    expect(phases[0]).toBe("detect");
    expect(phases.at(-1)).toBe("done");
    expect(deps.fetcher.stats().stoppedHosts).toEqual([]);
  });

  it("Tier 3 with the recorded Claude extractor reports the fields it dropped", async () => {
    const deps = await createIngestDeps({ ...FIXTURE_ENV, INGEST_EXTRACTOR: "recorded" });
    const r = await runIngest({ url: "https://aurum-fixture.test/" }, deps);
    expect(r.extractor).toBe("claude:claude-sonnet-5-5");
    expect(r.skus).toHaveLength(20);
    expect(r.coverage.withAll3).toBe(17);
    expect(r.dropped.map((d) => d.url.split("/").pop()).sort()).toEqual(
      ["arden-long-chain", "celeste-cluster-studs", "halo-solitaire-ring", "orbit-watch", "solene-diamond-studs", "vela-emerald-pendant"],
    );
  });

  it("Tier 1: detects Shopify and ingests /products.json", async () => {
    const deps = await createIngestDeps(FIXTURE_ENV);
    const r = await runIngest({ url: "https://shopify-fixture.test/" }, deps);
    expect(r).toMatchObject({ status: "done", platform: "shopify", tier: 1, extractor: "shopify" });
    expect(r.skus.map((s) => s.externalId)).toEqual(["9001", "9002:yellow_gold", "9002:white_gold", "9002:platinum", "9003", "9004"]);
    expect(r.coverage.withAll3).toBe(5);
  });

  it("Tier 2: detects JSON-LD via the sitemap and ingests the product pages", async () => {
    const deps = await createIngestDeps(FIXTURE_ENV);
    const r = await runIngest({ url: "https://jsonld-fixture.test/" }, deps);
    expect(r).toMatchObject({ status: "done", platform: "jsonld", tier: 2 });
    expect(r.skus.map((s) => s.title)).toEqual(["Lyra Hoops", "Cora Locket Pendant", "Rhea Platinum Bangle"]);
    expect(r.coverage.ratio).toBe(1);
  });

  it("caps products per run", async () => {
    const deps = await createIngestDeps(FIXTURE_ENV);
    const r = await runIngest({ url: "https://aurum-fixture.test/", maxProducts: 5 }, deps);
    expect(r.skus).toHaveLength(5);
  });

  it("stops with status error when the host answers 403, keeping the store row consistent", async () => {
    const fetch: FetchLike = async (url) => ({
      status: url.endsWith("/robots.txt") ? 404 : 403,
      url,
      headers: new Headers(),
      text: async () => "",
    });
    const sink = new InMemoryCatalogSink();
    const r = await runIngest(
      { url: "https://blocked.test/" },
      { fetcher: new PoliteFetcher({ fetch, sleep: async () => {} }), extractor: { name: "x", extract: async () => { throw new Error("unused"); } }, embedder: new HashEmbedder(), sink },
    );
    expect(r.status).toBe("error");
    expect(r.fatal).toMatch(/403/);
    expect(sink.stores.get(r.storeId)).toMatchObject({ ingestStatus: "error", skuCount: 0 });
  });
});

describe("host allow-list (SSRF and third-party guard)", () => {
  it("allows fixture hosts only in fixture mode, and nothing else there", () => {
    const fx = loadIngestConfig(FIXTURE_ENV);
    expect(isHostAllowed("https://aurum-fixture.test/", fx).ok).toBe(true);
    expect(isHostAllowed("https://www.example.com/", fx).ok).toBe(false);
    expect(isHostAllowed("https://aurum-fixture.test/", loadIngestConfig({})).ok).toBe(false);
  });
  it("requires INGEST_ALLOWED_HOSTS for live hosts and rejects IPs, credentials and non-http schemes", () => {
    const live = loadIngestConfig({ INGEST_ALLOWED_HOSTS: "aurum.example.app" });
    expect(isHostAllowed("https://aurum.example.app/shop", live).ok).toBe(true);
    expect(isHostAllowed("https://other-store.example/", live).ok).toBe(false);
    expect(isHostAllowed("http://169.254.169.254/latest", live).ok).toBe(false);
    expect(isHostAllowed("https://user:pw@aurum.example.app/", live).ok).toBe(false);
    expect(isHostAllowed("file:///etc/passwd", live).ok).toBe(false);
    expect(isHostAllowed("http://localhost:3000/", live).ok).toBe(true);
    expect(isHostAllowed("http://localhost:3000/", loadIngestConfig({ NODE_ENV: "production" })).ok).toBe(false);
  });
});

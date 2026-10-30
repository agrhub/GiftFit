/**
 * app/api/retailer/* (owner: A6): lookup (public, CORS), purchase (giver token → shortlist only),
 * metrics (aggregates). Every body passes the giver-leak scanner and none carries ids of requests,
 * tokens or recipient data.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_STORE } from "@/server/metrics/catalog";
import { MemoryPurchaseLog, setPurchaseLog } from "@/server/metrics/purchases";
import type { PrivacyDeps } from "@/server/privacy/deps";
import { findGiverLeaks } from "@/server/privacy/giver-guard";
import { MemoryPrivacyRepos } from "@/server/privacy/repos/memory";
import { ROUTE_MANIFEST } from "@/server/privacy/route-manifest";
import { setPrivacyDeps } from "@/server/privacy/runtime";
import { newFitRequestTokens } from "@/server/privacy/tokens";
import { GET as lookupGET, OPTIONS as lookupOPTIONS } from "../lookup/route";
import { GET as metricsGET } from "../metrics/route";
import { POST as purchasePOST } from "../purchase/route";

let repos: MemoryPrivacyRepos;
let log: MemoryPurchaseLog;
const [A, B, C] = DEFAULT_STORE.skus.map((s) => s.id);

beforeEach(() => {
  repos = new MemoryPrivacyRepos();
  log = new MemoryPurchaseLog();
  setPrivacyDeps({ repos } as unknown as PrivacyDeps);
  setPurchaseLog(log);
});
afterEach(() => {
  setPrivacyDeps(undefined);
  setPurchaseLog(undefined);
});

const get = (path: string) => new Request(`http://app.test${path}`);
const post = (body: unknown) => new Request("http://app.test/api/retailer/purchase", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function seed() {
  const t = newFitRequestTokens();
  const req = await repos.fitRequests.create({
    storeId: DEFAULT_STORE.id,
    giverTokenHash: t.giverTokenHash,
    recipientTokenHash: t.recipientTokenHash,
    occasion: "anniversary",
    budgetMin: 150,
    budgetMax: 300,
    currency: "USD",
    shortlistIds: [A, B],
    decoyIds: [C],
  });
  return { req, ...t };
}

describe("manifest", () => {
  it("registers every retailer route with audience retailer", () => {
    for (const r of ["lookup", "purchase", "metrics"]) expect(ROUTE_MANIFEST[`app/api/retailer/${r}/route.ts`]).toMatchObject({ audience: "retailer", owner: "A6" });
  });
});

describe("GET /api/retailer/lookup", () => {
  it("finds an Aurum product by SKU with CORS and an embed path", async () => {
    const res = lookupGET(get("/api/retailer/lookup?store=aurum&sku=AUR-EAR-028"));
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = await res.json();
    expect(body).toMatchObject({ found: true, product: { sku: "AUR-EAR-028", title: "Halo Drop Earrings", slug: "halo-drop-earrings" } });
    expect(body.embedPath).toBe("/embed?store=aurum&sku=halo-drop-earrings");
    expect(findGiverLeaks(body)).toEqual([]);
  });

  it("finds by URL or name, and says why when it cannot", async () => {
    expect((await lookupGET(get("/api/retailer/lookup?store=aurum&url=https%3A%2F%2Fother.example%2Fp%2Fhalo-drop-earrings")).json()).found).toBe(true);
    expect((await lookupGET(get("/api/retailer/lookup?store=aurum&name=Halo%20Drop%20Earrings")).json()).found).toBe(true);
    expect(await lookupGET(get("/api/retailer/lookup?store=nope&sku=AUR-EAR-028")).json()).toEqual({ found: false, reason: "unknown_store" });
    expect(await lookupGET(get("/api/retailer/lookup?store=aurum")).json()).toEqual({ found: false, reason: "missing_hints" });
    expect(await lookupGET(get("/api/retailer/lookup?store=aurum&sku=ZZZ")).json()).toEqual({ found: false, reason: "not_in_catalog" });
  });

  it("answers the CORS preflight", () => {
    const res = lookupOPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
  });
});

describe("POST /api/retailer/purchase", () => {
  it("records only shortlisted pieces of the giver's request", async () => {
    const { req, giverToken } = await seed();
    const res = await purchasePOST(post({ giverToken, skuIds: [A, C, "unknown"] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recorded: 1 });
    expect(log.forRequest(req.id).map((e) => e.skuId)).toEqual([A]);
    // Idempotent.
    expect(await (await purchasePOST(post({ giverToken, skuIds: [A] }))).json()).toEqual({ recorded: 0 });
  });

  it("answers the same way for unknown, malformed and recipient tokens", async () => {
    const { recipientToken } = await seed();
    for (const giverToken of ["x", "A".repeat(43), recipientToken]) {
      expect(await (await purchasePOST(post({ giverToken, skuIds: [A] }))).json()).toEqual({ recorded: 0 });
    }
    expect(log.all()).toEqual([]);
  });

  it("rejects bad bodies", async () => {
    expect((await purchasePOST(post({ giverToken: "x" }))).status).toBe(400);
    expect((await purchasePOST(post({ giverToken: "x", skuIds: [], extra: 1 }))).status).toBe(400);
    expect((await purchasePOST(new Request("http://app.test/api/retailer/purchase", { method: "POST", body: "{" }))).status).toBe(400);
  });
});

describe("GET /api/retailer/metrics", () => {
  it("returns the labelled snapshot with a purchased real request", async () => {
    const { req, giverToken } = await seed();
    await repos.fitRequests.setStatus(req.id, "completed");
    await repos.hearts.set(req.id, [A]);
    await repos.reports.upsert({ fitRequestId: req.id, items: { fingerprint: "f", items: [{ skuId: A, score: 94 }] } });
    await purchasePOST(post({ giverToken, skuIds: [A] }));

    const res = await metricsGET(get("/api/retailer/metrics?data=real"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.sources).toEqual({ real: 1, synthetic: 0 });
    expect(body.real.funnel.stages.map((s: { count: number }) => s.count)).toEqual([1, 1, 1, 1]);
    expect(body.real.heartedToBought.requestRate.value).toBe(1);
    expect(body.real.boughtScores).toEqual([94]);
    const text = JSON.stringify(body);
    expect(text).not.toContain(req.id);
    expect(text).not.toContain(giverToken);
    expect(findGiverLeaks(body)).toEqual([]);

    const all = await (await metricsGET(get("/api/retailer/metrics"))).json();
    expect(all.includesSynthetic).toBe(true);
    expect(all.syntheticLabel).toBe("Synthetic demo data");
  });
});

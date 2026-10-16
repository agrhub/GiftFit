/**
 * app/api/fit/* are giver-facing. These tests call the real route modules over the single store
 * (lib/privacy MemoryPrivacyRepos, ADR-021) and check the P3 flow end to end:
 * create → report(waiting) → recipient data written through PrivacyRepos → report(completed),
 * and that responses carry only the contract types: no tokens beyond the giver's own, no decoy
 * ids, no hex, CIELAB or photo URLs.
 */
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CreateFitRequestResponse, GiverReportStatus } from "@/lib/contracts/api";
import type { CatalogSku } from "@/lib/contracts/giftfit";
import { GIVER_FIT_ROUTES, type DecoysResponse } from "@/lib/fit/api";
import { configureFit, getFitDeps, resetFitDeps } from "@/lib/fit/deps";
import type { ExplainClient } from "@/lib/fit/explain";
import { PrivacyFitRepository, StaticCatalog } from "@/lib/fit/repository";
import { fakeRules, makeCatalog, sku } from "@/lib/fit/__tests__/fixtures";
import type { PrivacyDeps } from "@/lib/privacy/deps";
import { findGiverLeaks } from "@/lib/privacy/giver-guard";
import { MemoryPrivacyRepos } from "@/lib/privacy/repos/memory";
import { ROUTE_MANIFEST } from "@/lib/privacy/route-manifest";
import { setPrivacyDeps } from "@/lib/privacy/runtime";
import { hashToken } from "@/lib/privacy/tokens";
import { POST as decoysPOST } from "../decoys/route";
import { POST as reportPOST } from "../report/route";
import { POST as requestsPOST } from "../requests/route";
import { GET as weightsGET } from "../weights/route";

const T0 = new Date("2026-10-20T12:00:00Z");
let now = T0;
let repos: MemoryPrivacyRepos;

const CATALOG: CatalogSku[] = [
  sku("fix-001", { title: "Halo Drop Earrings", price: 240 }),
  sku("fix-002", { title: "Luna Hoop Earrings", price: 180, attributes: { earring_shape: "hoop_round_large", metal: "white_gold", metal_tone: "cool" } }),
  sku("fix-003", { title: "Iris Pendant Necklace", category: "necklace", price: 220, attributes: { category: "necklace" } }),
  sku("other-1", { title: "Other Store Ring", category: "ring", attributes: { category: "ring", earring_shape: undefined } }),
  ...makeCatalog(200, "route"),
].map((s) => (s.id === "other-1" ? { ...s, storeId: "elsewhere" } : s));
const SHORTLIST = ["fix-001", "fix-002", "fix-003"];

function setup(over: { rules?: boolean; explainer?: ExplainClient | null } = {}) {
  repos = new MemoryPrivacyRepos(() => now);
  configureFit({
    repository: new PrivacyFitRepository(async () => repos, new StaticCatalog(CATALOG)),
    rules: over.rules === false ? null : fakeRules,
    explainer: over.explainer ?? null,
    decoySecret: "test-secret",
    now: () => now,
  });
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/fit/x", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

const validBody = (over: Record<string, unknown> = {}) => ({ occasion: "anniversary", budgetMin: 150, budgetMax: 300, currency: "USD", shortlistIds: SHORTLIST, ...over });

async function create(over: Record<string, unknown> = {}) {
  const res = await requestsPOST(post(validBody(over)));
  const text = await res.text();
  return { res, text, body: JSON.parse(text) as CreateFitRequestResponse };
}

async function report(giverToken: string) {
  const res = await reportPOST(post({ giverToken }));
  const text = await res.text();
  return { res, text, body: JSON.parse(text) as GiverReportStatus };
}

/** Simulates A5's recipient routes: profile estimates and hearts written through PrivacyRepos. */
async function simulateRecipient(fitRequestId: string, heartIds: string[], override: "warm" | "cool" | null = null) {
  await repos.profiles.upsert({
    fitRequestId,
    undertoneEstimate: "warm",
    undertoneConfidence: 0.8317,
    undertoneOverride: override,
    faceShape: "Oval",
    hasHandCapture: false,
    consentAt: now,
    expiresAt: new Date(now.getTime() + 72 * 3600_000),
  });
  for (const id of heartIds) await repos.hearts.add(fitRequestId, id);
  await repos.fitRequests.setStatus(fitRequestId, "completed");
}

/** Recipient data or secrets that must never appear in a giver report. */
const LEAK_PATTERNS = [/#[0-9a-f]{6}\b/i, /https?:\/\//i, /\.(png|jpe?g|webp)\b/i, /0\.83/, /hueDeg|"lab"|skin_color|selfie|photo|faceAspectRatio/i];

beforeEach(() => {
  now = T0;
  resetFitDeps();
});
afterEach(() => {
  resetFitDeps();
  setPrivacyDeps(undefined);
});

describe("GET /api/fit/weights", () => {
  it("publishes the weights and formulas", async () => {
    const res = weightsGET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version).toBe("fit-v1.1");
    expect(body.weights).toEqual({ hearts: 60, metal: 10, style: 15, budgetOccasion: 15 });
    expect(body.returnRisk.label).toMatch(/estimate/i);
  });
});

describe("POST /api/fit/requests", () => {
  it.each([
    ["missing body", undefined],
    ["bad occasion", validBody({ occasion: "funeral" })],
    ["no shortlist", validBody({ shortlistIds: [] })],
    ["5 items", validBody({ shortlistIds: ["a", "b", "c", "d", "e"] })],
    ["duplicate ids", validBody({ shortlistIds: ["fix-001", "fix-001"] })],
    ["budgetMax < budgetMin", validBody({ budgetMin: 300, budgetMax: 100 })],
    ["zero budget", validBody({ budgetMin: 0, budgetMax: 0 })],
    ["negative budget", validBody({ budgetMin: -1 })],
    ["bad currency", validBody({ currency: "usd" })],
    ["string budget", validBody({ budgetMax: "300" })],
  ])("400 for %s", async (_name, body) => {
    setup();
    const res = await requestsPOST(post(body));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad_request");
    expect(repos.requests.size).toBe(0);
  });

  it("404 for an unknown SKU and 400 for a shortlist spanning stores", async () => {
    setup();
    expect((await requestsPOST(post(validBody({ shortlistIds: ["fix-001", "nope"] })))).status).toBe(404);
    expect((await requestsPOST(post(validBody({ shortlistIds: ["fix-001", "other-1"] })))).status).toBe(400);
    expect((await requestsPOST(post(validBody({ storeId: "elsewhere" })))).status).toBe(400);
    expect(repos.requests.size).toBe(0);
  });

  it("creates the request: contract fields only, hashes stored, decoys server-side and never returned", async () => {
    setup();
    const { res, text, body } = await create();
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    expect(Object.keys(body).sort()).toEqual(["carouselSize", "expiresAt", "fitRequestId", "giverReportPath", "giverToken", "recipientPath"]);
    expect(body.carouselSize).toBe(6);
    expect(body.expiresAt).toBe(new Date(T0.getTime() + 72 * 3600_000).toISOString());
    expect(body.giverToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.giverReportPath).toBe(`/g/${body.giverToken}`);
    const recipientToken = body.recipientPath.replace(/^\/r\//, "");
    expect(recipientToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(recipientToken).not.toBe(body.giverToken);

    // Single store: exactly one row, in lib/privacy, with hashes only.
    expect(repos.requests.size).toBe(1);
    const row = repos.requests.get(body.fitRequestId)!;
    expect(row.giverTokenHash).toBe(hashToken(body.giverToken));
    expect(row.recipientTokenHash).toBe(hashToken(recipientToken));
    expect(JSON.stringify(row)).not.toContain(body.giverToken);
    expect(JSON.stringify(row)).not.toContain(recipientToken);
    expect(row).toMatchObject({ status: "created", occasion: "anniversary", budgetMin: 150, budgetMax: 300, currency: "USD", shortlistIds: SHORTLIST });
    expect(row.decoyIds).toHaveLength(3);
    expect(row.decoyIds.some((id) => SHORTLIST.includes(id))).toBe(false);
    // Decoy ids are absent from the response.
    for (const id of row.decoyIds) expect(text).not.toContain(id);
    expect(findGiverLeaks(body)).toEqual([]);
  });

  it("gives every request its own tokens and decoy seed", async () => {
    setup();
    const a = await create();
    const b = await create();
    expect(a.body.giverToken).not.toBe(b.body.giverToken);
    expect(a.body.fitRequestId).not.toBe(b.body.fitRequestId);
    expect(repos.requests.size).toBe(2);
  });

  it("refuses to create a request it cannot hide among 2 decoys (422)", async () => {
    repos = new MemoryPrivacyRepos(() => now);
    configureFit({
      repository: new PrivacyFitRepository(async () => repos, new StaticCatalog(CATALOG.slice(0, 2))),
      rules: fakeRules,
      explainer: null,
      decoySecret: "s",
      now: () => now,
    });
    const res = await requestsPOST(post(validBody({ shortlistIds: ["fix-001"] })));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "insufficient_catalog" });
    expect(repos.requests.size).toBe(0);
  });
});

describe("POST /api/fit/report", () => {
  it("rejects a missing or short token (400) and unknown tokens (404)", async () => {
    setup();
    expect((await reportPOST(post({}))).status).toBe(400);
    expect((await reportPOST(post({ giverToken: "short" }))).status).toBe(400);
    expect((await reportPOST(post({ giverToken: "x".repeat(43) }))).status).toBe(404);
  });

  it("create → waiting → in_progress → completed (recipient data written through PrivacyRepos)", async () => {
    setup();
    const created = await create();
    const recipientToken = created.body.recipientPath.slice(3);
    const row = repos.requests.get(created.body.fitRequestId)!;
    const expiresAt = created.body.expiresAt;

    const waiting = await report(created.body.giverToken);
    expect(waiting.res.status).toBe(200);
    expect(waiting.body).toEqual({ status: "waiting", expiresAt });

    await repos.fitRequests.setStatus(row.id, "opened");
    expect((await report(created.body.giverToken)).body).toEqual({ status: "in_progress", expiresAt });
    await repos.fitRequests.setStatus(row.id, "tried_on");
    expect((await report(created.body.giverToken)).body.status).toBe("in_progress");

    // She hearts one shortlisted piece and one decoy.
    await simulateRecipient(row.id, ["fix-001", row.decoyIds[0]]);
    const done = await report(created.body.giverToken);
    expect(done.res.status).toBe(200);
    const body = done.body;
    expect(body.status).toBe("completed");
    expect(Object.keys(body).every((k) => ["status", "expiresAt", "results", "recipientLabels", "heartedShortlistIds"].includes(k))).toBe(true);
    expect(body.heartedShortlistIds).toEqual(["fix-001"]);
    expect(body.results!.map((r) => r.skuId).sort()).toEqual([...SHORTLIST].sort());
    expect(body.results![0].skuId).toBe("fix-001"); // hearted, best first
    expect(body.results![0].score).toBe(99); // 60 + 10 × (0.5 + 0.8317 × 0.5) + 15 + 15 = 99.2
    for (const r of body.results!) {
      expect(Object.keys(r).sort()).toEqual(["breakdown", "caution", "metal", "price", "reasons", "score", "skuId", "variantId"]);
      expect(r.reasons).toHaveLength(2);
    }
    if (body.recipientLabels) {
      for (const v of Object.values(body.recipientLabels)) expect(v).toMatch(/^[A-Z][a-z-]+ (undertone|face shape)[a-z ()]*$/);
    }
    expect(done.text).toMatch(/Warm undertone estimate suits yellow gold/);

    // No tokens (not even the giver's own), no decoy ids, no recipient data.
    expect(done.text).not.toContain(created.body.giverToken);
    expect(done.text).not.toContain(recipientToken);
    expect(done.text).not.toContain(row.recipientTokenHash);
    expect(done.text).not.toContain(row.giverTokenHash);
    for (const id of row.decoyIds) expect(done.text).not.toContain(id);
    for (const re of LEAK_PATTERNS) expect(done.text).not.toMatch(re);
    expect(findGiverLeaks(body)).toEqual([]);
  });

  it("caches the report in fit_reports and recomputes when her data changes", async () => {
    setup();
    const created = await create();
    const id = created.body.fitRequestId;
    await simulateRecipient(id, ["fix-003"]);
    const first = await report(created.body.giverToken);
    expect(repos.reportRows.get(id)).toBeTruthy();
    expect((await report(created.body.giverToken)).body).toEqual(first.body);
    await repos.profiles.setOverride(id, "cool");
    const after = await report(created.body.giverToken);
    expect(after.body.results).not.toEqual(first.body.results);
    expect(after.text).not.toContain("0.83");
  });

  it("reads as expired after 72 h, and when deleted or expired by status", async () => {
    setup();
    const created = await create();
    await simulateRecipient(created.body.fitRequestId, ["fix-001"]);
    now = new Date(T0.getTime() + 72 * 3600_000 + 1);
    expect((await report(created.body.giverToken)).body).toEqual({ status: "expired", expiresAt: created.body.expiresAt });
    now = T0;
    await repos.fitRequests.setStatus(created.body.fitRequestId, "deleted");
    expect((await report(created.body.giverToken)).body.status).toBe("expired");
    await repos.fitRequests.setStatus(created.body.fitRequestId, "expired");
    expect((await report(created.body.giverToken)).body).toEqual({ status: "expired", expiresAt: created.body.expiresAt });
  });

  it("answers 503 for a completed request until the jewelry rules are wired", async () => {
    setup({ rules: false });
    const created = await create();
    await simulateRecipient(created.body.fitRequestId, []);
    const res = await reportPOST(post({ giverToken: created.body.giverToken }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "fit_rules_not_configured" });
  });

  it("strips an LLM explanation that tries to leak recipient data", async () => {
    const leaky: ExplainClient = {
      model: "claude-sonnet-5-5",
      explain: async (req) => ({
        items: req.items.map((i) => ({ skuId: i.skuId, reason1: "Her selfie skin #C68642 is warm.", reason2: "Confidence 0.8317 for warm.", caution: "See https://x.test/a.png" })),
      }),
    };
    setup({ explainer: leaky });
    const created = await create();
    await simulateRecipient(created.body.fitRequestId, ["fix-002"]);
    const done = await report(created.body.giverToken);
    expect(done.res.status).toBe(200);
    for (const re of LEAK_PATTERNS) expect(done.text).not.toMatch(re);
  });
});

describe("POST /api/fit/decoys (preview)", () => {
  it("validates input and returns ≥ 2 decoys outside the shortlist", async () => {
    setup();
    expect((await decoysPOST(post({}))).status).toBe(400);
    expect((await decoysPOST(post({ shortlistIds: ["nope"] }))).status).toBe(404);
    const res = await decoysPOST(post({ shortlistIds: SHORTLIST }));
    const body = (await res.json()) as DecoysResponse;
    expect(Object.keys(body).sort()).toEqual(["carouselSize", "decoyIds", "ok", "reasons"]);
    expect(body.decoyIds.length).toBeGreaterThanOrEqual(2);
    expect(body.decoyIds.some((id) => SHORTLIST.includes(id))).toBe(false);
  });
});

describe("wiring and inventory", () => {
  it("the default repository writes to lib/privacy's store (single system of record)", async () => {
    const shared = new MemoryPrivacyRepos(() => now);
    setPrivacyDeps({ repos: shared } as unknown as PrivacyDeps);
    expect(getFitDeps().repository).toBeInstanceOf(PrivacyFitRepository);
    const aurum = (await getFitDeps().repository.listCatalog()).filter((s) => s.attributes.vto_spec_ok).slice(0, 2);
    expect(aurum.length).toBe(2); // the Aurum catalog JSON is the default catalog source
    const res = await requestsPOST(post(validBody({ shortlistIds: aurum.map((s) => s.id) })));
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateFitRequestResponse;
    expect(shared.requests.has(body.fitRequestId)).toBe(true);
    expect((await reportPOST(post({ giverToken: body.giverToken }))).status).toBe(200);
  });

  it("GIVER_FIT_ROUTES lists every route file under app/api/fit, all registered as giver routes", () => {
    const root = path.join(process.cwd(), "app", "api", "fit");
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (name === "route.ts") found.push("/api/fit/" + path.relative(root, dir).split(path.sep).join("/"));
      }
    };
    walk(root);
    expect(found.sort()).toEqual(GIVER_FIT_ROUTES.map((r) => r.path).sort());
    for (const p of found) expect(ROUTE_MANIFEST[`app${p}/route.ts`]).toMatchObject({ audience: "giver", owner: "A3" });
  });
});

/**
 * Fit Requests without a try-on through the real routes (ADR-055 store-URL previews; or an Aurum request
 * whose recipient never took a photo): the report says tryOn:false, names the preview's store, scores
 * hearts + budget/occasion only, and no giver-facing text claims an undertone, face shape or try-on.
 * Aurum requests with a capture are unchanged.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CreateFitRequestResponse, GiverReportStatus } from "@/server/contracts/api";
import type { CatalogSku } from "@/server/contracts/giftfit";
import aurum from "@/fixtures/aurum/catalog.json";
import { configureFit, resetFitDeps } from "@/server/fit/deps";
import { NO_TRYON_WORDS } from "@/server/fit/explain";
import { PrivacyFitRepository, StaticCatalog } from "@/server/fit/repository";
import type { TasteClient, TasteInput } from "@/server/fit/taste";
import { fakeRules } from "@/server/fit/__tests__/fixtures";
import { findGiverLeaks } from "@/server/privacy/giver-guard";
import { MemoryPrivacyRepos } from "@/server/privacy/repos/memory";
import { setPrivacyDeps } from "@/server/privacy/runtime";
import { POST as reportPOST } from "../report/route";
import { POST as requestsPOST } from "../requests/route";

const PREVIEW = "preview:abcdefghijklmnop";
const AURUM = aurum as unknown as CatalogSku[];
// A jewelry preview: the same designs under the preview's store id (key-scoped ids like the real ones).
const PREVIEW_SKUS: CatalogSku[] = AURUM.filter((s) => s.category === "earring" || s.category === "necklace").map((s) => ({ ...s, id: `abcdefghijklmnop~pv-${s.id}`, storeId: PREVIEW }));
const T0 = new Date("2026-10-27T12:00:00Z");
let repos: MemoryPrivacyRepos;

function setup(taster: TasteClient | null = null) {
  repos = new MemoryPrivacyRepos(() => T0);
  configureFit({
    repository: new PrivacyFitRepository(async () => repos, new StaticCatalog([...AURUM, ...PREVIEW_SKUS])),
    rules: fakeRules,
    explainer: null,
    taster,
    decoySecret: "test-secret",
    now: () => T0,
    stores: {
      snapshot: async () => undefined,
      afterCreate: async () => undefined,
      isGone: async () => false,
      name: async (id) => (id === PREVIEW ? "gorjana" : undefined),
      tryOnEnabled: (id) => !id?.startsWith("preview:"),
    },
  });
}

const post = (body: unknown) => new Request("http://localhost/api/fit/x", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `10.1.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }, body: JSON.stringify(body) });

async function create(storeId?: string) {
  const res = await requestsPOST(post({ ...(storeId ? { storeId } : {}), mode: "help_me_choose", occasion: "birthday", budgetMax: 300, currency: "USD", shortlistIds: [], categories: ["earring", "necklace"] }));
  expect(res.status).toBe(201);
  return (await res.json()) as CreateFitRequestResponse;
}
async function report(giverToken: string) {
  const res = await reportPOST(post({ giverToken }));
  return { res, body: (await res.json()) as GiverReportStatus };
}
/** The recipient hearts pieces; `capture` writes the estimates a selfie would produce. */
async function finish(id: string, n: number, capture: boolean) {
  const rec = (await repos.fitRequests.findById(id))!;
  if (capture) {
    await repos.profiles.upsert({ fitRequestId: id, undertoneEstimate: "warm", undertoneConfidence: 0.83, undertoneOverride: null, faceShape: "Oval", hasHandCapture: false, consentAt: T0, expiresAt: new Date(T0.getTime() + 72 * 3600_000) });
  }
  for (const c of rec.shortlistIds.slice(0, n)) await repos.hearts.add(id, c);
  await repos.fitRequests.setStatus(id, "completed");
  return rec;
}

/** Every giver-facing sentence in a report. */
const sentences = (b: GiverReportStatus) => [...(b.results ?? []).flatMap((r) => [...r.reasons, r.caution ?? ""]), b.tasteSummary?.text ?? ""];

beforeEach(() => {
  resetFitDeps();
  setup();
});
afterEach(() => {
  resetFitDeps();
  setPrivacyDeps(undefined);
});

describe("store-URL preview request (try-on disabled)", () => {
  it("create says tryOn:false and stores the preview's name", async () => {
    const c = await create(PREVIEW);
    expect(c.tryOn).toBe(false);
    expect((await repos.fitRequests.findById(c.fitRequestId))!.storeName).toBe("gorjana");
  });

  it("waiting report already carries tryOn:false and the store name", async () => {
    const c = await create(PREVIEW);
    expect((await report(c.giverToken)).body).toMatchObject({ status: "waiting", tryOn: false, storeName: "gorjana", mode: "help_me_choose" });
  });

  it("completed report: hearts + budget/occasion only, no undertone/face/try-on words, no estimate labels", async () => {
    const calls: TasteInput[] = [];
    setup({ model: "m", summarize: async (i) => (calls.push(i), { summary: "Their hearts lean minimal, in yellow gold." }) });
    const c = await create(PREVIEW);
    await finish(c.fitRequestId, 2, false);
    const { res, body } = await report(c.giverToken);
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ status: "completed", tryOn: false, storeName: "gorjana" });
    expect(body.recipientLabels).toBeUndefined();
    expect(body.results!.length).toBeGreaterThan(0);
    for (const r of body.results!) {
      expect(Object.keys(r.breakdown).sort()).toEqual(["budgetOccasion", "hearts"]);
      expect(r.breakdown.hearts + r.breakdown.budgetOccasion).toBeLessThanOrEqual(100);
    }
    expect(body.results!.filter((r) => r.score >= 80)).toHaveLength(2); // the two hearted pieces
    for (const t of sentences(body)) expect(t, t).not.toMatch(NO_TRYON_WORDS);
    expect(JSON.stringify(body)).not.toMatch(/undertone|face shape|low-confidence|AI try-on preview/i);
    expect(body.tasteSummary?.source).toBe("claude");
    expect(findGiverLeaks(body)).toEqual([]);
  });

  it("a report cached by the old engine (with a metal factor) is recomputed, never reused", async () => {
    const c = await create(PREVIEW);
    const rec = await finish(c.fitRequestId, 1, false);
    const stale = rec.shortlistIds.map((id) => ({ skuId: id, score: 70, breakdown: { hearts: 60, metal: 5, style: 7.5, budgetOccasion: 13 }, reasons: ["Yellow gold is recommended for their neutral undertone estimate.", "x"], caution: "The undertone estimate is low-confidence." }));
    await repos.reports.upsert({ fitRequestId: c.fitRequestId, items: { fingerprint: "old", items: stale } });
    const { body } = await report(c.giverToken);
    for (const t of sentences(body)) expect(t, t).not.toMatch(NO_TRYON_WORDS);
    for (const r of body.results!) expect(r.breakdown.metal).toBeUndefined();
  });
});

describe("Aurum requests", () => {
  it("recipient never captured (no estimates): treated as no try-on, no Aurum header claim needed", async () => {
    const c = await create();
    expect(c.tryOn).toBeUndefined();
    await finish(c.fitRequestId, 1, false);
    const { body } = await report(c.giverToken);
    expect(body.tryOn).toBe(false);
    expect(body.storeName).toBeUndefined();
    for (const r of body.results!) expect(r.breakdown.metal).toBeUndefined();
    for (const t of sentences(body)) expect(t, t).not.toMatch(NO_TRYON_WORDS);
  });

  it("with a capture: unchanged (metal and style factors, estimate labels, no tryOn flag)", async () => {
    const c = await create();
    await finish(c.fitRequestId, 1, true);
    const { body } = await report(c.giverToken);
    expect(body.tryOn).toBeUndefined();
    for (const r of body.results!) expect(Object.keys(r.breakdown).sort()).toEqual(["budgetOccasion", "hearts", "metal", "style"]);
    expect(body.recipientLabels?.undertone).toMatch(/undertone estimate/);
  });
});

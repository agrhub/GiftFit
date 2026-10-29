/**
 * "Help me choose" (ADR-045) through the real route modules over the single store (MemoryPrivacyRepos):
 * create (curated, no decoys, brief stored) → recipient carousel unchanged → report with taste summary
 * and "not tried on" picks, giver-safe, cached so Claude runs once.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CreateFitRequestResponse, GiverReportStatus } from "@/lib/contracts/api";
import type { CatalogSku } from "@/lib/contracts/giftfit";
import aurum from "@/data/aurum/catalog.json";
import { ClaudeSpendRefused } from "@/lib/fit/claude";
import { configureFit, resetFitDeps } from "@/lib/fit/deps";
import { PrivacyFitRepository, StaticCatalog, briefOf } from "@/lib/fit/repository";
import { type TasteClient, type TasteInput, templateTasteSummary } from "@/lib/fit/taste";
import { eligibleVariants, variantsOf } from "@/lib/fit/variants";
import { fakeRules } from "@/lib/fit/__tests__/fixtures";
import { resolveCarousel } from "@/lib/privacy/carousel";
import { findGiverLeaks } from "@/lib/privacy/giver-guard";
import { MemoryPrivacyRepos } from "@/lib/privacy/repos/memory";
import { setPrivacyDeps } from "@/lib/privacy/runtime";
import { hashToken } from "@/lib/privacy/tokens";
import { POST as reportPOST } from "../report/route";
import { POST as requestsPOST } from "../requests/route";

const AURUM = aurum as unknown as CatalogSku[];
const T0 = new Date("2026-10-20T12:00:00Z");
let repos: MemoryPrivacyRepos;

function setup(taster: TasteClient | null = null) {
  repos = new MemoryPrivacyRepos(() => T0);
  configureFit({
    repository: new PrivacyFitRepository(async () => repos, new StaticCatalog(AURUM)),
    rules: fakeRules,
    explainer: null,
    taster,
    decoySecret: "test-secret",
    now: () => T0,
  });
}

const post = (body: unknown) => new Request("http://localhost/api/fit/x", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }, body: JSON.stringify(body) });
const brief = (over: Record<string, unknown> = {}) => ({ mode: "help_me_choose", occasion: "birthday", budgetMax: 300, currency: "USD", shortlistIds: [], ...over });

async function create(over: Record<string, unknown> = {}) {
  const res = await requestsPOST(post(brief(over)));
  return { res, body: (await res.json()) as CreateFitRequestResponse & { error?: string } };
}
async function report(giverToken: string) {
  const res = await reportPOST(post({ giverToken }));
  const text = await res.text();
  return { res, text, body: JSON.parse(text) as GiverReportStatus };
}

/** Recipient: estimates and hearts (as variant rows, like A5's routes) written through PrivacyRepos. */
async function finish(fitRequestId: string, heartIds: string[], wishIds: string[] = []) {
  await repos.profiles.upsert({
    fitRequestId,
    undertoneEstimate: "warm",
    undertoneConfidence: 0.8317,
    undertoneOverride: null,
    faceShape: "Oval",
    hasHandCapture: false,
    consentAt: T0,
    expiresAt: new Date(T0.getTime() + 72 * 3600_000),
  });
  const rec = (await repos.fitRequests.findById(fitRequestId))!;
  for (const id of heartIds) {
    const s = AURUM.find((x) => x.id === id)!;
    const v = eligibleVariants(s, { budgetMax: rec.budgetMax!, currency: "USD", metalLock: rec.metalLock ?? undefined })[0];
    await repos.hearts.add(fitRequestId, { catalogId: id, variantId: v.variantId });
  }
  for (const id of wishIds) await repos.wishes.add(fitRequestId, id);
  await repos.fitRequests.setStatus(fitRequestId, "completed");
}

beforeEach(() => {
  resetFitDeps();
  setup();
});
afterEach(() => {
  resetFitDeps();
  setPrivacyDeps(undefined);
});

describe("POST /api/fit/requests mode=help_me_choose", () => {
  it("curates 6 real candidates within the cap, stores the brief, and no decoys", async () => {
    const { res, body } = await create({ categories: ["earring", "necklace"], styleHints: ["minimal"], genderPresentation: "feminine", metalLock: ["yellow_gold", "rose_gold"] });
    expect(res.status).toBe(201);
    expect(body.carouselSize).toBe(6);
    const rec = (await repos.fitRequests.findById(body.fitRequestId))!;
    expect(rec.mode).toBe("help_me_choose");
    expect(rec.decoyIds).toEqual([]);
    expect(rec.shortlistIds).toHaveLength(6);
    expect(new Set(rec.shortlistIds).size).toBe(6);
    expect(rec.categories).toEqual(["earring", "necklace"]);
    expect(rec.styleHints).toEqual(["minimal"]);
    expect(rec.genderPresentation).toBe("feminine");
    expect(rec.metalLock).toEqual(["yellow_gold", "rose_gold"]);
    for (const id of rec.shortlistIds) {
      const s = AURUM.find((x) => x.id === id)!;
      expect(["earring", "necklace"]).toContain(s.category);
      expect(s.attributes.gender_presentation).not.toBe("masculine");
      expect(eligibleVariants(s, { budgetMax: 300, currency: "USD", metalLock: ["yellow_gold", "rose_gold"] }).length).toBeGreaterThan(0);
    }
    // The response carries no catalog ids (no shortlist, no curation) — only links and tokens.
    expect(Object.keys(body).sort()).toEqual(["carouselSize", "expiresAt", "fitRequestId", "giverReportPath", "giverToken", "recipientPath"]);
  });

  it("ignores shortlistIds, is stable per request id + secret, and differs across requests", async () => {
    const a = await create({ shortlistIds: ["whatever-1", "whatever-2"] });
    expect(a.res.status).toBe(201);
    const ids = new Set<string>();
    for (let i = 0; i < 6; i++) ids.add((await repos.fitRequests.findById((await create()).body.fitRequestId))!.shortlistIds.join(","));
    expect(ids.size).toBeGreaterThan(1);
  });

  it("absent mode stays i_have_ideas (backward compatible) and is stored as such", async () => {
    const shortlist = [AURUM.find((s) => s.title === "Halo Drop Earrings")!.id];
    const res = await requestsPOST(post({ occasion: "birthday", budgetMax: 300, currency: "USD", shortlistIds: shortlist }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateFitRequestResponse;
    const rec = (await repos.fitRequests.findById(body.fitRequestId))!;
    expect(rec.mode).toBe("i_have_ideas");
    expect(rec.decoyIds.length).toBeGreaterThanOrEqual(2);
    expect(rec.categories).toBeUndefined();
  });

  it.each([
    ["unknown category", { categories: ["tiara"] }],
    ["duplicate hints", { styleHints: ["minimal", "minimal"] }],
    ["unknown hint", { styleHints: ["goth"] }],
    ["bad gender", { genderPresentation: "any" }],
    ["unknown mode", { mode: "surprise_me" }],
  ])("400 on %s", async (_l, over) => {
    expect((await create(over)).res.status).toBe(400);
  });

  it("i_have_ideas still requires 1–4 designs", async () => {
    expect((await create({ mode: "i_have_ideas", shortlistIds: [] })).res.status).toBe(400);
  });

  it("422 insufficient_catalog when fewer than 4 designs fit the cap", async () => {
    const { res, body } = await create({ budgetMax: 20 });
    expect(res.status).toBe(422);
    expect(body.error).toBe("insufficient_catalog");
  });

  it("the recipient carousel is unchanged: the curated designs, all eligible swatches, no prices or ids", async () => {
    const { body } = await create({ budgetMax: 600 });
    const rec = (await repos.fitRequests.findById(body.fitRequestId))!;
    const items = await resolveCarousel({ signingSecret: "s".repeat(32), catalog: new StaticCatalog(AURUM), repos }, rec);
    expect(items.map((i) => i.sku.id).sort()).toEqual([...rec.shortlistIds].sort());
    for (const it of items) {
      // No decoys → no swatch leveling: every eligible metal is offered.
      expect(it.swatches.length).toBe(eligibleVariants(it.sku, { budgetMax: 600, currency: "USD" }).length);
      expect(it.itemId).not.toBe(it.sku.id);
    }
  });
});

describe("POST /api/fit/report for help_me_choose", () => {
  it("waiting carries the mode; completed has ranked results, a template taste summary and not-tried picks", async () => {
    const { body: created } = await create({ categories: ["earring", "necklace"] });
    expect((await report(created.giverToken)).body).toEqual({ status: "waiting", expiresAt: created.expiresAt, mode: "help_me_choose", lang: "en" });
    const rec = (await repos.fitRequests.findById(created.fitRequestId))!;
    const hearted = rec.shortlistIds.slice(0, 2);
    await finish(created.fitRequestId, hearted, [rec.shortlistIds[2]]);

    const { res, text, body } = await report(created.giverToken);
    expect(res.status).toBe(200);
    expect(body.mode).toBe("help_me_choose");
    expect(body.results).toHaveLength(6);
    expect(body.results!.slice(0, 2).map((r) => r.skuId).sort()).toEqual([...hearted].sort()); // hearts rank first
    for (const r of body.results!) expect(r.price).toBeLessThanOrEqual(300);
    expect(body.heartedShortlistIds!.sort()).toEqual([...hearted].sort());
    expect(body.otherMetalWishes).toEqual([rec.shortlistIds[2]]);
    expect(body.tasteSummary!.source).toBe("template");
    expect(body.tasteSummary!.text).toMatch(/^They hearted 2 of 6 pieces\./);
    expect(body.similarNotTried!.length).toBeGreaterThanOrEqual(2);
    expect(body.similarNotTried!.length).toBeLessThanOrEqual(3);
    for (const p of body.similarNotTried!) {
      expect(rec.shortlistIds).not.toContain(p.catalogId); // never something they saw
      expect(p.label).toBe("not tried on");
      expect(p.price).toBeLessThanOrEqual(300);
      expect(p.currency).toBe("USD");
      expect(variantsOf(AURUM.find((s) => s.id === p.catalogId)!).some((v) => v.variantId === p.variantId && v.price <= 300)).toBe(true);
    }
    // Giver-safe: the guard finds nothing, and no recipient number, hex, image or face word is in the body.
    expect(findGiverLeaks(body)).toEqual([]);
    for (const re of [/#[0-9a-f]{6}\b/i, /https?:\/\//i, /\.(png|jpe?g|webp)\b/i, /0\.83/, /hueDeg|"lab"|skin_color|selfie|photo|faceAspectRatio|confidence/i]) expect(text).not.toMatch(re);
  });

  it("no hearts: template says so, and no not-tried picks", async () => {
    const { body: created } = await create();
    await finish(created.fitRequestId, []);
    const { body } = await report(created.giverToken);
    expect(body.tasteSummary!.text).toMatch(/didn't heart any/);
    expect(body.similarNotTried).toBeUndefined();
  });

  it("Claude writes the taste summary from catalog attributes only, once per report (cached)", async () => {
    const calls: TasteInput[] = [];
    setup({ model: "claude-sonnet-5-5", summarize: async (i) => (calls.push(i), { summary: "Their hearts lean minimal and classic, mostly in yellow gold, with a liking for hoops." }) });
    const { body: created } = await create({ categories: ["earring"] });
    const rec = (await repos.fitRequests.findById(created.fitRequestId))!;
    await finish(created.fitRequestId, rec.shortlistIds.slice(0, 3));
    const first = await report(created.giverToken);
    expect(first.body.tasteSummary).toEqual({ text: "Their hearts lean minimal and classic, mostly in yellow gold, with a liking for hoops.", source: "claude" });
    const second = await report(created.giverToken);
    expect(second.body.tasteSummary).toEqual(first.body.tasteSummary);
    expect(second.body.similarNotTried).toEqual(first.body.similarNotTried);
    expect(calls).toHaveLength(1);
    // The prompt input: counts and catalog attributes of the hearted designs, nothing about the recipient.
    const input = JSON.stringify(calls[0]);
    expect(calls[0]).toMatchObject({ shownCount: 6, heartedCount: 3, wishedCount: 0 });
    for (const re of [/undertone|warm|cool|neutral/i, /face|oval|heart-shaped/i, /0\.83|confidence/i, /#[0-9a-f]{3,6}/i, /photo|selfie|image|tryon|http/i]) expect(input).not.toMatch(re);
    for (const id of rec.shortlistIds) expect(input).not.toContain(id);
  });

  it("spend-cap refusal → template taste summary, report still completes", async () => {
    setup({ model: "claude-sonnet-5-5", summarize: async () => Promise.reject(new ClaudeSpendRefused("daily_cap")) });
    const { body: created } = await create();
    const rec = (await repos.fitRequests.findById(created.fitRequestId))!;
    await finish(created.fitRequestId, rec.shortlistIds.slice(0, 1));
    const { res, body } = await report(created.giverToken);
    expect(res.status).toBe(200);
    expect(body.tasteSummary!.source).toBe("template");
  });

  it("a row without a stored mode (Drizzle) reads as help_me_choose by its shape", () => {
    expect(briefOf({ decoyIds: [], shortlistIds: ["a", "b", "c", "d", "e", "f"] }).mode).toBe("help_me_choose");
    expect(briefOf({ decoyIds: ["x", "y"], shortlistIds: ["a"] }).mode).toBe("i_have_ideas");
    expect(briefOf({ decoyIds: [], shortlistIds: ["a", "b"] }).mode).toBe("i_have_ideas");
  });

  it("the giver token hash is all the store keeps", async () => {
    const { body: created } = await create();
    const rec = (await repos.fitRequests.findById(created.fitRequestId))!;
    expect(rec.giverTokenHash).toBe(hashToken(created.giverToken));
    expect(JSON.stringify(rec)).not.toContain(created.giverToken);
  });

  it("template text equals the shared template function", async () => {
    expect(templateTasteSummary({ shownCount: 6, heartedCount: 0, wishedCount: 0, hearted: [] })).toMatch(/no clear taste signal/);
  });
});

/**
 * Requests without a try-on (store-URL previews, ADR-055; or no photo taken): no undertone or face-shape
 * estimate exists, so scoring drops those factors (FIT_WEIGHTS_NO_TRYON) and no giver-facing text may
 * mention undertone, skin, face shape, photos, estimates or a try-on. Try-on requests stay unchanged.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import type { JewelryCategory, RecipientProfile } from "@/lib/contracts/giftfit";
import {
  AnthropicExplainClient,
  EXPLAIN_SYSTEM,
  EXPLAIN_SYSTEM_NO_TRYON,
  type ExplainClient,
  NO_TRYON_WORDS,
  buildExplainInput,
  checkText,
  explainFit,
} from "../explain";
import { GENERIC_CAUTION_NO_TRYON, scoreSkus, toFitResult } from "../score";
import { buildTasteInput, tasteSummary, templateTasteSummary, type TasteClient } from "../taste";
import { FIT_WEIGHTS_NO_TRYON } from "../weights";
import { fakeRules, makeCatalog, profile, request, sku, withVariants } from "./fixtures";

const CATALOG = withVariants(makeCatalog(80, "no-tryon"), 0.3, "no-tryon-v");
/** What the engine's old neutral default looked like for a recipient who never captured. */
const NEUTRAL_DEFAULT: RecipientProfile = { undertoneEstimate: "neutral", undertoneConfidence: 0, faceShape: "Unknown", heartedSkuIds: [] };
const withCategory = <T extends { skuId: string }>(xs: T[]) => xs.map((s) => ({ ...s, category: CATALOG.find((k) => k.id === s.skuId)!.category as JewelryCategory }));

/** Every giver-facing string of a scored set. */
const texts = (xs: ReturnType<typeof scoreSkus>) => xs.flatMap((s) => [...s.reasons, s.caution ?? ""]);

describe("the word-list guard itself", () => {
  it.each(["their undertone", "warm skin", "an oval face shape", "during their try-on", "they tried it on", "from their photo", "the estimate", "low-confidence"])("flags %j", (t) => {
    expect(NO_TRYON_WORDS.test(t)).toBe(true);
  });
  it.each(["They hearted this piece.", "Within your $300 budget.", "A natural fit for a birthday.", "in yellow gold", GENERIC_CAUTION_NO_TRYON])("allows %j", (t) => {
    expect(NO_TRYON_WORDS.test(t)).toBe(false);
  });
});

describe("scoring without a try-on", () => {
  const hearted = CATALOG.slice(0, 3).map((s) => s.id);
  const profiles: Array<[string, RecipientProfile]> = [
    ["no capture, neutral default", NEUTRAL_DEFAULT],
    ["no capture, with hearts", { ...NEUTRAL_DEFAULT, heartedSkuIds: hearted }],
    ["stray estimate in the row", profile({ undertoneEstimate: "warm", undertoneConfidence: 0.9, faceShape: "Oval", heartedSkuIds: hearted })],
  ];

  it.each(profiles)("%s: only hearts and budget/occasion, renormalised to 80 + 20", (_l, p) => {
    const scored = scoreSkus(p, CATALOG, request({ budgetMax: 400, shortlistIds: CATALOG.map((s) => s.id) }), fakeRules, { noTryOn: true });
    for (const s of scored) {
      expect(Object.keys(s.breakdown).sort()).toEqual(["budgetOccasion", "hearts"]);
      expect(s.breakdown.hearts).toBeLessThanOrEqual(FIT_WEIGHTS_NO_TRYON.hearts);
      expect(s.breakdown.budgetOccasion).toBeLessThanOrEqual(FIT_WEIGHTS_NO_TRYON.budgetOccasion);
      expect(s.signals.map((g) => g.factor)).not.toContain("metal");
      expect(s.signals.map((g) => g.factor)).not.toContain("style");
      expect(s.signals.map((g) => g.factor)).not.toContain("confidence");
      expect(Object.keys(toFitResult(s).breakdown).sort()).toEqual(["budgetOccasion", "hearts"]);
    }
    for (const t of texts(scored)) expect(t, t).not.toMatch(NO_TRYON_WORDS);
  });

  it("scores: hearted + in budget + tagged = 100; not hearted, in budget, not tagged = 15", () => {
    const a = sku("a", { price: 200, attributes: { occasions: ["birthday"] } });
    const b = sku("b", { price: 200, attributes: { occasions: ["wedding"] } });
    const p = { ...NEUTRAL_DEFAULT, heartedSkuIds: ["a"] };
    const [sa, sb] = scoreSkus(p, [a, b], request({ occasion: "birthday", budgetMin: undefined, budgetMax: 300 }), fakeRules, { noTryOn: true });
    expect(sa.score).toBe(100);
    expect(sa.reasons[0]).toBe("They hearted this piece.");
    expect(sb.score).toBe(15);
    expect(sb.caution).toBe("They did not heart this piece.");
  });

  it("no hearts at all: the score rests on budget and the occasion, not styling rules", () => {
    const [s] = scoreSkus(NEUTRAL_DEFAULT, [sku("a")], request(), fakeRules, { noTryOn: true });
    expect(texts([s]).join(" ")).toMatch(/budget and the occasion/);
    expect(texts([s]).join(" ")).not.toMatch(/styling rules/);
  });

  it("try-on requests are unchanged: metal and style factors and their signals are still there", () => {
    const p = profile({ heartedSkuIds: [CATALOG[0].id] });
    const withTryOn = scoreSkus(p, CATALOG, request({ shortlistIds: [] }), fakeRules);
    const explicit = scoreSkus(p, CATALOG, request({ shortlistIds: [] }), fakeRules, { noTryOn: false });
    expect(explicit).toEqual(withTryOn);
    for (const s of withTryOn) expect(Object.keys(s.breakdown).sort()).toEqual(["budgetOccasion", "hearts", "metal", "style"]);
    expect(withTryOn.some((s) => s.signals.some((g) => g.factor === "metal"))).toBe(true);
  });
});

describe("explanations without a try-on", () => {
  const p = { ...NEUTRAL_DEFAULT, heartedSkuIds: [CATALOG[0].id] };
  const scored = withCategory(scoreSkus(p, CATALOG.slice(0, 4), request({ budgetMax: 600 }), fakeRules, { noTryOn: true }));

  it("the model input says tryOn:false and carries no try-on labels", () => {
    const input = buildExplainInput(scored, { noTryOn: true });
    expect(input.tryOn).toBe(false);
    const json = JSON.stringify(input);
    expect(json).not.toMatch(/undertone|face|estimate|metal"|style"/i);
    for (const it of input.items) expect(Object.keys(it.breakdown).sort()).toEqual(["budgetOccasion", "hearts"]);
  });

  it("uses the no-try-on system prompt (and the usual one otherwise)", async () => {
    const create = vi.fn(async () => ({ stop_reason: "end_turn", model: "m", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: JSON.stringify({ items: [] }) }] }));
    const client = new AnthropicExplainClient({ beta: { messages: { create } } } as unknown as Anthropic, { reserve: async () => ({ ok: true, settle: async () => undefined }) });
    await explainFit(scored, { client, noTryOn: true });
    await explainFit(scored, { client });
    const sys = (i: number) => ((create.mock.calls[i] as unknown as [{ system: { text: string }[] }])[0].system[0].text);
    expect(sys(0)).toBe(EXPLAIN_SYSTEM_NO_TRYON);
    expect(sys(1)).toBe(EXPLAIN_SYSTEM);
    expect(EXPLAIN_SYSTEM_NO_TRYON).toMatch(/no try-on/);
  });

  it("any model text mentioning undertone, face shape, photos or a try-on falls back to the template", async () => {
    const bad = ["Yellow gold suits their neutral undertone estimate.", "Works with an oval face shape.", "They loved it during their try-on.", "Looks lovely in their photo."];
    const mock: ExplainClient = {
      model: "m",
      explain: async () => ({ items: scored.map((s, i) => ({ skuId: s.skuId, reason1: bad[i % bad.length], reason2: "Within your budget.", caution: "The undertone estimate is low-confidence." })) }),
    };
    const r = await explainFit(scored, { client: mock, noTryOn: true });
    expect(r.issues.some((i) => i.code === "leak_tryon")).toBe(true);
    for (const res of r.results) for (const t of [...res.reasons, res.caution ?? ""]) expect(t, t).not.toMatch(NO_TRYON_WORDS);
    expect(r.results.every((res) => res.reasons[1] === "Within your budget.")).toBe(true); // clean slots are kept
  });

  it("checkText only applies the guard when asked", () => {
    expect(checkText("Suits their undertone.", "x", { allowedIds: ["x"], noTryOn: true })).toContain("leak_tryon");
    expect(checkText("Suits their undertone estimate.", "x", { allowedIds: ["x"] })).not.toContain("leak_tryon");
  });
});

describe("taste summary without a try-on", () => {
  const input = buildTasteInput([{ sku: CATALOG[0], metal: CATALOG[0].attributes.metal }], 6, 0);

  it("the template never mentions a try-on or estimates", () => {
    for (const t of [templateTasteSummary(input, { noTryOn: true }), templateTasteSummary({ ...input, heartedCount: 0, hearted: [] }, { noTryOn: true })]) expect(t).not.toMatch(NO_TRYON_WORDS);
    expect(templateTasteSummary({ ...input, heartedCount: 0, hearted: [] }, { noTryOn: true })).toMatch(/budget and the occasion/);
  });

  it("a Claude summary mentioning a try-on is rejected", async () => {
    const client: TasteClient = { model: "m", summarize: async () => ({ summary: "From their try-on, they lean minimal." }) };
    const r = await tasteSummary(input, { client, noTryOn: true });
    expect(r.summary.source).toBe("template");
    expect(r.summary.text).not.toMatch(NO_TRYON_WORDS);
  });
});

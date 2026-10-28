/**
 * A16 mixed sets: the recipient took a photo, but some pieces (store-URL preview photos YouCam can't use) were
 * not tried on. Tried pieces keep the try-on weights; the others use FIT_WEIGHTS_NO_TRYON and never get an
 * undertone, face-shape or try-on claim, in the template or from the model.
 */
import { describe, expect, it } from "vitest";
import { NO_TRYON_WORDS, buildExplainInput, validateExplanation } from "../explain";
import { scoreSkus, toFitResult } from "../score";
import { FIT_WEIGHTS_NO_TRYON } from "../weights";
import { fakeRules, profile, request, sku } from "./fixtures";

const tried = sku("tried", { category: "earring", price: 200, attributes: { metal: "yellow_gold", earring_shape: "drop_teardrop" } });
const untried = sku("untried", { category: "earring", price: 200, attributes: { metal: "yellow_gold", earring_shape: "drop_teardrop", tryon_eligible: false } });
const p = profile({ undertoneEstimate: "warm", undertoneConfidence: 0.9, faceShape: "Heart", heartedSkuIds: ["tried", "untried"] });
const req = request({ shortlistIds: ["tried", "untried"] });
const scored = () => scoreSkus(p, [tried, untried], req, fakeRules, { noTryOnIds: new Set(["untried"]) });

describe("mixed scoring", () => {
  it("tried piece: try-on weights (metal and style); untried piece: hearts 80 + budget/occasion 20, tryOn:false", () => {
    const [a, b] = [scored().find((s) => s.skuId === "tried")!, scored().find((s) => s.skuId === "untried")!];
    expect(Object.keys(a.breakdown).sort()).toEqual(["budgetOccasion", "hearts", "metal", "style"]);
    expect(a.tryOn).toBeUndefined();
    expect(Object.keys(b.breakdown).sort()).toEqual(["budgetOccasion", "hearts"]);
    expect(b.breakdown.hearts).toBe(FIT_WEIGHTS_NO_TRYON.hearts);
    expect(b.tryOn).toBe(false);
    expect(toFitResult(b).tryOn).toBe(false);
    expect(toFitResult(a)).not.toHaveProperty("tryOn");
    expect(b.score).toBeLessThanOrEqual(100);
  });

  it("no undertone, face-shape or try-on words for the untried piece (reasons, caution, model input labels)", () => {
    const b = scored().find((s) => s.skuId === "untried")!;
    for (const t of [...b.reasons, b.caution ?? "", ...b.signals.map((s) => s.label)]) expect(t, t).not.toMatch(NO_TRYON_WORDS);
    const input = buildExplainInput(scored().map((s) => ({ ...s, category: "earring" as const })));
    expect(input.tryOn).toBeUndefined();
    expect(input.items.find((i) => i.skuId === "untried")?.tryOn).toBe(false);
  });

  it("a model text that claims an undertone for the untried piece is replaced by the template; the tried one may keep it", () => {
    const s = scored();
    const claim = "Their warm undertone estimate suits this piece.";
    const raw = { items: s.map((x) => ({ skuId: x.skuId, reason1: claim, reason2: "A natural fit for the birthday.", caution: "Check the size before buying." })) };
    const v = validateExplanation(raw, s);
    expect(v.results.find((r) => r.skuId === "tried")!.reasons[0]).toBe(claim);
    const u = v.results.find((r) => r.skuId === "untried")!;
    expect(u.reasons[0]).not.toMatch(NO_TRYON_WORDS);
    expect(v.issues).toContainEqual(expect.objectContaining({ skuId: "untried", code: "leak_tryon" }));
  });

  it("ranking: hearted tried-on pieces first, then hearted 'Not tried on' pieces, then the rest, even when an untried piece scores higher", () => {
    const plain = sku("plain", { category: "earring", price: 200, attributes: { metal: "yellow_gold", earring_shape: "drop_teardrop" } });
    const s = scoreSkus(p, [untried, plain, tried], request({ shortlistIds: ["tried", "untried", "plain"] }), fakeRules, { noTryOnIds: new Set(["untried"]) });
    const by = Object.fromEntries(s.map((x) => [x.skuId, x]));
    expect(by.untried.raw).toBeGreaterThan(by.tried.raw); // the case the rule is for
    expect(s.map((x) => x.skuId)).toEqual(["tried", "untried", "plain"]);
    // Without untried pieces the order is by score alone, as before.
    const only = scoreSkus(p, [plain, tried], request({ shortlistIds: ["tried", "plain"] }), fakeRules);
    expect(only.map((x) => x.skuId)).toEqual([...only].sort((a, b) => b.raw - a.raw).map((x) => x.skuId));
  });

  it("noTryOn for the whole request still wins (nothing was tried): no per-item flag needed", () => {
    for (const s of scoreSkus(p, [tried, untried], req, fakeRules, { noTryOn: true, noTryOnIds: new Set(["untried"]) })) {
      expect(Object.keys(s.breakdown).sort()).toEqual(["budgetOccasion", "hearts"]);
      expect(s.tryOn).toBeUndefined();
    }
  });
});

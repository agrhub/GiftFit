/**
 * Metal variants (ADR-032): eligibility, default swatch and per-variant scoring (fit-v1.1).
 * Halo-like design: yellow gold $245 (listed first), white gold $265, rose gold $249.
 */
import { describe, expect, it } from "vitest";
import type { CatalogSku, MetalVariant } from "@/lib/contracts/giftfit";
import { fitScore, variantHeartLevel } from "../score";
import { defaultVariant, eligibleVariants, variantIndex, variantView, variantsOf } from "../variants";
import { fakeRules, profile, request, sku } from "./fixtures";

const v = (id: string, metal: MetalVariant["metal"], tone: MetalVariant["metal_tone"], price: number): MetalVariant => ({
  variantId: `${id}:${metal}`,
  metal,
  metal_tone: tone,
  price,
  images: [`/catalog/${id}-${metal}.jpg`],
  vto_image: `/catalog/${id}-${metal}.jpg`,
  vto_spec_ok: true,
});

const HALO: CatalogSku = {
  ...sku("halo", { title: "Halo Drop Earrings", price: 245 }),
  variants: [v("halo", "yellow_gold", "warm", 245), v("halo", "white_gold", "cool", 265), v("halo", "rose_gold", "warm", 249)],
};
const ids = (vs: MetalVariant[] | undefined) => (vs ?? []).map((x) => x.metal);
const REQ = request({ budgetMin: undefined, budgetMax: 300 });

describe("variantsOf / eligibleVariants", () => {
  it("treats a SKU without variants as one variant built from its top-level fields", () => {
    const one = variantsOf(sku("solo", { price: 120 }));
    expect(one).toEqual([{ variantId: "solo:yellow_gold", metal: "yellow_gold", metal_tone: "warm", price: 120, images: ["catalog/solo.png"], vto_image: "catalog/solo.png", vto_spec_ok: true }]);
  });

  it("keeps variants priced ≤ budgetMax, in the currency, inside the metal lock, in listing order", () => {
    expect(ids(eligibleVariants(HALO, REQ))).toEqual(["yellow_gold", "white_gold", "rose_gold"]);
    expect(ids(eligibleVariants(HALO, { ...REQ, budgetMax: 250 }))).toEqual(["yellow_gold", "rose_gold"]);
    expect(ids(eligibleVariants(HALO, { ...REQ, metalLock: ["white_gold", "platinum"] }))).toEqual(["white_gold"]);
    expect(ids(eligibleVariants(HALO, { ...REQ, metalLock: [] }))).toHaveLength(3); // empty lock = no lock
    expect(eligibleVariants(HALO, { ...REQ, budgetMax: 200 })).toEqual([]);
    expect(eligibleVariants(HALO, { ...REQ, currency: "EUR" })).toEqual([]);
  });

  it("variantView and variantIndex", () => {
    const white = variantView(HALO, HALO.variants![1]);
    expect(white).toMatchObject({ id: "halo", price: 265, attributes: { metal: "white_gold", metal_tone: "cool", vto_image: "/catalog/halo-white_gold.jpg" } });
    expect(variantIndex([HALO, sku("solo")]).get("halo:rose_gold")).toBe("halo");
    expect(variantIndex([HALO, sku("solo")]).get("solo:yellow_gold")).toBe("solo");
  });
});

describe("defaultVariant", () => {
  it("prefers the tone match to the undertone estimate, even at low confidence", () => {
    expect(defaultVariant(HALO, REQ, profile({ undertoneEstimate: "cool", undertoneConfidence: 0.2 }))?.metal).toBe("white_gold");
    expect(defaultVariant(HALO, REQ, profile({ undertoneEstimate: "cool", undertoneOverride: "warm" }))?.metal).toBe("yellow_gold");
  });

  it("falls back to the giver's listed variant, then the first eligible one", () => {
    expect(defaultVariant(HALO, REQ)?.metal).toBe("yellow_gold");
    expect(defaultVariant(HALO, REQ, profile({ undertoneEstimate: "neutral" }))?.metal).toBe("yellow_gold"); // no neutral-tone metal
    expect(defaultVariant(HALO, { ...REQ, budgetMax: 250 }, profile({ undertoneEstimate: "cool" }))?.metal).toBe("yellow_gold"); // white over cap
    expect(defaultVariant(HALO, { ...REQ, metalLock: ["white_gold", "rose_gold"] })?.metal).toBe("white_gold");
    expect(defaultVariant(HALO, { ...REQ, budgetMax: 100 })).toBeUndefined();
  });
});

describe("per-variant scoring (fit-v1.1)", () => {
  it("hearts attach to a variant: the hearted metal is reported even when another scores higher on styling", () => {
    // warm × white gold is only 'acceptable': 60 + 10 × 0.7 + 15 + 15 = 97
    const p = profile({ heartedSkuIds: ["halo"], heartedVariantIds: ["halo:white_gold"] });
    const r = fitScore(p, HALO, REQ, fakeRules);
    expect(r).toMatchObject({ skuId: "halo", variantId: "halo:white_gold", metal: "white_gold", price: 265, score: 97 });
    expect(r.breakdown).toEqual({ hearts: 60, metal: 7, style: 15, budgetOccasion: 15 });
    expect(r.wishOtherMetal).toBeUndefined();
  });

  it("another metal of a hearted design counts 0.6 of the heart; a wish counts 0.5", () => {
    const p = profile({ heartedSkuIds: ["halo"], heartedVariantIds: ["halo:white_gold"] });
    const designVariantIds = variantsOf(HALO).map((x) => x.variantId);
    expect(variantHeartLevel(p, "halo", { variantId: "halo:white_gold", designVariantIds })).toEqual({ h: 1, kind: "hearted" });
    expect(variantHeartLevel(p, "halo", { variantId: "halo:yellow_gold", designVariantIds })).toEqual({ h: 0.6, kind: "other_metal" });
    const wish = profile({ wishOtherMetalSkuIds: ["halo"] });
    expect(variantHeartLevel(wish, "halo", { variantId: "halo:yellow_gold", designVariantIds })).toEqual({ h: 0.5, kind: "wish" });
    // A design hearted with no variant recorded counts fully for every variant.
    expect(variantHeartLevel(profile({ heartedSkuIds: ["halo"] }), "halo", { variantId: "halo:rose_gold", designVariantIds }).h).toBe(1);
  });

  it("wish only: 0.5 × 60 = 30 hearts points, flagged wishOtherMetal, best metal reported", () => {
    const r = fitScore(profile({ wishOtherMetalSkuIds: ["halo"] }), HALO, REQ, fakeRules);
    expect(r).toMatchObject({ variantId: "halo:yellow_gold", score: 70, wishOtherMetal: true });
    expect(r.breakdown.hearts).toBe(30);
    expect(r.reasons[0]).toBe("They loved the style and wished it came in another metal.");
  });

  it("no hearts: best-scoring eligible variant, ties keep the giver's listing order", () => {
    const r = fitScore(profile(), HALO, REQ, fakeRules);
    expect(r).toMatchObject({ variantId: "halo:yellow_gold", metal: "yellow_gold", price: 245, score: 40 });
  });

  it("the undertone factor is low-weight at real-world confidence (ADR-031)", () => {
    // cool estimate at 0.2: white 10 × 0.6 = 6 vs yellow 10 × 0.54 = 5.4 → 0.6 points apart
    const low = fitScore(profile({ undertoneEstimate: "cool", undertoneConfidence: 0.2 }), HALO, REQ, fakeRules);
    expect(low.metal).toBe("white_gold");
    expect(low.breakdown.metal).toBe(6);
    expect(low.caution).toMatch(/low confidence/);
    // A heart on yellow gold outweighs any metal advice.
    const hearted = fitScore(profile({ undertoneEstimate: "cool", undertoneConfidence: 1, heartedSkuIds: ["halo"], heartedVariantIds: ["halo:yellow_gold"] }), HALO, REQ, fakeRules);
    expect(hearted.metal).toBe("yellow_gold");
  });

  it("respects the cap and the metal lock", () => {
    expect(fitScore(profile({ undertoneEstimate: "cool" }), HALO, { ...REQ, budgetMax: 250 }, fakeRules).metal).not.toBe("white_gold");
    const locked = fitScore(profile(), HALO, { ...REQ, metalLock: ["white_gold"] }, fakeRules);
    expect(locked).toMatchObject({ metal: "white_gold", price: 265 });
  });

  it("budgetMin is optional: no floor, the cap alone defines 'within budget'", () => {
    const r = fitScore(profile(), sku("cheap", { price: 40 }), REQ, fakeRules);
    expect(r.breakdown.budgetOccasion).toBe(15);
    expect(r.reasons.join(" ")).not.toMatch(/below/);
    expect(fitScore(profile(), sku("cheap", { price: 40 }), request({ budgetMin: 150 }), fakeRules).breakdown.budgetOccasion).toBe(6);
  });

  it("look-alike credit uses the hearted variant's metal", () => {
    const other = sku("twin", { price: 240 });
    const heartedView = variantView(HALO, HALO.variants![0]); // yellow gold, same style as `twin`
    const r = fitScore(profile({ heartedSkuIds: ["halo"], heartedVariantIds: ["halo:yellow_gold"] }), other, REQ, fakeRules, { heartedSkus: [heartedView] });
    expect(r.breakdown.hearts).toBe(24); // 0.4 × similarity 1 × 60
  });
});

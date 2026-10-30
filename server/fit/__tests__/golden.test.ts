/**
 * Golden tests: hand-computed from the published formula (server/fit/WEIGHTS.md). Any change to the
 * weights must update these numbers and bump FIT_WEIGHTS_VERSION.
 *
 * fit-v1.1 weights: hearts 60, metal 10, style 15, budget/occasion 15.
 * Baseline: earring, yellow gold, classic teardrop, $200, tagged anniversary; request anniversary
 * $150–300 USD; recipient warm (confidence 1), oval face, no hearts → 0 + 10 + 15 + 15 = 40.
 */
import { describe, expect, it } from "vitest";
import type { CatalogSku, FitBreakdown, FitRequestInput, RecipientProfile } from "@/server/contracts/giftfit";
import { FIT_MAX, FIT_WEIGHTS, FIT_WEIGHTS_VERSION } from "../weights";
import { fitScore, scoreSkus, toFitResult } from "../score";
import { wordCount } from "../explain";
import { fakeRules, profile, request, sku } from "./fixtures";

interface Golden {
  name: string;
  sku: CatalogSku;
  profile: RecipientProfile | null;
  request?: FitRequestInput;
  hearted?: CatalogSku[];
  score: number;
  breakdown: FitBreakdown;
}

const neck = (id: string, style: CatalogSku["attributes"]["necklace_style"], len: number) =>
  sku(id, { category: "necklace", attributes: { category: "necklace", necklace_style: style, necklace_length_in: len } });
const ear = (id: string, shape: CatalogSku["attributes"]["earring_shape"]) => sku(id, { attributes: { earring_shape: shape } });

const GOLDEN: Golden[] = [
  { name: "G01 baseline", sku: sku("a"), profile: profile(), score: 40, breakdown: { hearts: 0, metal: 10, style: 15, budgetOccasion: 15 } },
  { name: "G02 hearted", sku: sku("a"), profile: profile({ heartedSkuIds: ["a"] }), score: 100, breakdown: { hearts: 60, metal: 10, style: 15, budgetOccasion: 15 } },
  { name: "G03 cool × yellow gold = acceptable", sku: sku("a"), profile: profile({ undertoneEstimate: "cool" }), score: 37, breakdown: { hearts: 0, metal: 7, style: 15, budgetOccasion: 15 } },
  {
    name: "G04 cool × white gold = recommended",
    sku: sku("a", { attributes: { metal: "white_gold", metal_tone: "cool" } }),
    profile: profile({ undertoneEstimate: "cool" }),
    score: 40,
    breakdown: { hearts: 0, metal: 10, style: 15, budgetOccasion: 15 },
  },
  { name: "G05 warm × silver = acceptable", sku: sku("a", { attributes: { metal: "silver", metal_tone: "cool" } }), profile: profile(), score: 37, breakdown: { hearts: 0, metal: 7, style: 15, budgetOccasion: 15 } },
  {
    name: "G06 neutral × two-tone = recommended",
    sku: sku("a", { attributes: { metal: "mixed_two_tone", metal_tone: "neutral" } }),
    profile: profile({ undertoneEstimate: "neutral" }),
    score: 40,
    breakdown: { hearts: 0, metal: 10, style: 15, budgetOccasion: 15 },
  },
  { name: "G07 warm × two-tone = acceptable", sku: sku("a", { attributes: { metal: "mixed_two_tone", metal_tone: "neutral" } }), profile: profile(), score: 37, breakdown: { hearts: 0, metal: 7, style: 15, budgetOccasion: 15 } },
  { name: "G08 confidence 0.5 shrinks metal", sku: sku("a"), profile: profile({ undertoneConfidence: 0.5 }), score: 38, breakdown: { hearts: 0, metal: 7.5, style: 15, budgetOccasion: 15 } },
  { name: "G09 confidence 0 → metal midpoint", sku: sku("a"), profile: profile({ undertoneEstimate: "cool", undertoneConfidence: 0 }), score: 35, breakdown: { hearts: 0, metal: 5, style: 15, budgetOccasion: 15 } },
  {
    name: "G10 override wins over low-confidence estimate",
    sku: sku("a", { attributes: { metal: "white_gold", metal_tone: "cool" } }),
    profile: profile({ undertoneEstimate: "warm", undertoneConfidence: 0.2, undertoneOverride: "cool" }),
    score: 40,
    breakdown: { hearts: 0, metal: 10, style: 15, budgetOccasion: 15 },
  },
  { name: "G11 override cool beats confident warm estimate", sku: sku("a"), profile: profile({ undertoneOverride: "cool" }), score: 37, breakdown: { hearts: 0, metal: 7, style: 15, budgetOccasion: 15 } },
  { name: "G12 round × long drop = recommended", sku: ear("a", "drop_long_narrow"), profile: profile({ faceShape: "Round" }), score: 40, breakdown: { hearts: 0, metal: 10, style: 15, budgetOccasion: 15 } },
  { name: "G13 round × large round hoop = avoid", sku: ear("a", "hoop_round_large"), profile: profile({ faceShape: "Round" }), score: 25, breakdown: { hearts: 0, metal: 10, style: 0, budgetOccasion: 15 } },
  { name: "G14 round × chandelier = acceptable, single source", sku: ear("a", "chandelier"), profile: profile({ faceShape: "Round" }), score: 34, breakdown: { hearts: 0, metal: 10, style: 9, budgetOccasion: 15 } },
  { name: "G15 oval × long drop = avoid", sku: ear("a", "drop_long_narrow"), profile: profile(), score: 25, breakdown: { hearts: 0, metal: 10, style: 0, budgetOccasion: 15 } },
  { name: "G16 square × geometric = avoid", sku: ear("a", "geometric_angular"), profile: profile({ faceShape: "Square" }), score: 25, breakdown: { hearts: 0, metal: 10, style: 0, budgetOccasion: 15 } },
  { name: "G17 heart × statement stud = avoid", sku: ear("a", "stud_statement"), profile: profile({ faceShape: "Heart" }), score: 25, breakdown: { hearts: 0, metal: 10, style: 0, budgetOccasion: 15 } },
  { name: "G18 unknown face → style midpoint", sku: sku("a"), profile: profile({ faceShape: "Unknown" }), score: 33, breakdown: { hearts: 0, metal: 10, style: 7.5, budgetOccasion: 15 } },
  {
    name: "G19 ring has no style rule",
    sku: sku("r", { category: "ring", attributes: { category: "ring", earring_shape: undefined } }),
    profile: profile(),
    score: 33,
    breakdown: { hearts: 0, metal: 10, style: 7.5, budgetOccasion: 15 },
  },
  { name: "G20 round × 24in necklace = recommended", sku: neck("n", "pendant_curved", 24), profile: profile({ faceShape: "Round" }), score: 40, breakdown: { hearts: 0, metal: 10, style: 15, budgetOccasion: 15 } },
  { name: "G21 round × 14in choker = avoid", sku: neck("n", "choker", 14), profile: profile({ faceShape: "Round" }), score: 25, breakdown: { hearts: 0, metal: 10, style: 0, budgetOccasion: 15 } },
  { name: "G22 heart × long V pendant = avoid, single source", sku: neck("n", "pendant_v_y", 24), profile: profile({ faceShape: "Heart" }), score: 29, breakdown: { hearts: 0, metal: 10, style: 3.8, budgetOccasion: 15 } },
  { name: "G23 10% over budget", sku: sku("a", { price: 330 }), profile: profile(), score: 36, breakdown: { hearts: 0, metal: 10, style: 15, budgetOccasion: 11.4 } },
  { name: "G24 33% over budget → no budget credit", sku: sku("a", { price: 400 }), profile: profile(), score: 31, breakdown: { hearts: 0, metal: 10, style: 15, budgetOccasion: 6 } },
  { name: "G25 20% under budget", sku: sku("a", { price: 120 }), profile: profile(), score: 33, breakdown: { hearts: 0, metal: 10, style: 15, budgetOccasion: 7.8 } },
  { name: "G26 occasion not tagged", sku: sku("a"), profile: profile(), request: request({ occasion: "graduation" }), score: 36, breakdown: { hearts: 0, metal: 10, style: 15, budgetOccasion: 11.4 } },
  { name: "G27 currency mismatch", sku: sku("a", { currency: "EUR" }), profile: profile(), score: 31, breakdown: { hearts: 0, metal: 10, style: 15, budgetOccasion: 6 } },
  { name: "G28 catalog-only preview (no profile)", sku: sku("a"), profile: null, score: 28, breakdown: { hearts: 0, metal: 5, style: 7.5, budgetOccasion: 15 } },
  {
    name: "G29 look-alike of a hearted piece",
    sku: sku("a"),
    profile: profile({ heartedSkuIds: ["b"] }),
    hearted: [sku("b")],
    score: 64,
    breakdown: { hearts: 24, metal: 10, style: 15, budgetOccasion: 15 },
  },
  {
    name: "G30 hearted piece too different → no look-alike credit",
    sku: sku("a"),
    profile: profile({ heartedSkuIds: ["b"] }),
    hearted: [sku("b", { attributes: { metal: "silver", metal_tone: "cool", style: "boho", earring_shape: "hoop_round_large" } })],
    score: 40,
    breakdown: { hearts: 0, metal: 10, style: 15, budgetOccasion: 15 },
  },
  {
    name: "G31 hearted beats poor styling",
    sku: sku("a", { price: 400, attributes: { earring_shape: "hoop_round_large" } }),
    profile: profile({ undertoneEstimate: "cool", faceShape: "Round", heartedSkuIds: ["a"] }),
    score: 73,
    breakdown: { hearts: 60, metal: 7, style: 0, budgetOccasion: 6 },
  },
  {
    name: "G32 partial look-alike (2/3 style overlap, same metal)",
    sku: sku("a"),
    profile: profile({ heartedSkuIds: ["b"] }),
    hearted: [sku("b", { attributes: { style: "classic boho" } })],
    score: 60,
    breakdown: { hearts: 20, metal: 10, style: 15, budgetOccasion: 15 },
  },
];

describe("fitScore golden cases", () => {
  it("has at least 30 golden cases", () => expect(GOLDEN.length).toBeGreaterThanOrEqual(30));

  it.each(GOLDEN)("$name", (g) => {
    const r = fitScore(g.profile, g.sku, g.request ?? request(), fakeRules, { heartedSkus: g.hearted });
    expect(r.score).toBe(g.score);
    expect(r.breakdown).toEqual(g.breakdown);
    expect(r.reasons).toHaveLength(2);
    expect(r.caution).toBeTruthy();
    for (const t of [...r.reasons, r.caution!]) expect(wordCount(t)).toBeLessThanOrEqual(20);
  });
});

describe("fitScore invariants", () => {
  it("publishes weights that sum to 100 with hearts the largest", () => {
    expect(FIT_MAX).toBe(100);
    const others = [FIT_WEIGHTS.metal, FIT_WEIGHTS.style, FIT_WEIGHTS.budgetOccasion];
    expect(FIT_WEIGHTS.hearts).toBeGreaterThan(Math.max(...others));
    expect(FIT_WEIGHTS.hearts).toBeGreaterThanOrEqual(others.reduce((a, b) => a + b, 0));
    expect(FIT_WEIGHTS_VERSION).toBe("fit-v1.1");
  });

  it("is deterministic", () => {
    const p = profile({ undertoneConfidence: 0.37, heartedSkuIds: ["b"] });
    const a = fitScore(p, sku("a"), request(), fakeRules, { heartedSkus: [sku("b")] });
    const b = fitScore(p, sku("a"), request(), fakeRules, { heartedSkus: [sku("b")] });
    expect(a).toEqual(b);
  });

  it("a hearted item outranks the identical un-hearted item", () => {
    const p = profile({ heartedSkuIds: ["x"] });
    const [first] = scoreSkus(p, [sku("y"), sku("x")], request(), fakeRules);
    expect(first.skuId).toBe("x");
  });

  it("hearts dominate: a hearted item with neutral styling beats an un-hearted perfect styling match", () => {
    const p = profile({ faceShape: "Round", heartedSkuIds: ["h"] });
    const hearted = fitScore(p, sku("h", { attributes: { earring_shape: "stud_small" } }), request(), fakeRules);
    const perfect = fitScore(p, sku("p", { attributes: { earring_shape: "drop_long_narrow" } }), request(), fakeRules);
    expect(hearted.score).toBeGreaterThan(perfect.score);
  });

  it("clamps out-of-range rule weights and confidence", () => {
    const wild = {
      ...fakeRules,
      metalFit: () => ({ strength: "recommended" as const, weight: 7, sources: [], singleSource: false }),
      styleFit: () => ({ strength: "avoid" as const, weight: -9, sources: [], singleSource: false }),
    };
    const r = fitScore(profile({ undertoneConfidence: Number.NaN }), sku("a"), request(), wild);
    expect(r.breakdown.metal).toBe(5);
    expect(r.breakdown.style).toBe(0);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
  });

  it("monotonic in confidence for a recommended metal", () => {
    const scores = [0, 0.25, 0.5, 0.75, 1].map((c) => fitScore(profile({ undertoneConfidence: c }), sku("a"), request(), fakeRules).raw);
    for (let i = 1; i < scores.length; i++) expect(scores[i]).toBeGreaterThan(scores[i - 1]);
  });

  it("calls out a low-confidence undertone estimate as the caution", () => {
    const r = fitScore(profile({ undertoneConfidence: 0.3 }), sku("a"), request(), fakeRules);
    expect(r.caution).toMatch(/low confidence/);
  });

  it("uses 'not hearted' as the caution once she hearted something else", () => {
    const r = fitScore(profile({ heartedSkuIds: ["zzz"] }), sku("a"), request(), fakeRules);
    expect(r.caution).toBe("They did not heart this piece during their try-on.");
  });

  it("matches the §3.3 demo phrasing: hearted, warm → yellow gold, oval → drops", () => {
    const r = fitScore(profile({ heartedSkuIds: ["halo"], undertoneConfidence: 0.8 }), sku("halo"), request(), fakeRules);
    expect(r.score).toBe(99); // 60 + 10 × (0.5 + 0.8 × 0.5) + 15 + 15
    expect(r.reasons[0]).toBe("They hearted this piece during their try-on.");
    expect(r.signals.map((s) => s.label)).toContain("warm undertone estimate → yellow gold: recommended");
    expect(r.signals.map((s) => s.label)).toContain("oval face → teardrop earrings: recommended");
  });

  it("toFitResult returns exactly the FitResult keys", () => {
    const r = toFitResult(fitScore(profile(), sku("a"), request(), fakeRules));
    expect(Object.keys(r).sort()).toEqual(["breakdown", "caution", "metal", "price", "reasons", "score", "skuId", "variantId"]);
    expect(Object.keys(r.breakdown).sort()).toEqual(["budgetOccasion", "hearts", "metal", "style"]);
  });
});

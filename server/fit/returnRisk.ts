/**
 * Return-Risk ESTIMATE (MASTER_PLAN v2 G8, Retailer Console). A published, benchmark-based model,
 * not a measured rate. Every default is editable and cites docs/research/market.md.
 *
 *   multiplier(score) = clamp(1 + maxReduction × (50 − score) / 50, 1 − maxReduction, 1 + maxReduction)
 *   P(return | score) = baselineRate × multiplier(score)
 *   expected cost     = P(return | score) × costPerReturn
 *   avoided cost      = (baselineRate − P(return | score)) × costPerReturn
 *
 * Assumptions (stated in the console next to the number):
 *  A1  A gift chosen without a Fit Request returns at the jewelry benchmark rate; that is a score of 50.
 *  A2  Return probability falls linearly with the Fit Score: score 100 halves it, score 0 raises it by
 *      half (maxReduction = 0.5). This effect size is OUR ASSUMPTION; no source measures it.
 *  A3  Cost per return is the all-in processing cost only; markdown loss on resale (only about 48% of
 *      returned jewelry resells at full price, market.md K5 / S31) is excluded, so the cost is conservative.
 *  A4  Benchmarks are US/2025–2026 secondary syntheses (grade C); they are directional.
 */

export interface ReturnRiskInputs {
  /** Baseline return probability of a gift chosen without a Fit Request (0..1). */
  baselineRate: number;
  /** All-in processing cost per returned item, in USD. */
  costPerReturn: number;
  /** Largest relative change the Fit Score can make to the baseline (0..1). */
  maxReduction: number;
}

/** Defaults: fine jewelry online midpoint 11% (market.md K3, S31) and $37 mid cost (K6, S5). */
export const RETURN_RISK_DEFAULTS: ReturnRiskInputs = { baselineRate: 0.11, costPerReturn: 37, maxReduction: 0.5 };

/** Alternative baselines the console can switch between; each cites market.md. */
export const RETURN_RATE_PRESETS = {
  fineJewelryOnline: { rate: 0.11, source: "market.md K3 (S31, Eightx 2026): fine jewelry online 8–15%, midpoint 10–12%" },
  holidayAllRetail: { rate: 0.17, source: "market.md H1 (S1/S20, NRF 2025): retailers expect 17% of holiday sales returned" },
  vendorJewelryBlended: { rate: 0.04, source: "market.md K1 (S30, Branvas 2026): blended online jewelry about 4.0%" },
} as const;

export const RETURN_COST_PRESETS = {
  low: { cost: 30, source: "market.md K6 (S5, Eightx 2026): jewelry and accessories $30 low" },
  mid: { cost: 37, source: "market.md K6 (S5, Eightx 2026): jewelry and accessories $37 mid" },
  high: { cost: 45, source: "market.md K6 (S5, Eightx 2026): jewelry and accessories $45 high" },
} as const;

export const RETURN_RISK_SOURCES = ["market.md K3 / S31", "market.md K6 / S5", "market.md K5 / S31 (excluded markdown loss)"] as const;

export const RETURN_RISK_FORMULA =
  "P(return) = baselineRate × clamp(1 + maxReduction × (50 − score) / 50, 1 − maxReduction, 1 + maxReduction); expected cost = P(return) × costPerReturn";

export const RETURN_RISK_LABEL = "Estimate from published benchmarks, not a measured return rate.";

export interface ReturnRiskEstimate {
  kind: "estimate";
  label: string;
  score: number;
  multiplier: number;
  probability: number;
  baselineProbability: number;
  expectedCost: number;
  baselineExpectedCost: number;
  avoidedCost: number;
  inputs: ReturnRiskInputs;
  sources: readonly string[];
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const round = (x: number, d = 4) => Math.round(x * 10 ** d) / 10 ** d;

function resolveInputs(partial: Partial<ReturnRiskInputs>): ReturnRiskInputs {
  const i = { ...RETURN_RISK_DEFAULTS, ...partial };
  if (!(i.baselineRate >= 0 && i.baselineRate <= 1)) throw new RangeError("baselineRate must be in [0, 1]");
  if (!(i.costPerReturn >= 0)) throw new RangeError("costPerReturn must be ≥ 0");
  if (!(i.maxReduction >= 0 && i.maxReduction <= 1)) throw new RangeError("maxReduction must be in [0, 1]");
  return i;
}

export function returnRiskMultiplier(score: number, maxReduction = RETURN_RISK_DEFAULTS.maxReduction): number {
  const s = clamp(Number.isFinite(score) ? score : 50, 0, 100);
  return clamp(1 + (maxReduction * (50 - s)) / 50, 1 - maxReduction, 1 + maxReduction);
}

export function estimateReturnRisk(score: number, inputs: Partial<ReturnRiskInputs> = {}): ReturnRiskEstimate {
  const i = resolveInputs(inputs);
  const multiplier = returnRiskMultiplier(score, i.maxReduction);
  const probability = clamp(i.baselineRate * multiplier, 0, 1);
  return {
    kind: "estimate",
    label: RETURN_RISK_LABEL,
    score: clamp(score, 0, 100),
    multiplier: round(multiplier),
    probability: round(probability),
    baselineProbability: i.baselineRate,
    expectedCost: round(probability * i.costPerReturn, 2),
    baselineExpectedCost: round(i.baselineRate * i.costPerReturn, 2),
    avoidedCost: round((i.baselineRate - probability) * i.costPerReturn, 2),
    inputs: i,
    sources: RETURN_RISK_SOURCES,
  };
}

export interface PortfolioReturnRisk {
  kind: "estimate";
  label: string;
  gifts: number;
  before: { rate: number; expectedReturns: number; expectedCost: number };
  after: { rate: number; expectedReturns: number; expectedCost: number };
  avoidedReturns: number;
  avoidedCost: number;
  inputs: ReturnRiskInputs;
  sources: readonly string[];
}

/** Before/after for the Retailer Console: before = no Fit Request (baseline), after = by Fit Score of the item bought. */
export function portfolioReturnRisk(scores: readonly number[], inputs: Partial<ReturnRiskInputs> = {}): PortfolioReturnRisk {
  const i = resolveInputs(inputs);
  const n = scores.length;
  const afterReturns = scores.reduce((sum, s) => sum + estimateReturnRisk(s, i).probability, 0);
  const beforeReturns = n * i.baselineRate;
  return {
    kind: "estimate",
    label: RETURN_RISK_LABEL,
    gifts: n,
    before: { rate: n ? i.baselineRate : 0, expectedReturns: round(beforeReturns, 2), expectedCost: round(beforeReturns * i.costPerReturn, 2) },
    after: { rate: n ? round(afterReturns / n) : 0, expectedReturns: round(afterReturns, 2), expectedCost: round(afterReturns * i.costPerReturn, 2) },
    avoidedReturns: round(beforeReturns - afterReturns, 2),
    avoidedCost: round((beforeReturns - afterReturns) * i.costPerReturn, 2),
    inputs: i,
    sources: RETURN_RISK_SOURCES,
  };
}

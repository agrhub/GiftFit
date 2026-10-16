import { describe, expect, it } from "vitest";
import {
  RETURN_COST_PRESETS,
  RETURN_RATE_PRESETS,
  RETURN_RISK_DEFAULTS,
  RETURN_RISK_SOURCES,
  estimateReturnRisk,
  portfolioReturnRisk,
  returnRiskMultiplier,
} from "../returnRisk";

describe("returnRisk (published estimate)", () => {
  it("defaults cite market.md: 11% fine-jewelry baseline (K3/S31), $37 mid cost (K6/S5)", () => {
    expect(RETURN_RISK_DEFAULTS).toEqual({ baselineRate: 0.11, costPerReturn: 37, maxReduction: 0.5 });
    expect(RETURN_RATE_PRESETS.fineJewelryOnline.source).toMatch(/K3.*S31/);
    expect(RETURN_RATE_PRESETS.holidayAllRetail).toMatchObject({ rate: 0.17 });
    expect(RETURN_COST_PRESETS.mid.source).toMatch(/K6.*S5/);
    expect(RETURN_RISK_SOURCES.join(" ")).toMatch(/S31.*S5/);
  });

  it("multiplier: 50 → 1×, 100 → 0.5×, 0 → 1.5×, clamped outside 0..100", () => {
    expect(returnRiskMultiplier(50)).toBe(1);
    expect(returnRiskMultiplier(100)).toBe(0.5);
    expect(returnRiskMultiplier(0)).toBe(1.5);
    expect(returnRiskMultiplier(150)).toBe(0.5);
    expect(returnRiskMultiplier(-5)).toBe(1.5);
    expect(returnRiskMultiplier(Number.NaN)).toBe(1);
    expect(returnRiskMultiplier(75)).toBeCloseTo(0.75);
  });

  it("golden: score 94 with defaults", () => {
    const r = estimateReturnRisk(94);
    // multiplier = 1 + 0.5 × (50 − 94) / 50 = 0.56 ; p = 0.11 × 0.56 = 0.0616
    expect(r.kind).toBe("estimate");
    expect(r.label).toMatch(/estimate/i);
    expect(r.multiplier).toBeCloseTo(0.56, 6);
    expect(r.probability).toBeCloseTo(0.0616, 6);
    expect(r.expectedCost).toBeCloseTo(2.28, 2); // 0.0616 × 37
    expect(r.baselineExpectedCost).toBeCloseTo(4.07, 2); // 0.11 × 37
    expect(r.avoidedCost).toBeCloseTo(1.79, 2);
  });

  it("is monotonic: higher Fit Score never raises return risk", () => {
    let prev = Infinity;
    for (let s = 0; s <= 100; s += 5) {
      const p = estimateReturnRisk(s).probability;
      expect(p).toBeLessThanOrEqual(prev);
      prev = p;
    }
  });

  it("accepts editable inputs and validates them", () => {
    expect(estimateReturnRisk(50, { baselineRate: 0.17, costPerReturn: 45 }).expectedCost).toBeCloseTo(7.65, 2);
    expect(estimateReturnRisk(100, { maxReduction: 0 }).probability).toBeCloseTo(0.11);
    expect(() => estimateReturnRisk(50, { baselineRate: 1.5 })).toThrow(RangeError);
    expect(() => estimateReturnRisk(50, { costPerReturn: -1 })).toThrow(RangeError);
    expect(() => estimateReturnRisk(50, { maxReduction: 2 })).toThrow(RangeError);
  });

  it("portfolio before/after for the Retailer Console", () => {
    const r = portfolioReturnRisk([94, 80, 50, 30]);
    expect(r.gifts).toBe(4);
    expect(r.before.expectedReturns).toBeCloseTo(0.44, 2);
    // multipliers 0.56, 0.7, 1.0, 1.2 → 0.11 × 3.46 = 0.3806
    expect(r.after.expectedReturns).toBeCloseTo(0.38, 2);
    expect(r.avoidedReturns).toBeCloseTo(0.06, 2);
    expect(r.avoidedCost).toBeCloseTo((0.44 - 0.3806) * 37, 1);
    expect(portfolioReturnRisk([]).after.rate).toBe(0);
  });
});

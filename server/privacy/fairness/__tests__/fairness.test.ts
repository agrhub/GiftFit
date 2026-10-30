import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { JewelryRules } from "@/server/contracts/giftfit";
import { naiveHueEstimator } from "../baseline";
import { hexToLab, labToHex } from "../color";
import { FITZPATRICK_ORDER, MST_SWATCHES, buildFairnessFixtures } from "../fixtures";
import { evaluateFairness, formatFairnessReport } from "../harness";
import { FIXTURES_FILE, fixturesFileContent } from "../run";

describe("fairness fixtures", () => {
  it("are committed and in sync with the generator", () => {
    expect(readFileSync(FIXTURES_FILE, "utf8").replace(/\r\n/g, "\n")).toBe(fixturesFileContent());
  });

  it("span Fitzpatrick I–VI with warm, neutral and cool variants at every depth", () => {
    const fx = buildFairnessFixtures();
    for (const g of FITZPATRICK_ORDER) {
      for (const label of ["warm", "neutral", "cool"] as const) {
        expect(fx.some((f) => f.fitzpatrick === g && f.label === label), `${g} ${label}`).toBe(true);
      }
    }
    expect(fx.filter((f) => f.family === "mst-rotation")).toHaveLength(MST_SWATCHES.length * 5);
    expect(fx.filter((f) => f.family === "depth-sweep")).toHaveLength(24);
    for (const f of fx) expect(f.hex).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("round-trip colors through CIELAB", () => {
    for (const s of MST_SWATCHES) expect(labToHex(hexToLab(s.hex))).toBe(s.hex);
    expect(labToHex({ L: 50, a: 120, b: 120 })).toBeNull();
  });
});

describe("evaluateFairness", () => {
  const fixtures = buildFairnessFixtures();

  it("catches an estimator that reads dark skin as cool", () => {
    const r = evaluateFairness(naiveHueEstimator, fixtures);
    expect(r.flags.some((f) => f.startsWith("DARKER_MISREAD_AS_COOLER"))).toBe(true);
    expect(r.flags.some((f) => f.startsWith("DARK_WARM_READ_AS_COOL"))).toBe(true);
    expect(r.sweeps.every((s) => s.deepCooler)).toBe(true);
    const v = r.groups.find((g) => g.group === "VI")!;
    expect(v.coolerRate).toBeGreaterThan(0.5);
    expect(formatFairnessReport(r)).toContain("DARKER_MISREAD_AS_COOLER");
  });

  it("does not flag a depth-blind estimator that follows the relative labels", () => {
    // Fixtures are evaluated in order; low-chroma tones can share a hex across labels, so answer by position.
    let i = 0;
    const oracle: Pick<JewelryRules, "estimateUndertone"> = {
      estimateUndertone: () => ({ undertone: fixtures[i++].label, confidence: 0.5, lab: { L: 0, a: 0, b: 0 }, hueDeg: 0 }),
    };
    const r = evaluateFairness(oracle, fixtures);
    expect(r.errors).toBe(0);
    expect(r.flags).toEqual([]);
    expect(r.depth.every((d) => d.separates && d.monotonicViolations === 0)).toBe(true);
  });

  it("runs against A10's server/verticals/jewelry.ts when it exists", async () => {
    const file = path.join(process.cwd(), "server", "verticals", "jewelry.ts");
    if (!existsSync(file)) return;
    const mod = (await import(/* @vite-ignore */ file)) as { jewelryRules?: JewelryRules };
    if (!mod.jewelryRules) return;
    const r = evaluateFairness(mod.jewelryRules, fixtures);
    expect(r.total).toBe(fixtures.length);
    expect(r.groups.map((g) => g.group)).toEqual(FITZPATRICK_ORDER);
    for (const res of r.results) {
      expect(["warm", "neutral", "cool"]).toContain(res.predicted);
      expect(res.confidence).toBeGreaterThanOrEqual(0);
      expect(res.confidence).toBeLessThanOrEqual(1);
    }
  });
});

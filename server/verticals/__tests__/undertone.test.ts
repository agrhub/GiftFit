import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Undertone } from "@/server/contracts/giftfit";
import {
  MST_HUE_ANCHORS,
  UNDERTONE_THRESHOLDS as T,
  chroma,
  classifyLab,
  estimateUndertone,
  hexToLab,
  hueAngleDeg,
  jewelryRules,
  labToHex,
  parseHex,
  referenceHue,
} from "@/server/verticals/jewelry";
import { MONK_SKIN_TONE, REFERENCE_SWATCHES, depthVariants } from "./undertone-fixtures";

const ORD: Record<Undertone, number> = { cool: 0, neutral: 1, warm: 2 };
const polar = (L: number, C: number, hDeg: number) => ({
  L,
  a: C * Math.cos((hDeg * Math.PI) / 180),
  b: C * Math.sin((hDeg * Math.PI) / 180),
});

describe("color conversion", () => {
  it("parses #rgb, #rrggbb, upper case and missing #; rejects junk", () => {
    expect(parseHex("#fff")).toEqual([255, 255, 255]);
    expect(parseHex("B9947C")).toEqual([185, 148, 124]);
    expect(() => parseHex("#12345")).toThrow(/invalid hex/);
    expect(() => parseHex("rgb(1,2,3)")).toThrow(/invalid hex/);
  });

  it("matches CIELAB (D65) reference values", () => {
    const white = hexToLab("#ffffff");
    expect(white.L).toBeCloseTo(100, 1);
    expect(Math.abs(white.a)).toBeLessThan(0.01);
    expect(Math.abs(white.b)).toBeLessThan(0.01);
    expect(hexToLab("#000000").L).toBeCloseTo(0, 5);
    // sRGB red: L* 53.24, a* 80.09, b* 67.20 (standard reference)
    const red = hexToLab("#ff0000");
    expect(red.L).toBeCloseTo(53.24, 1);
    expect(red.a).toBeCloseTo(80.09, 0);
    expect(red.b).toBeCloseTo(67.2, 0);
  });

  it("round-trips hex → Lab → hex for every MST swatch, and refuses out-of-gamut colors", () => {
    for (const s of MONK_SKIN_TONE) expect(labToHex(hexToLab(s.hex))).toBe(s.hex);
    expect(labToHex({ L: 95, a: 60, b: 60 })).toBeNull();
  });
});

describe("depth reference hue (MST anchors)", () => {
  it("passes through every anchor, interpolates between them and clamps outside", () => {
    for (const a of MST_HUE_ANCHORS) expect(referenceHue(a.L)).toBeCloseTo(a.h, 6);
    expect(referenceHue(36.6)).toBeCloseTo((48.8 + 59.0) / 2, 1);
    expect(referenceHue(5)).toBe(67.2);
    expect(referenceHue(99)).toBe(79.3);
  });

  it("matches the MST swatches it was built from (each within 1° of its own hue, MST 1–3 merged)", () => {
    for (const s of MONK_SKIN_TONE.filter((x) => x.mst >= 4)) {
      const lab = hexToLab(s.hex);
      expect(Math.abs(referenceHue(lab.L) - hueAngleDeg(lab))).toBeLessThan(1);
    }
  });
});

describe("estimateUndertone: calibration fixtures", () => {
  it.each(MONK_SKIN_TONE)("MST $mst (Fitzpatrick ≈ $fitzpatrick) keeps its calibrated output", (s) => {
    const e = estimateUndertone({ skin_color: s.hex });
    expect({ undertone: e.undertone, confidence: e.confidence }).toEqual(s.observed);
  });

  it.each(REFERENCE_SWATCHES)("$note ($hex) never reads the opposite of $direction", (s) => {
    const u = estimateUndertone({ skin_color: s.hex }).undertone;
    expect(u).not.toBe(s.direction === "cool" ? "warm" : "cool");
  });

  it("reads every rosy reference swatch as cool, from very light to deep", () => {
    for (const s of REFERENCE_SWATCHES.filter((x) => x.direction === "cool")) expect(estimateUndertone({ skin_color: s.hex }).undertone).toBe("cool");
  });

  const variants = depthVariants();
  it("builds a cooler, reference and warmer variant at all 10 MST depths (Fitzpatrick I–VI)", () => {
    expect(variants).toHaveLength(30);
    expect(new Set(variants.map((v) => v.fitzpatrick))).toEqual(new Set(["I", "II", "III", "IV", "V", "VI"]));
  });

  it("reads the typical hue of every depth as neutral", () => {
    for (const v of variants.filter((x) => x.expected === "neutral")) expect(estimateUndertone({ skin_color: v.hex }).undertone).toBe("neutral");
  });

  it("separates warmer from cooler at every depth and never reads a variant as its opposite", () => {
    for (const mst of new Set(variants.map((v) => v.mst))) {
      const row = variants.filter((v) => v.mst === mst);
      const get = (e: Undertone) => estimateUndertone({ skin_color: row.find((v) => v.expected === e)!.hex }).undertone;
      expect(ORD[get("warm")]).toBeGreaterThan(ORD[get("cool")]);
      expect(get("warm")).not.toBe("cool");
      expect(get("cool")).not.toBe("warm");
    }
  });

  const outsideUnsure = (hex: string) => {
    const h = hueAngleDeg(hexToLab(hex));
    return h < T.unsureLoDeg || h > T.unsureHiDeg;
  };

  it("reads warm variants warm wherever their hue is outside the real-API unsure band", () => {
    const vs = variants.filter((x) => x.expected === "warm" && outsideUnsure(x.hex));
    expect(vs.length).toBeGreaterThanOrEqual(9);
    for (const v of vs) expect(estimateUndertone({ skin_color: v.hex }).undertone).toBe("warm");
  });

  it("calls deep cool variants cool outside the unsure band (MST 7–10), so depth does not hide coolness either", () => {
    const vs = variants.filter((x) => x.expected === "cool" && x.mst >= 7 && outsideUnsure(x.hex));
    expect(vs).toHaveLength(4);
    for (const v of vs) expect(estimateUndertone({ skin_color: v.hex }).undertone).toBe("cool");
  });
});

describe("estimateUndertone: darker ≠ cooler", () => {
  it("never reads a V–VI variant as its opposite; any cooler-than-labelled read there is a low-confidence neutral", () => {
    for (const v of variants().filter((x) => x.fitzpatrick === "V" || x.fitzpatrick === "VI")) {
      const e = estimateUndertone({ skin_color: v.hex });
      expect(Math.abs(ORD[e.undertone] - ORD[v.expected])).toBeLessThan(2);
      if (ORD[e.undertone] < ORD[v.expected]) expect(e).toMatchObject({ undertone: "neutral", confidence: T.lowConfidence });
    }
  });

  it("passes A5's independent fairness fixtures (fixtures/fairness): no flagged cooler gap and no confident errors on V–VI", () => {
    const file = path.join(process.cwd(), "fixtures", "fairness", "skin-tones.json");
    const fx = (JSON.parse(readFileSync(file, "utf8")) as { fixtures: { hex: string; label: Undertone; fitzpatrick: string }[] }).fixtures;
    const stats = (groups: string[]) => {
      const rs = fx.filter((f) => groups.includes(f.fitzpatrick)).map((f) => ({ f, e: estimateUndertone({ skin_color: f.hex }) }));
      return {
        cooler: rs.filter(({ f, e }) => ORD[e.undertone] < ORD[f.label]).length / rs.length,
        coolerAboveLow: rs.filter(({ f, e }) => ORD[e.undertone] < ORD[f.label] && e.confidence > 0.3).length,
        confidentErrors: rs.filter(({ f, e }) => e.undertone !== f.label && e.confidence >= 0.6).length,
        warmToCool: rs.filter(({ f, e }) => f.label === "warm" && e.undertone === "cool").length,
      };
    };
    const dark = stats(["V", "VI"]);
    // A5's DARKER_MISREAD_AS_COOLER flag compares V–VI with I–II (gap ≥ 10 points).
    expect(dark.cooler - stats(["I", "II"]).cooler).toBeLessThan(0.1);
    expect(dark.coolerAboveLow).toBe(0);
    expect(dark.confidentErrors).toBe(0);
    expect(dark.warmToCool).toBe(0);
  });

  it("applies the real-API unsure band identically at every depth (L* 15–95)", () => {
    for (const h of [T.unsureLoDeg, 58, 61, 64, T.unsureHiDeg]) {
      for (const L of [15, 30, 45, 60, 75, 95]) expect(classifyLab(polar(L, 18, h))).toMatchObject({ undertone: "neutral", confidence: T.lowConfidence });
    }
  });

  it("a colour at the same offset from its depth's typical hue gets the same label at L* 20–55 (outside the unsure band)", () => {
    for (const [shift, label] of [[-12, "cool"], [0, "neutral"], [12, "warm"]] as const) {
      for (const L of [20, 30, 42.5, 55]) {
        const h = referenceHue(L) + shift;
        if (h >= T.unsureLoDeg && h <= T.unsureHiDeg) continue;
        expect(classifyLab(polar(L, 18, h)).undertone).toBe(label);
      }
    }
  });

  it("deep skin (L* ≈ 21) can be warm, neutral or cool", () => {
    const got = [14, 0, -14].map((d) => classifyLab(polar(21.1, 16, referenceHue(21.1) + d)).undertone);
    expect(got).toEqual(["warm", "neutral", "cool"]);
  });
});

describe("estimateUndertone: thresholds and confidence", () => {
  it("applies the documented relative band around the depth reference", () => {
    const L = 55.1; // MST 6 depth, reference ≈ 73.8°, inside the absolute warm zone
    const r = referenceHue(L);
    expect(classifyLab(polar(L, 20, r + T.relativeBandDeg - 0.1)).undertone).toBe("neutral");
    expect(classifyLab(polar(L, 20, r + T.relativeBandDeg + 0.1)).undertone).toBe("warm");
    expect(classifyLab(polar(L, 20, r - T.relativeBandDeg + 0.1)).undertone).toBe("neutral");
  });

  it("returns neutral with low confidence when the relative and absolute readings are opposite", () => {
    // Light depth (reference ≈ 85°): a golden 75° is "cooler than typical" but absolutely warm.
    const e = classifyLab(polar(88, 20, 75));
    expect(e).toMatchObject({ undertone: "neutral", confidence: T.lowConfidence });
  });

  it("returns neutral with low confidence for near-grey and non-skin hues", () => {
    expect(classifyLab(polar(50, T.minChroma - 0.5, 80))).toMatchObject({ undertone: "neutral", confidence: T.lowConfidence });
    expect(estimateUndertone({ skin_color: "#808080" })).toMatchObject({ undertone: "neutral", confidence: 0.2 });
    expect(estimateUndertone({ skin_color: "#7f7fff" })).toMatchObject({ undertone: "neutral", confidence: 0.2 });
  });

  it("confidence grows with margin and chroma, drops where the depth reference is uncertain, and is capped", () => {
    const L = 55.1;
    const r = referenceHue(L);
    const c = (shift: number, C = 20, l = L) => classifyLab(polar(l, C, referenceHue(l) + shift)).confidence;
    expect(c(8)).toBeLessThan(c(14));
    expect(c(14, 6)).toBeLessThan(c(14, 20));
    expect(c(14, 20, 30.7)).toBeLessThan(c(14, 20, 55.1)); // MST 8 depth: reference 25° from the median
    expect(r).toBeCloseTo(73.8, 1);
    for (const s of [-20, -14, 0, 14, 20]) for (const l of [20, 40, 60, 80]) expect(c(s, 60, l)).toBeLessThanOrEqual(T.maxConfidence);
  });

  it("returns lab and hueDeg for audits, consistent with the helpers", () => {
    const e = estimateUndertone({ skin_color: "#b9947c" });
    const lab = hexToLab("#b9947c");
    expect(e.hueDeg).toBeCloseTo(hueAngleDeg(lab), 1);
    expect(e.lab.L).toBeCloseTo(lab.L, 1);
    expect(chroma(e.lab)).toBeCloseTo(chroma(lab), 1);
  });

  it("is pure and deterministic, and ignores lip / eyebrow / hair colors", () => {
    const colors = { skin_color: "#c68e7a", lip_color: "#D23245", eyebrow_color: "#5B2B31", hair_color: "#FAF0BE" };
    const frozen = Object.freeze({ ...colors });
    const a = jewelryRules.estimateUndertone(frozen);
    expect(jewelryRules.estimateUndertone(frozen)).toEqual(a);
    expect(estimateUndertone({ skin_color: "#c68e7a" })).toEqual(a);
    expect(estimateUndertone({ ...colors, lip_color: "#f0a0a0", eyebrow_color: "#222222" })).toEqual(a);
  });

  it("throws on a malformed skin_color rather than guessing", () => {
    expect(() => estimateUndertone({ skin_color: "not-a-color" })).toThrow();
  });
});

/**
 * Real Facial Color Tones `skin_color` for 5 AI-generated portraits (fictional people; values published in
 * docs/research/fairness_real_api.md, ADR-028). Labels are the PROMPT-intended undertone, not a measurement.
 */
const REAL_API_SAMPLES: { id: string; skin: string; intended: Undertone }[] = [
  { id: "FZ I fair", skin: "#c1a28c", intended: "cool" },
  { id: "FZ III light-medium", skin: "#b39075", intended: "warm" },
  { id: "FZ IV olive", skin: "#ae886d", intended: "neutral" },
  { id: "FZ V deep", skin: "#6e4d38", intended: "warm" },
  { id: "FZ VI deep", skin: "#624838", intended: "cool" },
];

describe("estimateUndertone: real API output (5 AI portraits)", () => {
  it.each(REAL_API_SAMPLES)("$id ($skin, intended $intended) is never confidently wrong", (s) => {
    const e = estimateUndertone({ skin_color: s.skin });
    if (e.undertone !== s.intended) expect(e.confidence).toBeLessThanOrEqual(0.3);
  });

  it("returns neutral at ≤ 0.3 for all five: their hues (57.9–64.3°) sit inside the unsure band", () => {
    for (const s of REAL_API_SAMPLES) {
      const e = estimateUndertone({ skin_color: s.skin });
      expect(e.hueDeg).toBeGreaterThanOrEqual(T.unsureLoDeg);
      expect(e.hueDeg).toBeLessThanOrEqual(T.unsureHiDeg);
      expect(e).toMatchObject({ undertone: "neutral" });
      expect(e.confidence).toBeLessThanOrEqual(0.3);
    }
  });
});

function variants() {
  return depthVariants();
}

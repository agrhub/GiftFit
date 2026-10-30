/**
 * Undertone calibration fixtures (A10). A5's independent fairness fixtures live in fixtures/fairness/.
 *
 * 1. MONK_SKIN_TONE: the 10 Monk Skin Tone (MST) scale swatches, Google / Dr. Ellis Monk, published at
 *    https://skintone.google (CC BY 4.0). MST spans depth and publishes NO undertone labels; v2 of the
 *    estimator uses these swatches as the "typical hue at this depth" reference, so each swatch is
 *    expected to read neutral or close to it (`observed` is locked by test). `fitzpatrick` is our
 *    approximate correspondence for coverage bookkeeping only (no official MST ↔ Fitzpatrick mapping).
 * 2. REFERENCE_SWATCHES: rosy and golden skin hexes. The golden ones are a widely circulated web
 *    "skin tone" palette with no authoritative source; the rosy ones are ours. Their labels are only
 *    directional (rosy must never read warm, golden must never read cool): no ground truth exists.
 * 3. depthVariants(): at every MST depth L*, the reference hue ref(L*) rotated −14° (cooler), 0° and
 *    +14° (warmer) at chroma 16 (lowered until in sRGB gamut), labelled by construction.
 */
import { hexToLab, labToHex, referenceHue } from "@/server/verticals/jewelry";
import type { Undertone } from "@/server/contracts/giftfit";

export type Fitzpatrick = "I" | "II" | "III" | "IV" | "V" | "VI";

export interface MstSwatch {
  mst: number;
  hex: string;
  fitzpatrick: Fitzpatrick;
  observed: { undertone: Undertone; confidence: number };
}

export const MONK_SKIN_TONE: MstSwatch[] = [
  { mst: 1, hex: "#f6ede4", fitzpatrick: "I", observed: { undertone: "neutral", confidence: 0.17 } },
  { mst: 2, hex: "#f3e7db", fitzpatrick: "I", observed: { undertone: "neutral", confidence: 0.2 } },
  { mst: 3, hex: "#f7ead0", fitzpatrick: "II", observed: { undertone: "warm", confidence: 0.69 } },
  { mst: 4, hex: "#eadaba", fitzpatrick: "III", observed: { undertone: "neutral", confidence: 0.18 } },
  { mst: 5, hex: "#d7bd96", fitzpatrick: "III", observed: { undertone: "neutral", confidence: 0.36 } },
  { mst: 6, hex: "#a07e56", fitzpatrick: "IV", observed: { undertone: "neutral", confidence: 0.44 } },
  { mst: 7, hex: "#825c43", fitzpatrick: "V", observed: { undertone: "neutral", confidence: 0.2 } },
  { mst: 8, hex: "#604134", fitzpatrick: "V", observed: { undertone: "neutral", confidence: 0.18 } },
  { mst: 9, hex: "#3a312a", fitzpatrick: "VI", observed: { undertone: "neutral", confidence: 0.2 } },
  { mst: 10, hex: "#292420", fitzpatrick: "VI", observed: { undertone: "neutral", confidence: 0.2 } },
];

export interface ReferenceSwatch {
  hex: string;
  direction: "cool" | "warm";
  note: string;
}

export const REFERENCE_SWATCHES: ReferenceSwatch[] = [
  { hex: "#ffdbcf", direction: "cool", note: "very light rosy" },
  { hex: "#f2c6b4", direction: "cool", note: "light rosy" },
  { hex: "#e8b9a7", direction: "cool", note: "light-medium rosy" },
  { hex: "#c68e7a", direction: "cool", note: "medium rosy" },
  { hex: "#8d5544", direction: "cool", note: "deep rosy" },
  { hex: "#ffdbac", direction: "warm", note: "very light golden" },
  { hex: "#f1c27d", direction: "warm", note: "light golden" },
  { hex: "#e0ac69", direction: "warm", note: "medium golden" },
  { hex: "#c68642", direction: "warm", note: "tan golden" },
  { hex: "#8d5524", direction: "warm", note: "deep golden" },
];

/** Hue rotation from the depth reference used to build labelled variants. */
export const VARIANT_SHIFTS: Record<Undertone, number> = { cool: -14, neutral: 0, warm: 14 };

export interface DepthVariant {
  mst: number;
  fitzpatrick: Fitzpatrick;
  expected: Undertone;
  hex: string;
  L: number;
  chroma: number;
}

export function depthVariants(): DepthVariant[] {
  const out: DepthVariant[] = [];
  for (const s of MONK_SKIN_TONE) {
    const { L } = hexToLab(s.hex);
    for (const [expected, shift] of Object.entries(VARIANT_SHIFTS) as [Undertone, number][]) {
      const rad = ((referenceHue(L) + shift) * Math.PI) / 180;
      for (let C = 16; C >= 4; C--) {
        const hex = labToHex({ L, a: C * Math.cos(rad), b: C * Math.sin(rad) });
        if (hex) {
          out.push({ mst: s.mst, fitzpatrick: s.fitzpatrick, expected, hex, L, chroma: C });
          break;
        }
      }
    }
  }
  return out;
}

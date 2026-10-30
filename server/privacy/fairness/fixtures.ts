/**
 * Undertone fairness fixtures (owner: A5). `buildFairnessFixtures()` is deterministic;
 * fixtures/fairness/skin-tones.json is its committed output (a test keeps them in sync).
 * Regenerate: npx tsx server/privacy/fairness/run.ts --write-fixtures
 *
 * Source swatches: the Monk Skin Tone (MST) Scale, 10 tones, Dr. Ellis Monk with Google,
 * https://skintone.google (CC BY 4.0). MST measures depth, not undertone, and has no official
 * Fitzpatrick mapping; the Fitzpatrick column below is our approximate correspondence, used only
 * to group results I–VI.
 *
 * Ground truth is BY CONSTRUCTION and RELATIVE: "neutral" is the hue of the reference tone,
 * "warm" is rotated toward yellow (+h*), "cool" toward red/pink (−h*). No photo-labelled dataset
 * with undertone labels across Fitzpatrick I–VI is available to us, so this checks that the
 * derivation treats every depth the same way, not that it matches a human colourist.
 *
 * Families:
 *  - mst-rotation: each MST tone at its own L* and C*, hue rotated −14/−8/0/+8/+14°.
 *  - depth-sweep: one hue per label (MST median hue ±14°) at fixed C* = 14 for L* 90→20.
 *    Same color, only darker: any change of label along a sweep is depth bias.
 */
import type { Undertone } from "@/server/contracts/giftfit";
import { chroma, fromLch, hexToLab, hueDeg, labToHex } from "./color";

export type Fitzpatrick = "I" | "II" | "III" | "IV" | "V" | "VI";
export const FITZPATRICK_ORDER: Fitzpatrick[] = ["I", "II", "III", "IV", "V", "VI"];

export const MST_SWATCHES: Array<{ mst: number; hex: string; fitzpatrick: Fitzpatrick }> = [
  { mst: 1, hex: "#f6ede4", fitzpatrick: "I" },
  { mst: 2, hex: "#f3e7db", fitzpatrick: "I" },
  { mst: 3, hex: "#f7ead0", fitzpatrick: "II" },
  { mst: 4, hex: "#eadaba", fitzpatrick: "III" },
  { mst: 5, hex: "#d7bd96", fitzpatrick: "III" },
  { mst: 6, hex: "#a07e56", fitzpatrick: "IV" },
  { mst: 7, hex: "#825c43", fitzpatrick: "V" },
  { mst: 8, hex: "#604134", fitzpatrick: "V" },
  { mst: 9, hex: "#3a312a", fitzpatrick: "VI" },
  { mst: 10, hex: "#292420", fitzpatrick: "VI" },
];

export const SOURCE = {
  name: "Monk Skin Tone Scale (Dr. Ellis Monk, Google)",
  url: "https://skintone.google",
  license: "CC BY 4.0",
  fitzpatrickMapping: "approximate, ours (no official MST to Fitzpatrick mapping)",
};

export interface FairnessFixture {
  id: string;
  family: "mst-rotation" | "depth-sweep";
  hex: string;
  label: Undertone;
  /** Hue shift from the reference hue, degrees (negative = cooler). */
  shiftDeg: number;
  fitzpatrick: Fitzpatrick;
  mst: number;
  L: number;
  C: number;
}

const round2 = (x: number) => Math.round(x * 100) / 100;
const SHIFTS: Array<[number, Undertone]> = [
  [-14, "cool"],
  [-8, "cool"],
  [0, "neutral"],
  [8, "warm"],
  [14, "warm"],
];

/** Puts a LAB color in gamut by lowering chroma in 0.25 steps (hue and L* kept). */
function inGamut(L: number, C: number, h: number): { hex: string; C: number } {
  for (let c = C; c >= 0; c -= 0.25) {
    const hex = labToHex(fromLch(L, c, h));
    if (hex) return { hex, C: c };
  }
  throw new Error(`no in-gamut color for L*=${L}`);
}

function nearestMst(L: number) {
  let best = MST_SWATCHES[0];
  let bestD = Infinity;
  for (const s of MST_SWATCHES) {
    const d = Math.abs(hexToLab(s.hex).L - L);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

export function mstMedianHue(): number {
  const hs = MST_SWATCHES.map((s) => hueDeg(hexToLab(s.hex))).sort((a, b) => a - b);
  return (hs[4] + hs[5]) / 2;
}

export function buildFairnessFixtures(): FairnessFixture[] {
  const out: FairnessFixture[] = [];
  for (const s of MST_SWATCHES) {
    const lab = hexToLab(s.hex);
    const h0 = hueDeg(lab);
    const C0 = chroma(lab);
    for (const [shift, label] of SHIFTS) {
      const g = shift === 0 ? { hex: s.hex, C: C0 } : inGamut(lab.L, C0, h0 + shift);
      out.push({
        id: `mst${s.mst}-${shift >= 0 ? "p" : "m"}${Math.abs(shift)}`,
        family: "mst-rotation",
        hex: g.hex,
        label,
        shiftDeg: shift,
        fitzpatrick: s.fitzpatrick,
        mst: s.mst,
        L: round2(lab.L),
        C: round2(g.C),
      });
    }
  }
  const hMid = mstMedianHue();
  for (const [shift, label] of [SHIFTS[0], SHIFTS[2], SHIFTS[4]]) {
    for (let L = 90; L >= 20; L -= 10) {
      const g = inGamut(L, 14, hMid + shift);
      const m = nearestMst(L);
      out.push({
        id: `sweep-${label}-L${L}`,
        family: "depth-sweep",
        hex: g.hex,
        label,
        shiftDeg: shift,
        fitzpatrick: m.fitzpatrick,
        mst: m.mst,
        L,
        C: round2(g.C),
      });
    }
  }
  return out;
}

/**
 * Jewelry vertical rules for GiftFit (owner: A10). Pure and deterministic: no I/O, no clock, no randomness.
 *
 * Exports `jewelryRules: JewelryRules` (lib/contracts/giftfit.ts), consumed by A3 (lib/fit) by injection
 * and audited by A5 (fairness report). Three parts:
 *
 * 1. `estimateUndertone`: Facial Color Tones `skin_color` hex (sRGB, D65 assumed) → CIELAB → hue angle
 *    h* = atan2(b*, a*), read RELATIVE to the typical skin hue at the same depth L* (Monk Skin Tone
 *    anchors), with an absolute-hue cross-check that turns contradictory readings into "neutral". A
 *    colour that is typical for its depth is neutral at every depth ("darker ≠ cooler",
 *    jewelry_rules.md §5.1; v2 after A5's fairness harness flagged v1's fixed cut-offs). Chroma and
 *    reference uncertainty only lower the confidence. v3 (real-API recalibration, ADR-028): real
 *    `skin_color` output for very different people sits in a narrow hue band (57.9–64.3° on 5 AI
 *    portraits), so hues in the "unsure band" 55–67° return neutral at confidence 0.2 at every depth;
 *    the priority is "no confident miss", not accuracy. Thresholds are OUR OWN HEURISTIC: no published
 *    warm/cool cut-offs exist (ADR-013). Calibration: docs/reports/A10.md ("Real-API recalibration")
 *    and lib/verticals/__tests__/undertone-fixtures.ts.
 * 2. `METAL_UNDERTONE`: metal ↔ undertone (jewelry_rules.md Table 1). No metal is ever "avoid"; implied
 *    opposite pairings are "acceptable" with weight 0.4 (ADR-013).
 * 3. `EARRING_FACE` / `NECKLACE_FACE`: style ↔ face shape (jewelry_rules.md Tables 2a, 2b). Single-source
 *    rows are flagged and their weight is halved; an "avoid" row is applied only when ≥ 2 sources agree
 *    and the row is not single-source (ADR-013), otherwise it degrades to "none" (weight 0) but keeps its
 *    sources so A3 can still explain why nothing was applied. `InvTriangle` reuses the Heart rows (+ E7
 *    extras for earrings); every `Triangle` row is flagged single-source because the API label's meaning
 *    is unverified. `Unknown` always yields strength "none".
 *
 * This is stylist and retailer convention, not science. UI copy says "styling suggestion".
 */
import type {
  EarringShape,
  FaceShape,
  FacialColors,
  GiftFitAttributes,
  JewelryRules,
  Metal,
  MetalTone,
  NecklaceStyle,
  RuleScore,
  RuleStrength,
  Undertone,
  UndertoneEstimate,
} from "@/lib/contracts/giftfit";

// ---------------------------------------------------------------------------------------------------
// Color science (sRGB D65 → CIE XYZ → CIELAB, D65 reference white, CIE 2° observer)
// ---------------------------------------------------------------------------------------------------

export interface Lab {
  L: number;
  a: number;
  b: number;
}

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Parses `#rgb` / `#rrggbb` (case-insensitive, `#` optional). Throws on anything else. */
export function parseHex(hex: string): [number, number, number] {
  const m = HEX_RE.exec(hex.trim());
  if (!m) throw new Error(`invalid hex color: ${JSON.stringify(hex)}`);
  let h = m[1];
  if (h.length === 3) h = h.replace(/./g, (c) => c + c);
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const D65 = { X: 0.95047, Y: 1.0, Z: 1.08883 };
const EPS = 216 / 24389;
const KAPPA = 24389 / 27;

const srgbToLinear = (c8: number): number => {
  const c = c8 / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const linearToSrgb = (c: number): number => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055) * 255;

export function hexToLab(hex: string): Lab {
  const [r8, g8, b8] = parseHex(hex);
  const r = srgbToLinear(r8);
  const g = srgbToLinear(g8);
  const b = srgbToLinear(b8);
  const X = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / D65.X;
  const Y = (0.2126729 * r + 0.7151522 * g + 0.072175 * b) / D65.Y;
  const Z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / D65.Z;
  const f = (t: number) => (t > EPS ? Math.cbrt(t) : (KAPPA * t + 16) / 116);
  const fx = f(X);
  const fy = f(Y);
  const fz = f(Z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

/**
 * CIELAB → sRGB hex (for fixtures and fairness reports). Returns null when the color is outside the
 * sRGB gamut by more than half an 8-bit step, so fixture builders never silently clip.
 */
export function labToHex(lab: Lab): string | null {
  const fy = (lab.L + 16) / 116;
  const fx = fy + lab.a / 500;
  const fz = fy - lab.b / 200;
  const inv = (t: number) => (t ** 3 > EPS ? t ** 3 : (116 * t - 16) / KAPPA);
  const X = inv(fx) * D65.X;
  const Y = lab.L > KAPPA * EPS ? fy ** 3 : lab.L / KAPPA;
  const Z = inv(fz) * D65.Z;
  const rl = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
  const gl = -0.969266 * X + 1.8760108 * Y + 0.041556 * Z;
  const bl = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;
  const out: number[] = [];
  for (const c of [rl, gl, bl]) {
    const v = linearToSrgb(Math.max(0, c));
    if (c < -0.002 || v > 255.5) return null;
    out.push(Math.min(255, Math.max(0, Math.round(v))));
  }
  return `#${out.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** Hue angle h* in degrees, 0..360. */
export const hueAngleDeg = (lab: Lab): number => {
  const h = (Math.atan2(lab.b, lab.a) * 180) / Math.PI;
  return h < 0 ? h + 360 : h;
};
/** Chroma C* = sqrt(a*² + b*²). */
export const chroma = (lab: Lab): number => Math.hypot(lab.a, lab.b);

// ---------------------------------------------------------------------------------------------------
// Undertone estimate: depth-relative hue, documented thresholds (our heuristic, docs/reports/A10.md)
// ---------------------------------------------------------------------------------------------------

/**
 * Reference ("typical") skin hue per depth: the Monk Skin Tone scale swatches (Dr. Ellis Monk / Google,
 * https://skintone.google, CC BY 4.0) as (L*, h*) anchors. MST 1–3 lie within 2 L* units of each other,
 * so they are merged into one anchor (mean L*, mean h*). Between anchors the reference is linearly
 * interpolated; outside it is clamped. Rationale: typical skin hue changes with depth (on the MST deep
 * tones a* rises relative to b*, so h* drops to ~49° at L* ≈ 31). A fixed hue cut-off therefore reads
 * typical deep skin as "cool", the "darker misread as cooler" failure A5's fairness harness caught in
 * v1. Measuring hue RELATIVE to the typical hue at the same depth removes that systematic shift.
 */
export const MST_HUE_ANCHORS: readonly { L: number; h: number; mst: string }[] = [
  { L: 14.6, h: 67.2, mst: "10" },
  { L: 21.1, h: 65.7, mst: "9" },
  { L: 30.7, h: 48.8, mst: "8" },
  { L: 42.5, h: 59.0, mst: "7" },
  { L: 55.1, h: 73.8, mst: "6" },
  { L: 77.9, h: 81.5, mst: "5" },
  { L: 87.6, h: 88.5, mst: "4" },
  { L: 93.2, h: 79.3, mst: "1-3" },
];

/** Population reference hue: the median h* of the 10 MST swatches (73.8°, 74.2° → 74.0°). */
export const MST_MEDIAN_HUE = 74;

/** Typical skin hue at depth L* (piecewise-linear over MST_HUE_ANCHORS, clamped at the ends). */
export function referenceHue(L: number): number {
  const a = MST_HUE_ANCHORS;
  if (L <= a[0].L) return a[0].h;
  for (let i = 1; i < a.length; i++) {
    if (L <= a[i].L) {
      const t = (L - a[i - 1].L) / (a[i].L - a[i - 1].L);
      return a[i - 1].h + t * (a[i].h - a[i - 1].h);
    }
  }
  return a[a.length - 1].h;
}

export const UNDERTONE_THRESHOLDS = {
  /**
   * v3 "unsure band" from REAL Facial Color Tones output (docs/research/fairness_real_api.md, ADR-028):
   * five AI portraits spanning intended Fitzpatrick I–VI and cool/neutral/warm returned `skin_color` hues of
   * only 57.9–64.3° (L* 33–69), with the deep warm and deep cool subjects 0.3° apart. Inside this band a
   * single face hex cannot separate warm from cool, so 55° ≤ h* ≤ 67° (the observed range padded by
   * ~3° for n = 5) → neutral at `lowConfidence`, at every depth. Heuristic, not a measured boundary.
   */
  unsureLoDeg: 55,
  unsureHiDeg: 67,
  /** Neutral half-band around the depth reference: |h* − ref(L*)| ≤ 5° → neutral. */
  relativeBandDeg: 5,
  /**
   * Absolute cross-check (the v1 thresholds): h* < 50° reads cool, h* > 62° warm. Calibrated as the gap
   * between rosy (h* 42.8–48.9°) and golden (63.1–78.4°) reference swatches. Used only as a veto and a
   * confidence input: when the depth-relative and absolute readings point in OPPOSITE directions (one
   * warm, one cool), warm and cool are not separable for this colour, so the answer is neutral.
   */
  absoluteCoolMaxDeg: 50,
  absoluteWarmMinDeg: 62,
  /** Below this chroma the hue angle is meaningless: neutral, low confidence. */
  minChroma: 2,
  /** Chroma at and above which chroma no longer limits confidence. */
  fullChroma: 12,
  /** Distance (deg) beyond the neutral band edge at which the margin term is full. */
  marginFullDeg: 8,
  /**
   * Reference uncertainty: where the depth reference is far from the population median hue (MST deep
   * tones 7–8, light tones 3–5), "typical" is itself uncertain, so confidence is scaled by
   * clamp(1 − (|ref(L*) − 74°| − 5°) / 15°, 0.4, 1).
   */
  spreadFreeDeg: 5,
  spreadScaleDeg: 15,
  minSpreadFactor: 0.4,
  /** Confidence multiplier when one reading is neutral and the other is not. */
  partialAgreement: 0.6,
  /** Confidence for vetoed (opposite) readings and for near-grey colours. */
  lowConfidence: 0.2,
  /** Confidence is never reported above this: it is an estimate from one photo (the UI keeps an override). */
  maxConfidence: 0.9,
} as const;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

/**
 * Estimate the undertone from Facial Color Tones colors. Only `skin_color` is used: lip color is
 * dominated by lipstick and eyebrow/hair color by dye, so they are not trusted even as tie-breakers.
 * (Checked on the 5 real-API portraits: a lip-vs-skin hue gap ordered the two intended-cool subjects
 * apart from the rest by under 3°, n = 5 with prompt labels, so it was not adopted.)
 * See `classifyLab` for the decision.
 */
export function estimateUndertone(colors: FacialColors): UndertoneEstimate {
  return classifyLab(hexToLab(colors.skin_color));
}

/**
 * Decision (all numbers in UNDERTONE_THRESHOLDS; our heuristic, no published cut-offs exist):
 * 1. C* < 2 or h* outside (0°, 180°) → neutral, confidence 0.2.
 * 1b. Real-API unsure band 55° ≤ h* ≤ 67° → neutral, confidence 0.2 (any L*).
 * 2. Depth-relative reading: Δ = h* − ref(L*). Δ < −5° cool, Δ > +5° warm, else neutral.
 * 3. Absolute reading: h* < 50° cool, h* > 62° warm, else neutral.
 * 4. Opposite readings (cool vs warm) → neutral, confidence 0.2. Otherwise the depth-relative label.
 * Confidence = 0.9 · margin · chromaTerm · spread · agreement, where
 *   margin = 0.5 + 0.5·min(1, | |Δ| − 5° | / 8°), chromaTerm = 0.4 + 0.6·clamp((C* − 2) / 10),
 *   spread = clamp(1 − (|ref(L*) − 74°| − 5°) / 15°, 0.4, 1), agreement = 1 (same) or 0.6 (one neutral).
 * L* only selects the reference hue: a colour that is typical for its depth is neutral at every depth.
 */
export function classifyLab(lab: Lab): UndertoneEstimate {
  const hueDeg = hueAngleDeg(lab);
  const C = chroma(lab);
  const T = UNDERTONE_THRESHOLDS;
  const out = (undertone: Undertone, confidence: number): UndertoneEstimate => ({
    undertone,
    confidence: round(clamp01(confidence), 2),
    lab: { L: round(lab.L, 2), a: round(lab.a, 2), b: round(lab.b, 2) },
    hueDeg: round(hueDeg, 2),
  });

  if (C < T.minChroma || !(hueDeg > 0 && hueDeg < 180)) return out("neutral", T.lowConfidence);
  // v3: the band where real API output for very different people overlaps carries no usable signal.
  if (hueDeg >= T.unsureLoDeg && hueDeg <= T.unsureHiDeg) return out("neutral", T.lowConfidence);

  const ref = referenceHue(lab.L);
  const delta = hueDeg - ref;
  const relative: Undertone = delta < -T.relativeBandDeg ? "cool" : delta > T.relativeBandDeg ? "warm" : "neutral";
  const absolute: Undertone = hueDeg < T.absoluteCoolMaxDeg ? "cool" : hueDeg > T.absoluteWarmMinDeg ? "warm" : "neutral";
  if ((relative === "cool" && absolute === "warm") || (relative === "warm" && absolute === "cool")) {
    return out("neutral", T.lowConfidence);
  }
  const margin = 0.5 + 0.5 * Math.min(1, Math.abs(Math.abs(delta) - T.relativeBandDeg) / T.marginFullDeg);
  const chromaTerm = 0.4 + 0.6 * clamp01((C - T.minChroma) / (T.fullChroma - T.minChroma));
  const spread = Math.max(T.minSpreadFactor, Math.min(1, 1 - (Math.abs(ref - MST_MEDIAN_HUE) - T.spreadFreeDeg) / T.spreadScaleDeg));
  const agreement = relative === absolute ? 1 : T.partialAgreement;
  return out(relative, T.maxConfidence * margin * chromaTerm * spread * agreement);
}

// ---------------------------------------------------------------------------------------------------
// Rule tables (jewelry_rules.md, source ids are local to that file)
// ---------------------------------------------------------------------------------------------------

export interface RuleRow {
  strength: Exclude<RuleStrength, "none">;
  sources: readonly string[];
  /** Only one source covers the row (or, for Triangle, the API label's meaning is unverified). */
  single_source: boolean;
  note?: string;
}

/** Weights (R1 suggestions, jewelry_rules.md §1). Not sourced; published so A3 can show them. */
export const RULE_WEIGHTS = { recommended: 1.0, acceptable: 0.4, avoid: -1.0, none: 0 } as const;

/** Catalog `metal_tone` for each canonical metal (jewelry_rules.md §2: rose gold stays warm). */
export const METAL_TONE: Record<Metal, MetalTone> = {
  yellow_gold: "warm",
  rose_gold: "warm",
  white_gold: "cool",
  silver: "cool",
  platinum: "cool",
  mixed_two_tone: "neutral",
};

const row = (strength: RuleRow["strength"], sources: string[], note?: string): RuleRow => ({
  strength,
  sources,
  single_source: sources.length < 2,
  ...(note ? { note } : {}),
});

/**
 * Table 1, metal ↔ undertone. No "avoid" anywhere: no source says avoid (ADR-013). Implied opposite
 * pairings are "acceptable" (weight 0.4; never lower).
 */
export const METAL_UNDERTONE: Record<Metal, Record<Undertone, RuleRow>> = {
  yellow_gold: {
    warm: row("recommended", ["R1", "R2", "R3", "R4"]),
    neutral: row("recommended", ["R1", "R2", "R3", "R4"]),
    cool: row("acceptable", ["R2"], "implied opposite; no source says avoid"),
  },
  rose_gold: {
    warm: row("recommended", ["R1", "R2", "R3", "R4"]),
    neutral: row("recommended", ["R2"], "R2 calls rose gold a bridge metal"),
    cool: row("acceptable", ["R2"], "R2: a softer alternative for cool"),
  },
  white_gold: {
    cool: row("recommended", ["R1", "R2", "R3", "R4"]),
    neutral: row("recommended", ["R1", "R2", "R3", "R4"]),
    warm: row("acceptable", ["R2"], "implied opposite; no source says avoid"),
  },
  silver: {
    cool: row("recommended", ["R1", "R2", "R3", "R4"]),
    neutral: row("recommended", ["R1", "R2", "R3", "R4"]),
    warm: row("acceptable", ["R2"], "implied opposite; no source says avoid"),
  },
  platinum: {
    cool: row("recommended", ["R1", "R2", "R4"]),
    neutral: row("recommended", ["R4"], "R4: nearly any metal works for neutral"),
    warm: row("acceptable", ["R2"], "implied opposite; no source says avoid"),
  },
  mixed_two_tone: {
    neutral: row("recommended", ["R1", "R2"]),
    warm: row("acceptable", ["R2"], "mixed metals fine if one dominates"),
    cool: row("acceptable", ["R2"], "mixed metals fine if one dominates"),
  },
};

/** Rule key: a shape token, a length bin, a composite key, or "*" (applies when no specific row matched). */
export type EarringRuleKey = EarringShape | "*";
export type NecklaceLengthBin = "len_le_16" | "len_16_to_19" | "len_le_18" | "len_ge_20" | "len_ge_22";
export type NecklaceRuleKey = NecklaceStyle | NecklaceLengthBin | "pendant_v_y_long" | "*";

type ShapeTable<K extends string> = Record<FaceShape, Partial<Record<K, RuleRow>>>;

const OVAL_E = ["E1", "E2", "E3", "E4", "E5", "E6", "E7"];
const heartEarrings: Partial<Record<EarringRuleKey, RuleRow>> = {
  drop_teardrop: row("recommended", ["E2", "E3", "E4", "E6", "E7"]),
  drop_wide_bottom: row("recommended", ["E1", "E3", "E5", "E6", "E7"], "adds width at the chin"),
  chandelier: row("recommended", ["E3", "E4", "E5"]),
  hoop_small_medium: row("acceptable", ["E4"]),
  stud_statement: row("avoid", ["E2", "E4", "E5", "E6"], "top-heavy or wide-at-the-top designs"),
};
/** Marks every row of a table as single-source (used for Triangle: label meaning unverified). */
const flagAll = <K extends string>(t: Partial<Record<K, RuleRow>>, note: string): Partial<Record<K, RuleRow>> =>
  Object.fromEntries(
    Object.entries(t).map(([k, v]) => [k, { ...(v as RuleRow), single_source: true, note }]),
  ) as Partial<Record<K, RuleRow>>;
const TRIANGLE_NOTE = "Triangle: API label meaning unverified (jewelry_rules.md §3); treated as single-source";

/** Table 2a, earring shape ↔ face shape. Contested rows ("neutral") are omitted, i.e. no rule. */
export const EARRING_FACE: ShapeTable<EarringRuleKey> = {
  Round: {
    drop_long_narrow: row("recommended", ["E2", "E3", "E4", "E5", "E6", "E7"], "adds the illusion of length"),
    drop_teardrop: row("recommended", ["E1", "E5", "E6"]),
    chandelier: row("acceptable", ["E5"]),
    geometric_angular: row("acceptable", ["E2", "E4"]),
    hoop_round_large: row("avoid", ["E2", "E4", "E5", "E6", "E7"], "mirrors the roundness"),
    stud_statement: row("avoid", ["E2", "E3", "E4", "E6", "E7"]),
  },
  Oval: {
    "*": row("recommended", OVAL_E, "nearly any style suits an oval face"),
    drop_long_narrow: row("avoid", ["E4", "E5", "E6"], "overly long earrings can elongate the face"),
  },
  Square: {
    hoop_round_large: row("recommended", ["E2", "E3", "E4", "E5", "E6", "E7"], "rounded shapes soften the jaw"),
    hoop_oval_curved: row("recommended", ["E2", "E3", "E4", "E5", "E6", "E7"], "rounded shapes soften the jaw"),
    drop_teardrop: row("recommended", ["E1", "E2", "E4", "E5", "E6", "E7"]),
    drop_long_narrow: row("acceptable", ["E2", "E3", "E7"], "long dangles with rounded elements"),
    stud_small: row("acceptable", ["E3"], "contested: E2/E5 avoid square studs only"),
    geometric_angular: row("avoid", ["E2", "E3", "E4", "E5", "E6", "E7"], "sharp shapes echo the jaw"),
  },
  Heart: heartEarrings,
  InvTriangle: {
    ...heartEarrings,
    stud_small: row("acceptable", ["E7"], "E7 inverted-triangle extra"),
    hoop_oval_curved: row("acceptable", ["E7"], "E7 inverted-triangle extra"),
  },
  Oblong: {
    hoop_round_large: row("recommended", ["E2", "E4", "E5", "E6"], "adds width"),
    stud_statement: row("recommended", ["E2", "E4", "E5", "E6"]),
    chandelier_short: row("acceptable", ["E5", "E6"], "short, wide chandeliers"),
    stud_small: row("acceptable", ["E4"]),
    drop_long_narrow: row("avoid", ["E2", "E4", "E5", "E6"]),
  },
  Diamond: {
    stud_small: row("recommended", ["E2", "E3", "E4"]),
    hoop_small_medium: row("recommended", ["E3", "E4", "E6", "E7"]),
    drop_teardrop: row("recommended", ["E2", "E3", "E4", "E7"], "short drops"),
    chandelier: row("acceptable", ["E7"]),
    geometric_angular: row("avoid", ["E2", "E4", "E7"]),
    drop_long_narrow: row("avoid", ["E6"], "extremely narrow or long"),
  },
  Triangle: flagAll<EarringRuleKey>(
    {
      drop_long_narrow: row("acceptable", ["E8"]),
      stud_statement: row("acceptable", ["E6"]),
      drop_wide_bottom: row("avoid", ["E6", "E8"], "widens the jaw"),
    },
    TRIANGLE_NOTE,
  ),
  Unknown: {},
};

const heartNecklaces: Partial<Record<NecklaceRuleKey, RuleRow>> = {
  len_16_to_19: row("recommended", ["N2", "N3", "N4", "N5"], "choker, collarbone or princess length"),
  choker: row("acceptable", ["N3", "N4", "N5"], "contested with N1 (heavy chokers)"),
  choker_heavy: row("acceptable", ["N1", "N3", "N4", "N5"], "contested: N1 avoids, N3/N4/N5 recommend"),
  pendant_v_y_long: row("avoid", ["N5"], "long V pendant (≥ 20 in)"),
};

/** Table 2b, necklace style and length ↔ face shape. Length bins come from `necklace_length_in`. */
export const NECKLACE_FACE: ShapeTable<NecklaceRuleKey> = {
  Round: {
    len_ge_20: row("recommended", ["N1", "N2", "N4", "N5"], "matinee or opera length"),
    pendant_v_y: row("recommended", ["N3", "N4", "N5"], "V-shapes draw the eye down"),
    len_le_16: row("avoid", ["N1", "N3"], "short chokers emphasize roundness"),
  },
  Oval: {
    "*": row("recommended", ["N1", "N2", "N3", "N4"], "any length, any style"),
    choker: row("acceptable", ["N3"], "N3 warns only for a short neck (not measured)"),
  },
  Square: {
    pendant_curved: row("recommended", ["N1", "N3", "N4", "N5"]),
    geometric_angular: row("avoid", ["N1", "N3", "N4"]),
    large_stone: row("avoid", ["N1", "N3", "N4"]),
    thin_chain: row("avoid", ["N1", "N3", "N4"]),
  },
  Heart: heartNecklaces,
  InvTriangle: heartNecklaces,
  Oblong: {
    len_le_18: row("recommended", ["N1", "N2", "N3", "N4", "N5"], "shorter, wider, horizontal"),
    collar_bib_horizontal: row("recommended", ["N1", "N2", "N3", "N4", "N5"]),
    long_vertical: row("avoid", ["N1", "N5"]),
    thin_chain: row("avoid", ["N1", "N5"]),
  },
  Diamond: {
    len_le_18: row("acceptable", ["N4"]),
    collar_bib_horizontal: row("acceptable", ["N4"]),
  },
  Triangle: flagAll<NecklaceRuleKey>(
    {
      len_ge_22: row("acceptable", ["N4"], "delicate chains with minimal width"),
      pendant_v_y: row("acceptable", ["N4"]),
      thin_chain: row("acceptable", ["N4"]),
    },
    TRIANGLE_NOTE,
  ),
  Unknown: {},
};

/** Length bins a necklace falls into (inclusive bounds). Several can apply at once. */
export function necklaceLengthBins(lengthIn: number | undefined): NecklaceLengthBin[] {
  if (lengthIn === undefined || !Number.isFinite(lengthIn) || lengthIn <= 0) return [];
  const bins: NecklaceLengthBin[] = [];
  if (lengthIn <= 16) bins.push("len_le_16");
  if (lengthIn >= 16 && lengthIn <= 19) bins.push("len_16_to_19");
  if (lengthIn <= 18) bins.push("len_le_18");
  if (lengthIn >= 20) bins.push("len_ge_20");
  if (lengthIn >= 22) bins.push("len_ge_22");
  return bins;
}

// ---------------------------------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------------------------------

const NONE: RuleScore = { strength: "none", weight: 0, sources: [], singleSource: false };

/** Effective score of one row: single-source halves the weight; avoid needs ≥ 2 sources and no flag. */
export function scoreRow(r: RuleRow): RuleScore {
  const sources = [...r.sources];
  if (r.strength === "avoid" && (r.single_source || r.sources.length < 2)) {
    return { strength: "none", weight: 0, sources, singleSource: true };
  }
  const base = RULE_WEIGHTS[r.strength];
  return { strength: r.strength, weight: r.single_source ? base / 2 : base, sources, singleSource: r.single_source };
}

export function metalFit(metal: Metal, undertone: Undertone): RuleScore {
  const r = METAL_UNDERTONE[metal]?.[undertone];
  if (!r) return NONE;
  // Metal rows are never halved: implied opposites stay at 0.4 (orchestrator addendum, ADR-013).
  return { strength: r.strength, weight: RULE_WEIGHTS[r.strength], sources: [...r.sources], singleSource: r.single_source };
}

/** Strength implied by a combined weight. */
const strengthOf = (w: number): RuleStrength =>
  w >= 0.7 ? "recommended" : w > 0 ? "acceptable" : w <= -0.5 ? "avoid" : "none";

/**
 * Combine several matched rows (a necklace can match a style row and length rows): weights are summed
 * and clamped to [-1, 1]; strength follows the combined weight (≥ 0.7 recommended, > 0 acceptable,
 * ≤ -0.5 avoid, else none); sources are the union; singleSource only if every contributing row is.
 * One matched row is returned unchanged.
 */
export function combineScores(scores: RuleScore[]): RuleScore {
  if (scores.length === 0) return NONE;
  if (scores.length === 1) return scores[0];
  const weight = round(Math.max(-1, Math.min(1, scores.reduce((s, x) => s + x.weight, 0))), 3);
  const sources = [...new Set(scores.flatMap((s) => s.sources))].sort();
  return { strength: strengthOf(weight), weight, sources, singleSource: scores.every((s) => s.singleSource) };
}

export function styleFit(attributes: GiftFitAttributes, faceShape: FaceShape): RuleScore {
  if (faceShape === "Unknown") return NONE;
  if (attributes.category === "earring") {
    const table = EARRING_FACE[faceShape];
    const shape = attributes.earring_shape;
    if (!table || !shape) return NONE;
    const r = table[shape] ?? table["*"];
    return r ? scoreRow(r) : NONE;
  }
  if (attributes.category === "necklace") {
    const table = NECKLACE_FACE[faceShape];
    if (!table) return NONE;
    const keys: NecklaceRuleKey[] = [...necklaceLengthBins(attributes.necklace_length_in)];
    if (attributes.necklace_style) keys.push(attributes.necklace_style);
    if (attributes.necklace_style === "pendant_v_y" && (attributes.necklace_length_in ?? 0) >= 20) {
      keys.push("pendant_v_y_long");
    }
    const rows = keys.map((k) => table[k]).filter((r): r is RuleRow => Boolean(r));
    if (rows.length === 0) return table["*"] ? scoreRow(table["*"]) : NONE;
    return combineScores(rows.map(scoreRow));
  }
  // No sourced rule for ring, bracelet or watch shape vs hand/wrist (jewelry_rules.md "Read this first").
  return NONE;
}

export const jewelryRules: JewelryRules = { estimateUndertone, metalFit, styleFit };

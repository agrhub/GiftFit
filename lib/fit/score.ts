/**
 * Fit Engine scoring (MASTER_PLAN v2 G6). Deterministic and explainable: the same inputs always give
 * the same score, breakdown and reason texts. Formula and weights: lib/fit/WEIGHTS.md, ./weights.ts.
 *
 * The jewelry rule tables are injected (`JewelryRules`, implemented by A10 in lib/verticals/jewelry.ts)
 * so this module never imports a vertical directly.
 */
import type {
  CatalogSku,
  FitBreakdown,
  FitRequestInput,
  FitResult,
  JewelryRules,
  RecipientProfile,
  RuleScore,
  RuleStrength,
  Undertone,
} from "@/lib/contracts/giftfit";
import {
  CATEGORY_LABEL,
  FACE_SHAPE_LABEL,
  METAL_LABEL,
  OCCASION_LABEL,
  UNDERTONE_LABEL,
  capitalize,
  formatMoney,
  skuSimilarity,
  styleLabel,
} from "./labels";
import { variantView, variantsOf, visibleVariants } from "./variants";
import { FIT_MAX, FIT_PARAMS, FIT_WEIGHTS } from "./weights";

export type FitFactor = "hearts" | "metal" | "confidence" | "style" | "budget" | "occasion";
export type SignalPolarity = "positive" | "neutral" | "negative";

/**
 * One explainable fact behind a score. `label` is the short giver-safe phrase handed to the LLM
 * ("warm undertone estimate → yellow gold: recommended"); `text` is the template sentence (≤ 20 words).
 */
export interface FitSignal {
  factor: FitFactor;
  polarity: SignalPolarity;
  label: string;
  text: string;
  /** Points this factor contributed; used to rank reasons. */
  points: number;
}

/** FitResult plus the signals that explain it. Strip with `toFitResult` before returning to a giver. */
export interface ScoredSku extends FitResult {
  signals: FitSignal[];
  /** Unrounded total before clamping, for tests and audits. */
  raw: number;
}

export interface FitContext {
  /** The pieces they hearted (shortlist and decoys, as variant views), for look-alike credit. */
  heartedSkus?: readonly CatalogSku[];
  /** Swatch-leveling cap of this Fit Request (variants.ts swatchCap): only visible variants are scored. */
  swatchCap?: number;
}

export const GENERIC_CAUTION = "AI try-on preview: undertone and face shape are estimates, not a sizing guarantee.";

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
const clampWeight = (w: number) => (Number.isFinite(w) ? Math.min(1, Math.max(-1, w)) : 0);
const round1 = (x: number) => Math.round(x * 10) / 10;
const withArticle = (phrase: string) => `${/^[aeiou]/i.test(phrase) ? "an" : "a"} ${phrase}`;

/** Undertone used in scoring: the recipient's override wins over the estimate. */
export function effectiveUndertone(profile: RecipientProfile): { undertone: Undertone; confidence: number; override: boolean } {
  if (profile.undertoneOverride) return { undertone: profile.undertoneOverride, confidence: 1, override: true };
  return { undertone: profile.undertoneEstimate, confidence: clamp01(profile.undertoneConfidence), override: false };
}

/** Which variant of the design is being scored (ids of the design's variants for "another metal" checks). */
interface VariantRef {
  variantId: string;
  designVariantIds: readonly string[];
}

/** Heart level for one variant: 1 hearted, 0.6 another metal of a hearted design, 0.5 wished for another metal. */
export function variantHeartLevel(profile: RecipientProfile, skuId: string, ref: VariantRef): { h: number; kind: "hearted" | "other_metal" | "wish" | "none" } {
  const hv = profile.heartedVariantIds ?? [];
  if (hv.includes(ref.variantId)) return { h: 1, kind: "hearted" };
  const otherVariantHearted = ref.designVariantIds.some((id) => id !== ref.variantId && hv.includes(id));
  if (otherVariantHearted) return { h: FIT_PARAMS.otherMetalHeartFactor, kind: "other_metal" };
  // A design hearted with no variant recorded (legacy rows, single-variant designs) counts fully.
  if (profile.heartedSkuIds.includes(skuId)) return { h: 1, kind: "hearted" };
  if ((profile.wishOtherMetalSkuIds ?? []).includes(skuId)) return { h: FIT_PARAMS.wishOtherMetalFactor, kind: "wish" };
  return { h: 0, kind: "none" };
}

const anyHearts = (p: RecipientProfile) => p.heartedSkuIds.length > 0 || (p.heartedVariantIds ?? []).length > 0;

function heartsFactor(profile: RecipientProfile | null, sku: CatalogSku, ctx: FitContext, ref?: VariantRef): { h: number; signal?: Omit<FitSignal, "points"> } {
  if (!profile) return { h: 0 };
  const level = variantHeartLevel(profile, sku.id, ref ?? { variantId: `${sku.id}:${sku.attributes.metal}`, designVariantIds: [] });
  if (level.kind === "hearted") {
    return { h: 1, signal: { factor: "hearts", polarity: "positive", label: "hearted", text: "They hearted this piece during their try-on." } };
  }
  if (level.kind === "other_metal") {
    return {
      h: level.h,
      signal: { factor: "hearts", polarity: "positive", label: "hearted this design in another metal", text: "They hearted this design in another metal." },
    };
  }
  if (level.kind === "wish") {
    return {
      h: level.h,
      signal: { factor: "hearts", polarity: "positive", label: "loved the style, wished for another metal", text: "They loved the style and wished it came in another metal." },
    };
  }
  let best = 0;
  for (const other of ctx.heartedSkus ?? []) {
    if (other.id === sku.id) continue;
    best = Math.max(best, skuSimilarity(sku, other));
  }
  if (best >= FIT_PARAMS.similarHeartMin) {
    return {
      h: FIT_PARAMS.similarHeartFactor * best,
      signal: { factor: "hearts", polarity: "positive", label: "hearted a similar piece", text: "They hearted a similar piece in the same style." },
    };
  }
  if (!anyHearts(profile)) {
    return { h: 0, signal: { factor: "hearts", polarity: "neutral", label: "no pieces hearted", text: "They did not heart any piece, so this score rests on styling rules." } };
  }
  return { h: 0, signal: { factor: "hearts", polarity: "negative", label: "not hearted", text: "They did not heart this piece during their try-on." } };
}

function polarityOf(strength: RuleStrength): SignalPolarity | null {
  if (strength === "recommended") return "positive";
  if (strength === "acceptable") return "neutral";
  if (strength === "avoid") return "negative";
  return null;
}

function metalFactor(profile: RecipientProfile | null, sku: CatalogSku, rules: JewelryRules) {
  const signals: Omit<FitSignal, "points">[] = [];
  if (!profile) return { m: 0.5, signals };
  const { undertone, confidence, override } = effectiveUndertone(profile);
  const rule: RuleScore = rules.metalFit(sku.attributes.metal, undertone);
  const m = (clampWeight(rule.weight) + 1) / 2;
  const mEff = 0.5 + confidence * (m - 0.5);
  const metal = METAL_LABEL[sku.attributes.metal];
  const tone = UNDERTONE_LABEL[undertone];
  const who = override ? `${tone} undertone (their choice)` : `${tone} undertone estimate`;
  const polarity = polarityOf(rule.strength);
  if (polarity === "positive") {
    signals.push({ factor: "metal", polarity, label: `${who} → ${metal}: recommended`, text: `${capitalize(who)} suits ${metal}.` });
  } else if (polarity === "neutral") {
    signals.push({ factor: "metal", polarity, label: `${who} → ${metal}: acceptable`, text: `${capitalize(metal)} is a softer match than other metals for a ${who}.` });
  } else if (polarity === "negative") {
    signals.push({ factor: "metal", polarity, label: `${who} → ${metal}: usually avoided`, text: `Stylists rarely pair ${metal} with a ${who}.` });
  }
  if (!override && confidence < FIT_PARAMS.lowConfidence) {
    signals.push({
      factor: "confidence",
      polarity: "negative",
      label: "low-confidence undertone estimate",
      text: "Their undertone estimate is low confidence, so treat the metal advice lightly.",
    });
  }
  return { m: mEff, signals };
}

function styleFactor(profile: RecipientProfile | null, sku: CatalogSku, rules: JewelryRules) {
  if (!profile || profile.faceShape === "Unknown") return { s: 0.5 };
  const rule = rules.styleFit(sku.attributes, profile.faceShape);
  const s = (clampWeight(rule.weight) + 1) / 2;
  const polarity = polarityOf(rule.strength);
  if (!polarity) return { s };
  const face = `${FACE_SHAPE_LABEL[profile.faceShape]} face`;
  const style = styleLabel(sku);
  const label = `${face} → ${style}: ${rule.strength === "avoid" ? "usually avoided" : rule.strength}${rule.singleSource ? " (single source)" : ""}`;
  const text =
    polarity === "positive"
      ? `${capitalize(face)} shape suits ${style}.`
      : polarity === "neutral"
        ? `${capitalize(style)} are an acceptable match for ${withArticle(face)} shape.`
        : `Stylists often steer ${face} shapes away from ${style}.`;
  return { s, signal: { factor: "style" as const, polarity, label, text } };
}

function budgetFactor(sku: CatalogSku, request: FitRequestInput) {
  const min = request.budgetMin ?? 0;
  const range = min > 0 ? `${formatMoney(min, request.currency)}–${formatMoney(request.budgetMax, request.currency)}` : formatMoney(request.budgetMax, request.currency);
  if (sku.currency !== request.currency) {
    return {
      b: 0,
      signal: { factor: "budget" as const, polarity: "negative" as const, label: "priced in a different currency", text: `Priced in ${sku.currency}, not your budget currency.` },
    };
  }
  const p = sku.price;
  if (p >= min && p <= request.budgetMax) {
    return { b: 1, signal: { factor: "budget" as const, polarity: "positive" as const, label: "within budget", text: `Within your ${range} budget.` } };
  }
  const over = p > request.budgetMax;
  const bound = over ? request.budgetMax : min;
  const d = bound > 0 ? Math.abs(p - bound) / bound : 1;
  const b = Math.max(0, 1 - d / FIT_PARAMS.budgetFalloff);
  const gap = formatMoney(Math.abs(p - bound), request.currency);
  return over
    ? { b, signal: { factor: "budget" as const, polarity: "negative" as const, label: "over budget", text: `${gap} over your ${range} budget.` } }
    : { b, signal: { factor: "budget" as const, polarity: "neutral" as const, label: "below budget", text: `${gap} below your ${range} budget.` } };
}

function occasionFactor(sku: CatalogSku, request: FitRequestInput) {
  const occ = OCCASION_LABEL[request.occasion];
  if ((sku.attributes.occasions ?? []).includes(request.occasion)) {
    return { o: 1, signal: { factor: "occasion" as const, polarity: "positive" as const, label: `suits ${request.occasion}`, text: `A natural fit for ${occ}.` } };
  }
  return {
    o: FIT_PARAMS.occasionMissCredit,
    signal: { factor: "occasion" as const, polarity: "neutral" as const, label: `not tagged for ${request.occasion}`, text: `Not tagged for ${occ}, but still giftable.` },
  };
}

const CAUTION_ORDER: FitFactor[] = ["hearts", "confidence", "metal", "style", "budget", "occasion"];

function pickReasons(signals: FitSignal[], sku: CatalogSku, request: FitRequestInput): { reasons: string[]; caution: string } {
  const positives = signals.filter((s) => s.polarity === "positive").sort((a, b) => b.points - a.points);
  const neutrals = signals.filter((s) => s.polarity === "neutral" && s.factor !== "hearts");
  const reasons = [...positives, ...neutrals].slice(0, 2).map((s) => s.text);
  if (reasons.length < 2) reasons.push(`On your ${CATEGORY_LABEL[sku.category]} shortlist for ${OCCASION_LABEL[request.occasion]}.`);
  if (reasons.length < 2) reasons.push(GENERIC_CAUTION);
  const byOrder = (pol: SignalPolarity) =>
    CAUTION_ORDER.map((f) => signals.find((s) => s.factor === f && s.polarity === pol)).find(Boolean);
  const caution = byOrder("negative") ?? signals.find((s) => s.polarity === "neutral" && (s.factor === "metal" || s.factor === "style"));
  const cautionText = caution && !reasons.includes(caution.text) ? caution.text : GENERIC_CAUTION;
  return { reasons, caution: cautionText };
}

/**
 * fitScore(recipientProfile, sku, request) → 0..100 with a breakdown (points per factor), per design.
 *
 * The design is scored once per eligible metal variant the recipient could see (price ≤ budget cap,
 * inside the metal lock, within the request's swatch cap; every variant when none is eligible, so
 * legacy callers still get a score). The result describes the
 * hearted variant (best-scoring among hearted ones), else the best-scoring variant; ties keep the
 * giver's listing order. `profile` may be null for a catalog-only preview.
 */
export function fitScore(
  profile: RecipientProfile | null,
  sku: CatalogSku,
  request: FitRequestInput,
  rules: JewelryRules,
  ctx: FitContext = {},
): ScoredSku {
  const all = variantsOf(sku);
  const eligible = visibleVariants(sku, request, ctx.swatchCap);
  const candidates = eligible.length > 0 ? eligible : all;
  const designVariantIds = all.map((v) => v.variantId);
  const scored = candidates.map((v) => ({
    v,
    s: scoreView(profile, variantView(sku, v), request, rules, ctx, { variantId: v.variantId, designVariantIds }),
  }));
  const fullyHearted = profile ? scored.filter((x) => variantHeartLevel(profile, sku.id, { variantId: x.v.variantId, designVariantIds }).h === 1) : [];
  const pool = fullyHearted.length > 0 ? fullyHearted : scored;
  const best = pool.reduce((a, b) => (b.s.raw > a.s.raw + 1e-9 ? b : a));
  const result: ScoredSku = { ...best.s, variantId: best.v.variantId, metal: best.v.metal, price: best.v.price };
  if (profile?.wishOtherMetalSkuIds?.includes(sku.id)) result.wishOtherMetal = true;
  return result;
}

/** Scores one design as seen in one metal (a `variantView`). */
export function scoreView(
  profile: RecipientProfile | null,
  sku: CatalogSku,
  request: FitRequestInput,
  rules: JewelryRules,
  ctx: FitContext = {},
  ref?: VariantRef,
): ScoredSku {
  const hearts = heartsFactor(profile, sku, ctx, ref);
  const metal = metalFactor(profile, sku, rules);
  const style = styleFactor(profile, sku, rules);
  const budget = budgetFactor(sku, request);
  const occasion = occasionFactor(sku, request);

  const W = FIT_WEIGHTS;
  const pts = {
    hearts: W.hearts * hearts.h,
    metal: W.metal * metal.m,
    style: W.style * style.s,
    budget: W.budgetOccasion * FIT_PARAMS.budgetShare * budget.b,
    occasion: W.budgetOccasion * (1 - FIT_PARAMS.budgetShare) * occasion.o,
  };
  const raw = pts.hearts + pts.metal + pts.style + pts.budget + pts.occasion;
  const breakdown: FitBreakdown = {
    hearts: round1(pts.hearts),
    metal: round1(pts.metal),
    style: round1(pts.style),
    budgetOccasion: round1(pts.budget + pts.occasion),
  };

  const signals: FitSignal[] = [];
  if (hearts.signal) signals.push({ ...hearts.signal, points: pts.hearts });
  for (const s of metal.signals) signals.push({ ...s, points: s.factor === "metal" ? pts.metal : 0 });
  if (style.signal) signals.push({ ...style.signal, points: pts.style });
  signals.push({ ...budget.signal, points: pts.budget });
  signals.push({ ...occasion.signal, points: pts.occasion });

  const { reasons, caution } = pickReasons(signals, sku, request);
  return {
    skuId: sku.id,
    score: Math.round(Math.min(FIT_MAX, Math.max(0, raw))),
    breakdown,
    reasons,
    caution,
    signals,
    raw,
  };
}

/** Scores every SKU, highest first (stable on ties). */
export function scoreSkus(
  profile: RecipientProfile | null,
  skus: readonly CatalogSku[],
  request: FitRequestInput,
  rules: JewelryRules,
  ctx: FitContext = {},
): ScoredSku[] {
  return skus
    .map((sku, i) => ({ s: fitScore(profile, sku, request, rules, ctx), i }))
    .sort((a, b) => b.s.raw - a.s.raw || a.i - b.i)
    .map((x) => x.s);
}

/** The giver-facing shape: exactly the FitResult fields, nothing else. */
export function toFitResult(s: FitResult): FitResult {
  const out: FitResult = {
    skuId: s.skuId,
    score: s.score,
    breakdown: { hearts: s.breakdown.hearts, metal: s.breakdown.metal, style: s.breakdown.style, budgetOccasion: s.breakdown.budgetOccasion },
    reasons: [...s.reasons],
  };
  if (s.caution) out.caution = s.caution;
  if (s.variantId !== undefined) out.variantId = s.variantId;
  if (s.metal !== undefined) out.metal = s.metal;
  if (s.price !== undefined) out.price = s.price;
  if (s.wishOtherMetal) out.wishOtherMetal = true;
  return out;
}

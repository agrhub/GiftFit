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
import { type Locale, formatMoney as localeMoney } from "@/lib/i18n";
import { rs, rt } from "@/lib/i18n/report";
import { formatMoney, skuSimilarity } from "./labels";
import { variantView, variantsOf, visibleVariants } from "./variants";
import { FIT_MAX, FIT_PARAMS, FIT_WEIGHTS, FIT_WEIGHTS_NO_TRYON } from "./weights";

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
  /**
   * No try-on happened (store-URL previews, or the recipient never took a photo): there is no undertone
   * and no face shape, so the metal and style factors are DROPPED (not defaulted) and hearts +
   * budget/occasion are renormalised (FIT_WEIGHTS_NO_TRYON). No text mentions undertone, face shape or try-on.
   */
  noTryOn?: boolean;
  /**
   * A16 mixed set: the recipient took a photo, but these designs were not tried on (a store-URL preview photo
   * try-on can't use). They are scored exactly like `noTryOn` (FIT_WEIGHTS_NO_TRYON, no undertone or face-shape
   * factor or text) and marked `tryOn: false`; the others keep the try-on weights.
   */
  noTryOnIds?: ReadonlySet<string>;
  /**
   * The giver's report language (lib/i18n/report; StoredFitRequest.giverLang via uiLocaleFor). Only the
   * template texts (`text`, reasons, caution) follow it; signal `label`s stay English (model input).
   * Absent = English.
   */
  locale?: Locale;
}

export const GENERIC_CAUTION = "AI try-on preview: undertone and face shape are estimates, not a sizing guarantee.";
/** The generic caution for a request without a try-on: no try-on, undertone or face-shape claims. */
export const GENERIC_CAUTION_NO_TRYON = "Scored from their hearts, your budget and the occasion. Check the size before you buy.";

/** GENERIC_CAUTION / GENERIC_CAUTION_NO_TRYON in the report language. */
export function genericCaution(locale: Locale = "en", noTryOn = false): string {
  return rt(locale, noTryOn ? "fit.caution.genericNoTryOn" : "fit.caution.generic");
}

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
const clampWeight = (w: number) => (Number.isFinite(w) ? Math.min(1, Math.max(-1, w)) : 0);
const round1 = (x: number) => Math.round(x * 10) / 10;
const withArticle = (phrase: string) => `${/^[aeiou]/i.test(phrase) ? "an" : "a"} ${phrase}`;

/** Prices in the report language: English keeps the engine's "$150" form; others use Intl. */
const money = (locale: Locale, amount: number, currency: string) => (locale === "en" ? formatMoney(amount, currency) : localeMoney(locale, Math.round(amount), currency));

/** "drop earrings", "curved pendants", or the category word (lib/fit/labels styleLabel, localized). */
function styleText(locale: Locale, sku: CatalogSku): string {
  const a = sku.attributes;
  if (a.earring_shape) return rt(locale, `earringShape.${a.earring_shape}`);
  if (a.necklace_style) return rt(locale, `necklaceStyle.${a.necklace_style}`);
  return rt(locale, `category.${sku.category}`);
}

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
  const loc = ctx.locale ?? "en";
  const level = variantHeartLevel(profile, sku.id, ref ?? { variantId: `${sku.id}:${sku.attributes.metal}`, designVariantIds: [] });
  if (level.kind === "hearted") {
    return { h: 1, signal: { factor: "hearts", polarity: "positive", label: "hearted", text: rs(loc, ctx.noTryOn ? "fit.hearts.heartedNoTryOn" : "fit.hearts.hearted") } };
  }
  if (level.kind === "other_metal") {
    return {
      h: level.h,
      signal: { factor: "hearts", polarity: "positive", label: "hearted this design in another metal", text: rs(loc, "fit.hearts.otherMetal") },
    };
  }
  if (level.kind === "wish") {
    return {
      h: level.h,
      signal: { factor: "hearts", polarity: "positive", label: "loved the style, wished for another metal", text: rs(loc, "fit.hearts.wish") },
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
      signal: { factor: "hearts", polarity: "positive", label: "hearted a similar piece", text: rs(loc, "fit.hearts.similar") },
    };
  }
  if (!anyHearts(profile)) {
    return {
      h: 0,
      signal: {
        factor: "hearts",
        polarity: "neutral",
        label: "no pieces hearted",
        text: rs(loc, ctx.noTryOn ? "fit.hearts.noneNoTryOn" : "fit.hearts.none"),
      },
    };
  }
  return { h: 0, signal: { factor: "hearts", polarity: "negative", label: "not hearted", text: rs(loc, ctx.noTryOn ? "fit.hearts.notNoTryOn" : "fit.hearts.not") } };
}

function polarityOf(strength: RuleStrength): SignalPolarity | null {
  if (strength === "recommended") return "positive";
  if (strength === "acceptable") return "neutral";
  if (strength === "avoid") return "negative";
  return null;
}

function metalFactor(profile: RecipientProfile | null, sku: CatalogSku, rules: JewelryRules, loc: Locale = "en") {
  const signals: Omit<FitSignal, "points">[] = [];
  if (!profile) return { m: 0.5, signals };
  const { undertone, confidence, override } = effectiveUndertone(profile);
  const rule: RuleScore = rules.metalFit(sku.attributes.metal, undertone);
  const m = (clampWeight(rule.weight) + 1) / 2;
  const mEff = 0.5 + confidence * (m - 0.5);
  // English labels for the model input; the report language for the template text.
  const metal = rt("en", `metalText.${sku.attributes.metal}`);
  const who = rt("en", override ? "fit.who.choice" : "fit.who.estimate", { tone: rt("en", `undertone.${undertone}`) });
  const vars = { metal: rt(loc, `metalText.${sku.attributes.metal}`), who: rt(loc, override ? "fit.who.choice" : "fit.who.estimate", { tone: rt(loc, `undertone.${undertone}`) }) };
  const polarity = polarityOf(rule.strength);
  if (polarity === "positive") {
    signals.push({ factor: "metal", polarity, label: `${who} → ${metal}: recommended`, text: rs(loc, "fit.metal.good", vars) });
  } else if (polarity === "neutral") {
    signals.push({ factor: "metal", polarity, label: `${who} → ${metal}: acceptable`, text: rs(loc, "fit.metal.ok", vars) });
  } else if (polarity === "negative") {
    signals.push({ factor: "metal", polarity, label: `${who} → ${metal}: usually avoided`, text: rs(loc, "fit.metal.avoid", vars) });
  }
  if (!override && confidence < FIT_PARAMS.lowConfidence) {
    signals.push({
      factor: "confidence",
      polarity: "negative",
      label: "low-confidence undertone estimate",
      text: rs(loc, "fit.lowConfidence"),
    });
  }
  return { m: mEff, signals };
}

function styleFactor(profile: RecipientProfile | null, sku: CatalogSku, rules: JewelryRules, loc: Locale = "en") {
  if (!profile || profile.faceShape === "Unknown") return { s: 0.5 };
  const rule = rules.styleFit(sku.attributes, profile.faceShape);
  const s = (clampWeight(rule.weight) + 1) / 2;
  const polarity = polarityOf(rule.strength);
  if (!polarity) return { s };
  const faceOf = (l: Locale) => rt(l, "fit.face", { shape: rt(l, `faceShape.${profile.faceShape}`) });
  const face = faceOf("en");
  const style = styleText("en", sku);
  const label = `${face} → ${style}: ${rule.strength === "avoid" ? "usually avoided" : rule.strength}${rule.singleSource ? " (single source)" : ""}`;
  const local = faceOf(loc);
  const vars = { face: local, aFace: withArticle(local), style: styleText(loc, sku) };
  const text = rs(loc, polarity === "positive" ? "fit.style.good" : polarity === "neutral" ? "fit.style.ok" : "fit.style.avoid", vars);
  return { s, signal: { factor: "style" as const, polarity, label, text } };
}

function budgetFactor(sku: CatalogSku, request: FitRequestInput, loc: Locale = "en") {
  const min = request.budgetMin ?? 0;
  const range = min > 0 ? `${money(loc, min, request.currency)}–${money(loc, request.budgetMax, request.currency)}` : money(loc, request.budgetMax, request.currency);
  if (sku.currency !== request.currency) {
    return {
      b: 0,
      signal: { factor: "budget" as const, polarity: "negative" as const, label: "priced in a different currency", text: rs(loc, "fit.budget.currency", { currency: sku.currency }) },
    };
  }
  const p = sku.price;
  if (p >= min && p <= request.budgetMax) {
    return { b: 1, signal: { factor: "budget" as const, polarity: "positive" as const, label: "within budget", text: rs(loc, "fit.budget.within", { range }) } };
  }
  const over = p > request.budgetMax;
  const bound = over ? request.budgetMax : min;
  const d = bound > 0 ? Math.abs(p - bound) / bound : 1;
  const b = Math.max(0, 1 - d / FIT_PARAMS.budgetFalloff);
  const gap = money(loc, Math.abs(p - bound), request.currency);
  return over
    ? { b, signal: { factor: "budget" as const, polarity: "negative" as const, label: "over budget", text: rs(loc, "fit.budget.over", { gap, range }) } }
    : { b, signal: { factor: "budget" as const, polarity: "neutral" as const, label: "below budget", text: rs(loc, "fit.budget.below", { gap, range }) } };
}

function occasionFactor(sku: CatalogSku, request: FitRequestInput, loc: Locale = "en") {
  const occasion = rt(loc, `occasion.${request.occasion}`);
  if ((sku.attributes.occasions ?? []).includes(request.occasion)) {
    return { o: 1, signal: { factor: "occasion" as const, polarity: "positive" as const, label: `suits ${request.occasion}`, text: rs(loc, "fit.occasion.match", { occasion }) } };
  }
  return {
    o: FIT_PARAMS.occasionMissCredit,
    signal: { factor: "occasion" as const, polarity: "neutral" as const, label: `not tagged for ${request.occasion}`, text: rs(loc, "fit.occasion.miss", { occasion }) },
  };
}

const CAUTION_ORDER: FitFactor[] = ["hearts", "confidence", "metal", "style", "budget", "occasion"];

function pickReasons(signals: FitSignal[], sku: CatalogSku, request: FitRequestInput, noTryOn = false, loc: Locale = "en"): { reasons: string[]; caution: string } {
  const generic = genericCaution(loc, noTryOn);
  const positives = signals.filter((s) => s.polarity === "positive").sort((a, b) => b.points - a.points);
  const neutrals = signals.filter((s) => s.polarity === "neutral" && s.factor !== "hearts");
  const reasons = [...positives, ...neutrals].slice(0, 2).map((s) => s.text);
  if (reasons.length < 2) reasons.push(rs(loc, "fit.shortlist", { category: rt(loc, `category.${sku.category}`), occasion: rt(loc, `occasion.${request.occasion}`) }));
  if (reasons.length < 2) reasons.push(generic);
  const byOrder = (pol: SignalPolarity) =>
    CAUTION_ORDER.map((f) => signals.find((s) => s.factor === f && s.polarity === pol)).find(Boolean);
  const caution = byOrder("negative") ?? signals.find((s) => s.polarity === "neutral" && (s.factor === "metal" || s.factor === "style"));
  const cautionText = caution && !reasons.includes(caution.text) ? caution.text : generic;
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
  if (!ctx.noTryOn && ctx.noTryOnIds?.has(sku.id)) {
    const r = fitScore(profile, sku, request, rules, { ...ctx, noTryOn: true, noTryOnIds: undefined });
    return { ...r, tryOn: false };
  }
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
  const budget = budgetFactor(sku, request, ctx.locale);
  const occasion = occasionFactor(sku, request, ctx.locale);
  if (ctx.noTryOn) return scoreWithoutTryOn(sku, request, hearts, budget, occasion, ctx.locale);
  const metal = metalFactor(profile, sku, rules, ctx.locale);
  const style = styleFactor(profile, sku, rules, ctx.locale);

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

  const { reasons, caution } = pickReasons(signals, sku, request, false, ctx.locale);
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

/**
 * No try-on (FitContext.noTryOn): hearts and budget/occasion only, renormalised to 100
 * (FIT_WEIGHTS_NO_TRYON). The breakdown carries only the factors used; no metal or style signal exists,
 * so no reason, caution or explanation input can mention undertone, face shape or a try-on.
 */
function scoreWithoutTryOn(
  sku: CatalogSku,
  request: FitRequestInput,
  hearts: ReturnType<typeof heartsFactor>,
  budget: ReturnType<typeof budgetFactor>,
  occasion: ReturnType<typeof occasionFactor>,
  locale?: Locale,
): ScoredSku {
  const W = FIT_WEIGHTS_NO_TRYON;
  const pts = {
    hearts: W.hearts * hearts.h,
    budget: W.budgetOccasion * FIT_PARAMS.budgetShare * budget.b,
    occasion: W.budgetOccasion * (1 - FIT_PARAMS.budgetShare) * occasion.o,
  };
  const raw = pts.hearts + pts.budget + pts.occasion;
  const signals: FitSignal[] = [];
  if (hearts.signal) signals.push({ ...hearts.signal, points: pts.hearts });
  signals.push({ ...budget.signal, points: pts.budget });
  signals.push({ ...occasion.signal, points: pts.occasion });
  const { reasons, caution } = pickReasons(signals, sku, request, true, locale);
  return {
    skuId: sku.id,
    score: Math.round(Math.min(FIT_MAX, Math.max(0, raw))),
    breakdown: { hearts: round1(pts.hearts), budgetOccasion: round1(pts.budget + pts.occasion) },
    reasons,
    caution,
    signals,
    raw,
  };
}

/**
 * Mixed sets (user decision 2026-10-28, "tried-on pieces first"): a hearted piece scored without a try-on can
 * reach a higher number than a hearted piece that was tried on (80/20 vs 60/10/15/15), so among hearted pieces
 * the tried-on ones rank first; hearted "Not tried on" pieces follow; pieces without a heart come last.
 */
function mixedTier(s: ScoredSku): number {
  const hearted = s.signals.some((sig) => sig.factor === "hearts" && sig.label === "hearted");
  if (!hearted) return 2;
  return s.tryOn === false ? 1 : 0;
}

/** Scores every SKU, highest first (stable on ties); mixed sets rank by mixedTier first. */
export function scoreSkus(
  profile: RecipientProfile | null,
  skus: readonly CatalogSku[],
  request: FitRequestInput,
  rules: JewelryRules,
  ctx: FitContext = {},
): ScoredSku[] {
  const mixed = !ctx.noTryOn && (ctx.noTryOnIds?.size ?? 0) > 0;
  return skus
    .map((sku, i) => ({ s: fitScore(profile, sku, request, rules, ctx), i }))
    .sort((a, b) => (mixed ? mixedTier(a.s) - mixedTier(b.s) : 0) || b.s.raw - a.s.raw || a.i - b.i)
    .map((x) => x.s);
}

/** The giver-facing shape: exactly the FitResult fields, nothing else. */
export function toFitResult(s: FitResult): FitResult {
  const out: FitResult = {
    skuId: s.skuId,
    score: s.score,
    // Only the factors that were used (no metal/style without a try-on).
    breakdown: {
      hearts: s.breakdown.hearts,
      ...(s.breakdown.metal !== undefined ? { metal: s.breakdown.metal } : {}),
      ...(s.breakdown.style !== undefined ? { style: s.breakdown.style } : {}),
      budgetOccasion: s.breakdown.budgetOccasion,
    },
    reasons: [...s.reasons],
  };
  if (s.caution) out.caution = s.caution;
  if (s.variantId !== undefined) out.variantId = s.variantId;
  if (s.metal !== undefined) out.metal = s.metal;
  if (s.price !== undefined) out.price = s.price;
  if (s.wishOtherMetal) out.wishOtherMetal = true;
  if (s.tryOn === false) out.tryOn = false;
  return out;
}

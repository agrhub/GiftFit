/**
 * "Help me choose" curation (ADR-045). The giver gives a budget cap, an occasion and optionally
 * categories, a metal lock, style hints and a gender presentation; GiftFit picks 6–8 REAL candidates
 * the recipient tries on. There are no decoys in this mode: every item is something the giver may buy.
 *
 * The set is chosen to be informative: the recipient's hearts over a varied set tell the giver more
 * than hearts over six near-identical pieces. Rule set (documented in lib/fit/WEIGHTS.md "Curation"):
 *
 *  1. Pool. A design is eligible when it has ≥ 1 metal variant priced ≤ budgetMax, in the request
 *     currency and inside the metal lock (ADR-032, `eligibleVariants`), its default variant is
 *     try-on ready (vto_spec_ok + vto_image), and its category is in `categories` (absent/empty = all).
 *  2. Gender presentation (`attributes.gender_presentation`, missing = unisex), when the brief sets
 *     one, uses the decoy parity rule (`compatibleGenders`): feminine → feminine or unisex, masculine →
 *     masculine or unisex, unisex → unisex. Exact matches get a small bonus. Only if the compatible
 *     pool cannot fill the target are other presentations admitted (GENDER_RELAXED).
 *  3. Buckets. Each design covers one bucket per dimension: style family (`attributes.style`, first
 *     STYLE_FAMILIES word), category, silhouette (a small per-category shape bucket, `silhouetteOf`),
 *     and the default metal of its eligible variants.
 *  4. Greedy max coverage. Repeatedly add the design with the largest marginal gain:
 *       gain = 3·[new style] + C·[new category] + 2·[new silhouette] + 1·[new metal]
 *            + 4·[hinted style still under its quota] + 1.5·[exact gender match]
 *     C = 5 when the giver named categories (so each named category is represented), else 2.
 *     Style hints BIAS, never exclude: a hinted family keeps earning the hint bonus until it holds
 *     max(1, round(target / 2 / #hints)) designs, so about half the set leans to the hints.
 *  5. Tie-break among equal gains: 0.5·fit (catalog-only Fit Score: occasion tag, budget) + 0.2·price
 *     fit (closeness to 75% of the cap, log scale) + 0.3·seeded key (HMAC(FIT_DECOY_SECRET, request
 *     id)). The same request always gets the same set; different requests explore different pieces.
 *  6. Size. Stop at `target` (6) designs. Continue up to `max` (8) only while a named category or a
 *     hinted style family is still absent and the next design brings it (EXTENDED_FOR_COVERAGE), so
 *     the usual cost stays at 6 try-ons.
 *
 * Every pick records `why`: the buckets it newly covered when chosen (e.g. "style:minimal",
 * "silhouette:earring/hoop"), plus "hint:<family>" or "fill" — machine-readable for tests and audits.
 */
import { STYLE_FAMILIES, type StyleFamily } from "@/lib/contracts/api";
import type { CatalogSku, JewelryCategory, JewelryRules, Metal, MetalVariant, Occasion } from "@/lib/contracts/giftfit";
import { type GenderPresentation, compatibleGenders, genderOf, tryOnReady } from "./decoys";
import { seededKey } from "./rng";
import { fitScore } from "./score";
import { type VariantRequest, defaultVariant, eligibleVariants, variantView } from "./variants";

export const CURATE_DEFAULTS = {
  target: 6,
  max: 8,
  /** Fewer eligible designs than this: the request is refused (422 insufficient_catalog). */
  min: 4,
} as const;

/** Coverage weights per bucket dimension (category weight depends on whether categories were named). */
export const CURATE_WEIGHTS = {
  style: 3,
  category: 2,
  categoryNamed: 5,
  silhouette: 2,
  metal: 1,
  hint: 4,
  exactGender: 1.5,
} as const;

export const CATEGORY_ORDER: readonly JewelryCategory[] = ["earring", "necklace", "ring", "bracelet", "watch"];

export type CurateReasonCode = "GENDER_RELAXED" | "INSUFFICIENT_CATALOG" | "EXTENDED_FOR_COVERAGE" | "PRESENTATION_INFERRED";

export interface CurateBrief {
  occasion: Occasion;
  /** Empty/absent = all categories. */
  categories?: readonly JewelryCategory[];
  styleHints?: readonly StyleFamily[];
  genderPresentation?: GenderPresentation;
}

export interface CurateOptions extends CurateBrief {
  /** Unguessable per-request seed (curationSeed / decoySeed of the request id). */
  seed: string;
  request: VariantRequest;
  /** Jewelry rules for the catalog-only Fit Score tie-break; without them the occasion tag is used. */
  rules?: JewelryRules | null;
  target?: number;
  max?: number;
}

export interface CurateBuckets {
  style: string;
  category: JewelryCategory;
  silhouette: string;
  metal: Metal;
}

export interface CuratedPick {
  catalogId: string;
  /** The default eligible variant (what the recipient sees first, before tone matching). */
  variantId: string;
  metal: Metal;
  price: number;
  buckets: CurateBuckets;
  /** Buckets this pick newly covered when chosen; "hint:<family>"; "extended"; or "fill". */
  why: string[];
  gain: number;
}

export interface Curation {
  ids: string[];
  picks: CuratedPick[];
  reasons: CurateReasonCode[];
  /** Eligible designs (after budget, lock, category and gender rules). */
  poolSize: number;
  /** true when at least `min` designs were chosen. */
  ok: boolean;
}

// ---------------------------------------------------------------- buckets

/** First STYLE_FAMILIES word of `attributes.style` ("minimal classic" → "minimal"); else "other". */
export function styleFamilyOf(sku: CatalogSku): StyleFamily | "other" {
  const words = String(sku.attributes.style ?? "")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
  return (words.find((w) => (STYLE_FAMILIES as readonly string[]).includes(w)) as StyleFamily | undefined) ?? "other";
}

/**
 * A small silhouette bucket per category, from existing catalog attributes:
 *   earring  : earring_shape → stud | hoop | drop | chandelier | geometric
 *   necklace : necklace_style/length → choker (choker, heavy choker, collar/bib) | chain (thin chain)
 *              | long (long_vertical or ≥ 24 in) | pendant (pendants, large stone, geometric)
 *   ring     : signet (title) | band (title "band" or no stone) | cocktail (statement style or title) | gemstone
 *   bracelet : tennis | bangle (bangle, cuff) | beaded | chain (title words; chain is the default)
 *   watch    : strap → leather (leather, canvas) | metal (link, mesh) | rubber
 */
export function silhouetteOf(sku: CatalogSku): string {
  const a = sku.attributes;
  const title = sku.title.toLowerCase();
  switch (sku.category) {
    case "earring": {
      const s = a.earring_shape ?? "";
      if (s.startsWith("stud")) return "stud";
      if (s.startsWith("hoop")) return "hoop";
      if (s.startsWith("drop")) return "drop";
      if (s.startsWith("chandelier")) return "chandelier";
      if (s === "geometric_angular") return "geometric";
      return "drop";
    }
    case "necklace": {
      const s = a.necklace_style ?? "";
      if (s === "choker" || s === "choker_heavy" || s === "collar_bib_horizontal") return "choker";
      if (s === "thin_chain") return "chain";
      if (s === "long_vertical" || (a.necklace_length_in ?? 0) >= 24) return "long";
      return "pendant";
    }
    case "ring": {
      if (/\bsignet\b/.test(title)) return "signet";
      if (/\bband\b/.test(title) || !a.stone || a.stone === "none") return "band";
      if (/\bcocktail\b/.test(title) || styleFamilyOf(sku) === "statement") return "cocktail";
      return "gemstone";
    }
    case "bracelet": {
      if (/\btennis\b/.test(title)) return "tennis";
      if (/\b(bangle|cuff)\b/.test(title)) return "bangle";
      if (/\bbead(ed|s)?\b/.test(title)) return "beaded";
      return "chain";
    }
    case "watch": {
      const strap = String(a.strap ?? "");
      if (strap.startsWith("leather") || strap === "canvas") return "leather";
      if (strap === "link" || strap === "mesh") return "metal";
      if (strap === "rubber") return "rubber";
      return "watch";
    }
    default:
      return "other";
  }
}

/** Giver-facing words for a silhouette bucket ("hoops", "leather-strap watches"). */
export const SILHOUETTE_LABEL: Record<string, string> = {
  "earring/stud": "studs",
  "earring/hoop": "hoops",
  "earring/drop": "drop earrings",
  "earring/chandelier": "chandelier earrings",
  "earring/geometric": "geometric earrings",
  "necklace/choker": "chokers and collars",
  "necklace/chain": "fine chains",
  "necklace/long": "long necklaces",
  "necklace/pendant": "pendants",
  "ring/signet": "signet rings",
  "ring/band": "bands",
  "ring/cocktail": "cocktail rings",
  "ring/gemstone": "gemstone rings",
  "bracelet/tennis": "tennis bracelets",
  "bracelet/bangle": "bangles and cuffs",
  "bracelet/beaded": "beaded bracelets",
  "bracelet/chain": "chain bracelets",
  "watch/leather": "leather-strap watches",
  "watch/metal": "metal-bracelet watches",
  "watch/rubber": "sport-strap watches",
  "watch/watch": "watches",
};

export function bucketsOf(sku: CatalogSku, variant: Pick<MetalVariant, "metal">): CurateBuckets {
  return { style: styleFamilyOf(sku), category: sku.category, silhouette: `${sku.category}/${silhouetteOf(sku)}`, metal: variant.metal };
}

// ---------------------------------------------------------------- pool

interface Candidate {
  sku: CatalogSku;
  variant: MetalVariant;
  buckets: CurateBuckets;
  gender: GenderPresentation;
  /** Tie-break in [0, 1]. */
  tie: number;
}

/** Allowed presentations for a brief's gender presentation (decoy parity rule); null = any. */
export function allowedGenders(g: GenderPresentation | undefined): Set<GenderPresentation> | null {
  if (!g) return null;
  // compatibleGenders on a stand-in design of that presentation with no other picks.
  return compatibleGenders({ attributes: { gender_presentation: g } } as CatalogSku, []);
}

/** The presentation side with more designs (feminine vs masculine; unisex fits both); undefined if neither. */
export function inferSide(genders: readonly GenderPresentation[], seed: string): GenderPresentation | undefined {
  const fem = genders.filter((g) => g === "feminine").length;
  const masc = genders.filter((g) => g === "masculine").length;
  if (fem === 0 && masc === 0) return undefined;
  if (fem !== masc) return fem > masc ? "feminine" : "masculine";
  return seededKey(`${seed}:side`, "presentation") < 0.5 ? "feminine" : "masculine";
}

/** Price fit in [0, 1]: 1 at 75% of the cap, falling on a log scale (0 at 4× away). */
export function priceFit(price: number, cap: number): number {
  if (!(price > 0) || !(cap > 0)) return 0;
  return Math.max(0, 1 - Math.abs(Math.log(price / (0.75 * cap))) / Math.log(4));
}

/** Eligible designs with their default variant (no gender rule). */
export function eligiblePool(catalog: readonly CatalogSku[], request: VariantRequest, categories?: readonly JewelryCategory[]): Array<{ sku: CatalogSku; variant: MetalVariant }> {
  const cats = categories && categories.length > 0 ? new Set(categories) : null;
  return catalog.flatMap((sku) => {
    if (cats && !cats.has(sku.category)) return [];
    if (eligibleVariants(sku, request).length === 0) return [];
    const variant = defaultVariant(sku, request);
    if (!variant || !tryOnReady(variantView(sku, variant))) return [];
    return [{ sku, variant }];
  });
}

// ---------------------------------------------------------------- greedy

/** Weighted coverage of a set: Σ weight × distinct buckets per dimension (no hint or gender terms). */
export function coverageValue(buckets: readonly CurateBuckets[], categoriesNamed = false): number {
  const W = CURATE_WEIGHTS;
  const n = (k: keyof CurateBuckets) => new Set(buckets.map((b) => b[k])).size;
  return W.style * n("style") + (categoriesNamed ? W.categoryNamed : W.category) * n("category") + W.silhouette * n("silhouette") + W.metal * n("metal");
}

export function curate(catalog: readonly CatalogSku[], opts: CurateOptions): Curation {
  const target = opts.target ?? CURATE_DEFAULTS.target;
  const max = Math.max(target, opts.max ?? CURATE_DEFAULTS.max);
  const reasons = new Set<CurateReasonCode>();
  const namedCats = opts.categories && opts.categories.length > 0 ? [...new Set(opts.categories)] : [];
  const hints = [...new Set(opts.styleHints ?? [])];
  const W = CURATE_WEIGHTS;
  const catWeight = namedCats.length > 0 ? W.categoryNamed : W.category;
  const hintQuota = hints.length > 0 ? Math.max(1, Math.round(target / 2 / hints.length)) : 0;

  const input = { occasion: opts.occasion, budgetMax: opts.request.budgetMax, currency: opts.request.currency, shortlistIds: [], ...(opts.request.metalLock ? { metalLock: [...opts.request.metalLock] } : {}) };
  const fitOf = (sku: CatalogSku, v: MetalVariant): number => {
    if (opts.rules) return Math.min(1, Math.max(0, fitScore(null, variantView(sku, v), input, opts.rules).raw / 100));
    return (sku.attributes.occasions ?? []).includes(opts.occasion) ? 1 : 0.3;
  };

  const base = eligiblePool(catalog, opts.request, namedCats);
  // "Any" presentation still never mixes: keep one side plus unisex (ADR-045 default). The side is the
  // one with more eligible designs; a tie is broken by the request seed.
  const side = opts.genderPresentation ?? inferSide(base.map((c) => genderOf(c.sku)), opts.seed);
  if (!opts.genderPresentation && side) reasons.add("PRESENTATION_INFERRED");
  const allowed = allowedGenders(side);
  const toCand = ({ sku, variant }: { sku: CatalogSku; variant: MetalVariant }): Candidate => ({
    sku,
    variant,
    buckets: bucketsOf(sku, variant),
    gender: genderOf(sku),
    tie: 0.5 * fitOf(sku, variant) + 0.2 * priceFit(variant.price, opts.request.budgetMax) + 0.3 * seededKey(`${opts.seed}:curate`, sku.id),
  });
  const compatible = base.filter((c) => !allowed || allowed.has(genderOf(c.sku))).map(toCand);
  // Catalog too thin for the presentation: others are admitted, but only once no compatible design is left.
  const others = allowed && compatible.length < target ? base.filter((c) => !allowed.has(genderOf(c.sku))).map(toCand) : [];
  const pool = [...compatible, ...others];
  const poolSize = pool.length;

  const covered = { style: new Set<string>(), category: new Set<string>(), silhouette: new Set<string>(), metal: new Set<string>() };
  const styleCount = new Map<string, number>();
  const exact = (c: Candidate) => Boolean(opts.genderPresentation) && c.gender === opts.genderPresentation;
  const gainOf = (c: Candidate) => {
    const b = c.buckets;
    let g = 0;
    if (!covered.style.has(b.style)) g += W.style;
    if (!covered.category.has(b.category)) g += catWeight;
    if (!covered.silhouette.has(b.silhouette)) g += W.silhouette;
    if (!covered.metal.has(b.metal)) g += W.metal;
    if ((hints as string[]).includes(b.style) && (styleCount.get(b.style) ?? 0) < hintQuota) g += W.hint;
    if (exact(c)) g += W.exactGender;
    return g;
  };
  const whyOf = (c: Candidate): string[] => {
    const b = c.buckets;
    const why: string[] = [];
    if (!covered.style.has(b.style)) why.push(`style:${b.style}`);
    if (!covered.category.has(b.category)) why.push(`category:${b.category}`);
    if (!covered.silhouette.has(b.silhouette)) why.push(`silhouette:${b.silhouette}`);
    if (!covered.metal.has(b.metal)) why.push(`metal:${b.metal}`);
    if ((hints as string[]).includes(b.style) && (styleCount.get(b.style) ?? 0) < hintQuota) why.push(`hint:${b.style}`);
    return why.length > 0 ? why : ["fill"];
  };
  const best = (cands: readonly Candidate[]): Candidate | undefined => {
    let top: Candidate | undefined;
    let topGain = -Infinity;
    for (const c of cands) {
      const g = gainOf(c);
      if (g > topGain + 1e-9 || (Math.abs(g - topGain) <= 1e-9 && top && (c.tie > top.tie + 1e-12 || (Math.abs(c.tie - top.tie) <= 1e-12 && c.sku.id < top.sku.id)))) {
        top = c;
        topGain = g;
      }
    }
    return top;
  };

  const picks: CuratedPick[] = [];
  const remaining = [...pool];
  const othersSet = new Set(others);
  /** Compatible designs first; designs of other presentations only when none is left. */
  const usable = (cands: readonly Candidate[]) => {
    const first = cands.filter((c) => !othersSet.has(c));
    return first.length > 0 ? first : cands;
  };
  const take = (c: Candidate, extra: string[] = []) => {
    if (othersSet.has(c)) reasons.add("GENDER_RELAXED");
    picks.push({ catalogId: c.sku.id, variantId: c.variant.variantId, metal: c.variant.metal, price: c.variant.price, buckets: c.buckets, why: [...whyOf(c), ...extra], gain: Math.round(gainOf(c) * 100) / 100 });
    covered.style.add(c.buckets.style);
    covered.category.add(c.buckets.category);
    covered.silhouette.add(c.buckets.silhouette);
    covered.metal.add(c.buckets.metal);
    styleCount.set(c.buckets.style, (styleCount.get(c.buckets.style) ?? 0) + 1);
    remaining.splice(remaining.indexOf(c), 1);
  };

  // Greedy to `target`, then a 1-swap local search on the same objective (strict improvements only,
  // so the seeded tie-breaks survive), then replay in order to record each pick's `why`.
  const chosen: Candidate[] = [];
  {
    const left = [...pool];
    const reset = () => {
      for (const s of Object.values(covered)) s.clear();
      styleCount.clear();
    };
    const mark = (c: Candidate) => {
      covered.style.add(c.buckets.style);
      covered.category.add(c.buckets.category);
      covered.silhouette.add(c.buckets.silhouette);
      covered.metal.add(c.buckets.metal);
      styleCount.set(c.buckets.style, (styleCount.get(c.buckets.style) ?? 0) + 1);
    };
    /** Objective of a set = the sum of its greedy gains in any order. */
    const objective = (set: readonly Candidate[]) => {
      reset();
      let v = 0;
      for (const c of set) {
        v += gainOf(c);
        mark(c);
      }
      return v;
    };
    /** Greedy completion from a forced first pick (or none). */
    const greedyFrom = (first?: Candidate): Candidate[] => {
      reset();
      const set: Candidate[] = [];
      const rest = [...pool];
      const add = (c: Candidate) => {
        set.push(c);
        rest.splice(rest.indexOf(c), 1);
        mark(c);
      };
      if (first) add(first);
      while (set.length < target && rest.length > 0) add(best(usable(rest))!);
      return set;
    };
    // Restarts: the seeded greedy, then greedy from every possible first pick; a strictly better
    // objective wins, ties keep the earlier run (the seeded one first).
    let bestSet = greedyFrom();
    let bestVal = objective(bestSet);
    for (const first of usable(pool)) {
      const set = greedyFrom(first);
      const v = objective(set);
      if (v > bestVal + 1e-9) {
        bestSet = set;
        bestVal = v;
      }
    }
    chosen.push(...bestSet);
    for (const c of chosen) left.splice(left.indexOf(c), 1);
    const compatibleLeft = () => left.some((c) => !othersSet.has(c));
    let current = objective(chosen);
    for (let round = 0, improved = true; improved && round < 10; round++) {
      improved = false;
      for (let i = 0; i < chosen.length; i++) {
        for (const c of [...left]) {
          // Never swap a compatible design out for another presentation.
          if (othersSet.has(c) && !othersSet.has(chosen[i]) && compatibleLeft()) continue;
          const trial = chosen.map((x, j) => (j === i ? c : x));
          const v = objective(trial);
          if (v > current + 1e-9) {
            left.splice(left.indexOf(c), 1, chosen[i]);
            chosen[i] = c;
            current = v;
            improved = true;
          }
        }
      }
    }
    reset();
  }
  for (const c of chosen) take(c);

  // Extension (≤ max): only to bring in a named category or a hinted style family still absent.
  while (picks.length < max && remaining.length > 0) {
    const missingCats = namedCats.filter((c) => !covered.category.has(c));
    const missingHints = hints.filter((h) => !covered.style.has(h));
    if (missingCats.length === 0 && missingHints.length === 0) break;
    const helpful = remaining.filter((c) => missingCats.includes(c.buckets.category) || (missingHints as string[]).includes(c.buckets.style));
    const next = best(usable(helpful));
    if (!next) break;
    take(next, ["extended"]);
    reasons.add("EXTENDED_FOR_COVERAGE");
  }

  const ok = picks.length >= Math.min(CURATE_DEFAULTS.min, target);
  if (picks.length < target) reasons.add("INSUFFICIENT_CATALOG");
  return { ids: picks.map((p) => p.catalogId), picks, reasons: [...reasons], poolSize, ok };
}

/** Infers a gender presentation from a set of designs: all masculine/unisex → masculine, etc. */
export function inferGender(skus: readonly CatalogSku[]): GenderPresentation | undefined {
  const gs = new Set(skus.map(genderOf));
  if (gs.has("masculine") && !gs.has("feminine")) return "masculine";
  if (gs.has("feminine") && !gs.has("masculine")) return "feminine";
  return undefined;
}

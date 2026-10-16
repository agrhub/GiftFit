/**
 * Decoy mixing (MASTER_PLAN v2 G5, §4.4). The recipient tries on the giver's shortlist mixed with
 * decoys she cannot tell apart, in a seeded random order, so she gives input without learning the pick.
 *
 * Algorithm (documented in lib/fit/WEIGHTS.md "Decoys"):
 *  1. Decoys needed = max(minDecoys, carouselSize − shortlist size) → 6 items in total by default.
 *  2. Each decoy "shadows" one shortlist item; slots are dealt round-robin, most visually isolated
 *     shortlist item first (so none is left without a look-alike), ties in seeded order.
 *  3. For a shadowed item s needing k decoys, candidates are tried in tiers. Every tier above 0 adds a
 *     reason code; all tiers keep currency, try-on readiness (vto_spec_ok + vto_image) and "not in
 *     the shortlist, not already used":
 *       tier 0                      same category, same metal tone, style Jaccard ≥ 0.3, price ±20% of s
 *       tier 1  STYLE_RELAXED       same category, same metal tone, price ±20%
 *       tier 2  METAL_RELAXED       same category, price ±20%
 *       tier 3  PRICE_BAND_WIDENED  same category, price ±35%
 *       tier 4  CATEGORY_RELAXED    any category (shortlist categories first), price ±35%
 *     If the catalog still cannot supply enough, the result carries INSUFFICIENT_CATALOG and ok=false.
 *  4. Price-rank balancing (anti-centroid): a seeded r, uniform over the feasible range, sets how many
 *     of s's k decoys are cheaper than s, so s is not systematically the middle (or an end) of its
 *     group's prices. To make every r ∈ [0, k] feasible the pool may widen up to tier 2 (still same
 *     category, ±20%); if it still cannot, r is drawn from what is feasible and the soft code
 *     PRICE_SPREAD_SKEWED is reported. For k ≥ 2 a seeded search (balanceCentrality) also targets
 *     s's price-spread and visible-centrality ranks.
 *  5. On each side, candidates rank by tier, then similarity to s (same metal, shared style tokens),
 *     ties broken by a seeded key: the same seed always yields the same decoys.
 *  6. Carousel order = seeded Fisher-Yates shuffle of shortlist ∪ decoys.
 *  7. Metal variants (ADR-032), when `request` is given: each design is compared as its default
 *     eligible variant (price ≤ cap, inside the metal lock), designs with no eligible variant are
 *     never decoys, so decoy swatches obey the same cap and lock as the shortlist. Swatch parity:
 *     inside tiers 0–2, when the pool can give all k decoys the shadow's swatch count ("parity
 *     mode"), candidates rank by |eligible swatches − shadow's swatches| then the same default metal,
 *     every decoy gets the same count, and the pool may reach into tier 2; otherwise (leveling would
 *     cap the swatches anyway) the same default metal ranks first, then the count gap; both before
 *     style. The anti-centroid search adds the parity gap to its cost. Leveling (variants.ts
 *     swatchCap) then caps swatch counts so the most-metals design is never more likely a pick.
 *  8. Gender-presentation parity (`compatibleGenders`): a decoy's `attributes.gender_presentation`
 *     (missing = unisex) must suit its pick: masculine → masculine or unisex, feminine → feminine or
 *     unisex, unisex → unisex plus the gendered presentations among the picks. Exact matches rank
 *     first. Only when the compatible pool cannot fill k are other presentations used
 *     (GENDER_RELAXED, a hard reason code).
 */
import type { CatalogSku, JewelryCategory } from "@/lib/contracts/giftfit";
import { jaccard, skuSimilarity, styleTokens } from "./labels";
import { seededKey, seededRandom, seededShuffle } from "./rng";
import { SWATCH_LABEL, type VariantRequest, defaultVariant, eligibleVariants, swatchCap, variantView, variantsOf, visibleVariants } from "./variants";

export const DECOY_DEFAULTS = {
  carouselSize: 6,
  minDecoys: 2,
  priceBand: 0.2,
  widenedPriceBand: 0.35,
  minStyleJaccard: 0.3,
} as const;

export type DecoyReasonCode =
  | "STYLE_RELAXED"
  | "METAL_RELAXED"
  | "PRICE_BAND_WIDENED"
  | "CATEGORY_RELAXED"
  | "INSUFFICIENT_CATALOG"
  | "EMPTY_SHORTLIST"
  /** A decoy's gender presentation is outside its pick's compatible set (catalog too thin). */
  | "GENDER_RELAXED"
  /** Soft: some decoys came from outside the anti-centroid price window (still within the band). */
  | "PRICE_SPREAD_SKEWED";

/** Codes that mean a decoy constraint was actually relaxed or not met. */
export const HARD_DECOY_REASONS: ReadonlySet<DecoyReasonCode> = new Set([
  "STYLE_RELAXED",
  "METAL_RELAXED",
  "PRICE_BAND_WIDENED",
  "CATEGORY_RELAXED",
  "INSUFFICIENT_CATALOG",
  "EMPTY_SHORTLIST",
  "GENDER_RELAXED",
]);

export type GenderPresentation = "feminine" | "masculine" | "unisex";

/** `attributes.gender_presentation`; a missing value counts as unisex. */
export function genderOf(sku: CatalogSku): GenderPresentation {
  return sku.attributes.gender_presentation ?? "unisex";
}

/**
 * Gender-presentation parity: the presentations a decoy for pick `s` may have. Masculine picks take
 * masculine or unisex decoys, feminine picks feminine or unisex; a unisex pick takes unisex, plus the
 * gendered presentations already among the picks (so a men's shortlist stays a men's carousel).
 * An exact match ranks before unisex.
 */
export function compatibleGenders(s: CatalogSku, shortlist: readonly CatalogSku[]): Set<GenderPresentation> {
  const g = genderOf(s);
  if (g !== "unisex") return new Set<GenderPresentation>([g, "unisex"]);
  const context = shortlist.map(genderOf).filter((x) => x !== "unisex");
  return new Set<GenderPresentation>(["unisex", ...context]);
}

export type DecoyTier = 0 | 1 | 2 | 3 | 4;

export interface DecoyPick {
  decoyId: string;
  /** The shortlist item this decoy shadows. */
  shadowOf: string;
  tier: DecoyTier;
  similarity: number;
  /** decoy price / shadowed price. */
  priceRatio: number;
}

export interface DecoyOptions {
  /** Unguessable per-request seed (e.g. HMAC(server secret, fit request id), see api.ts decoySeed). */
  seed: string;
  carouselSize?: number;
  minDecoys?: number;
  priceBand?: number;
  widenedPriceBand?: number;
  minStyleJaccard?: number;
  /**
   * Budget cap, currency and optional metal lock (ADR-032). When set, every SKU is compared as its
   * default eligible variant, SKUs with no eligible variant are never decoys, and decoys are matched
   * on their eligible-swatch count (parity rule, see selectDecoys).
   */
  request?: VariantRequest;
}

export interface DecoySelection {
  decoyIds: string[];
  picks: DecoyPick[];
  /** Reason codes for every relaxation; empty when all decoys met tier 0 inside the price window. */
  reasons: DecoyReasonCode[];
  /** true when the carousel was filled with at least `minDecoys` decoys. */
  ok: boolean;
  requested: number;
  /** Shortlist ∪ decoys in seeded random order: what the recipient's carousel shows. */
  carouselIds: string[];
}

const TIER_REASON: Record<Exclude<DecoyTier, 0>, DecoyReasonCode> = {
  1: "STYLE_RELAXED",
  2: "METAL_RELAXED",
  3: "PRICE_BAND_WIDENED",
  4: "CATEGORY_RELAXED",
};

type Opts = Required<Omit<DecoyOptions, "seed" | "request">>;

export function tryOnReady(sku: CatalogSku): boolean {
  return sku.attributes.vto_spec_ok === true && Boolean(sku.attributes.vto_image);
}

function eligible(s: CatalogSku, c: CatalogSku, tier: DecoyTier, o: Opts): boolean {
  if (c.currency !== s.currency || !tryOnReady(c) || !(s.price > 0)) return false;
  const band = tier >= 3 ? o.widenedPriceBand : o.priceBand;
  if (Math.abs(c.price / s.price - 1) > band + 1e-9) return false;
  if (tier <= 3 && c.category !== s.category) return false;
  if (tier <= 1 && c.attributes.metal_tone !== s.attributes.metal_tone) return false;
  if (tier === 0 && jaccard(styleTokens(c), styleTokens(s)) < o.minStyleJaccard) return false;
  return true;
}

/** Visible fields the recipient can compare: category, metal, price. */
export interface VisibleFields {
  category: string;
  metal: string;
  price: number;
}

/** Similarity on recipient-visible fields only, in [0, 3]: same category + same metal + price closeness. */
export function visibleSimilarity(a: VisibleFields, b: VisibleFields): number {
  const cat = a.category === b.category ? 1 : 0;
  const metal = a.metal === b.metal ? 1 : 0;
  const price = 1 - Math.min(1, Math.abs(a.price - b.price) / Math.max(a.price, b.price, 1e-9));
  return cat + metal + price;
}

const visible = (s: CatalogSku): VisibleFields => ({ category: s.category, metal: s.attributes.metal, price: s.price });

/** Number of group members strictly more central than member `i` (0 = the most central). */
function centralityRank(group: VisibleFields[], i: number): number {
  const cent = group.map((g, a) => group.reduce((sum, h, b) => (a === b ? sum : sum + visibleSimilarity(g, h)), 0));
  return cent.filter((c, j) => j !== i && c > cent[i] + 1e-9).length;
}

/** Number of group members whose prices sit closer to the rest (log scale) than member `i` (0 = price centroid). */
function spreadRank(group: VisibleFields[], i: number): number {
  const spread = group.map((g) => group.reduce((sum, h) => sum + Math.abs(Math.log(g.price) - Math.log(h.price)), 0));
  return spread.filter((v, j) => j !== i && v < spread[i] - 1e-12).length;
}

const SEARCH_POOL = 14;
const SEARCH_SAMPLES = 96;

type Cand = { c: CatalogSku; tier: DecoyTier; sim: number; parity: number };

/**
 * Anti-centroid search for groups with k ≥ 2 decoys: s gets three seeded target ranks (price rank r,
 * price-spread rank, visible-centrality rank); we sample decoy sets from the best candidates and keep
 * the one closest to all three targets (quality — tier and similarity — breaks ties). Without this,
 * s is the natural centre of decoys that are all "within ±20% of s".
 */
function balanceCentrality(s: CatalogSku, initial: Cand[], pool: Cand[], rTarget: number, rand: () => number): Cand[] {
  const k = initial.length;
  // Independent seeded targets for s's visible-centrality rank and price-spread rank (0 = most central).
  const rho = Math.floor(rand() * (k + 1));
  const rhoSpread = Math.floor(rand() * (k + 1));
  const cost = (set: Cand[]) => {
    const group = [visible(s), ...set.map((x) => visible(x.c))];
    const priceRank = set.filter((x) => x.c.price < s.price).length;
    const quality = set.reduce((q, x) => q + 0.02 * x.tier + 0.02 * (1 - x.sim) + x.parity, 0);
    return (
      Math.abs(centralityRank(group, 0) - rho) +
      Math.abs(priceRank - rTarget) +
      Math.abs(spreadRank(group, 0) - rhoSpread) +
      quality
    );
  };
  let best = initial;
  let bestCost = cost(initial);
  const idx = pool.map((_, i) => i);
  for (let n = 0; n < SEARCH_SAMPLES; n++) {
    for (let i = 0; i < k; i++) {
      const j = i + Math.floor(rand() * (idx.length - i));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    const set = idx.slice(0, k).map((i) => pool[i]);
    const c = cost(set);
    if (c < bestCost - 1e-12) {
      best = set;
      bestCost = c;
    }
  }
  return best;
}

interface ShadowPool {
  s: CatalogSku;
  /** Gender-compatible candidates for this pick, best first (as ranked during selection). */
  cands: Cand[];
  allowed: Set<GenderPresentation>;
}

/**
 * Gender share parity (after per-pick selection): the decoys should carry each gendered presentation
 * in the same share as the picks (a recipient may reason "he would buy me masculine pieces"). When a
 * presentation is short among the decoys, a decoy whose pick also accepts it is swapped for a
 * candidate with that presentation from the same pick's pool, no wider a tier, preferring the same
 * default metal. Swaps never break a pick's compatible set.
 */
function balanceGenderShares(
  shortlist: readonly CatalogSku[],
  catalog: readonly CatalogSku[],
  picks: DecoyPick[],
  pools: ReadonlyMap<string, ShadowPool>,
  used: Set<string>,
): void {
  if (picks.length === 0) return;
  const byId = new Map(catalog.map((c) => [c.id, c]));
  for (const v of ["masculine", "feminine"] as const) {
    const target = Math.round((shortlist.filter((x) => genderOf(x) === v).length * picks.length) / shortlist.length);
    let have = picks.filter((p) => genderOf(byId.get(p.decoyId)!) === v).length;
    for (let i = 0; i < picks.length && have < target; i++) {
      const p = picks[i];
      const current = byId.get(p.decoyId)!;
      const pool = pools.get(p.shadowOf);
      // A gendered pick keeps an exact-match decoy; a unisex pick's decoy may move to v.
      if (!pool || genderOf(current) === v || !pool.allowed.has(v) || (genderOf(pool.s) !== "unisex" && genderOf(current) === genderOf(pool.s))) continue;
      const options = pool.cands.filter((x) => genderOf(x.c) === v && !used.has(x.c.id) && x.tier <= p.tier);
      const pick = options.find((x) => x.c.attributes.metal === current.attributes.metal) ?? options[0];
      if (!pick) continue;
      used.delete(p.decoyId);
      used.add(pick.c.id);
      picks[i] = { decoyId: pick.c.id, shadowOf: p.shadowOf, tier: pick.tier, similarity: pick.sim, priceRatio: pick.c.price / pool.s.price };
      have++;
    }
  }
}

export function selectDecoys(shortlist: readonly CatalogSku[], catalog: readonly CatalogSku[], opts: DecoyOptions): DecoySelection {
  const o: Opts & { seed: string; request?: VariantRequest } = { ...DECOY_DEFAULTS, ...opts };
  const reasons = new Set<DecoyReasonCode>();
  // Variant projection: compare each design as its default eligible variant; count its swatches.
  const swatchCount = new Map<string, number>();
  const project = (list: readonly CatalogSku[]): CatalogSku[] =>
    list.flatMap((sku) => {
      if (!o.request) {
        swatchCount.set(sku.id, variantsOf(sku).length);
        return [sku];
      }
      const eligible = eligibleVariants(sku, o.request);
      const def = defaultVariant(sku, o.request);
      if (!def) return [];
      swatchCount.set(sku.id, eligible.length);
      return [variantView(sku, def)];
    });
  const projectedShortlist = project(shortlist);
  const projectedCatalog = project(catalog);
  shortlist = projectedShortlist.length === shortlist.length ? projectedShortlist : shortlist;
  catalog = projectedCatalog;
  const parity = (a: CatalogSku, b: CatalogSku) => Math.abs((swatchCount.get(a.id) ?? 1) - (swatchCount.get(b.id) ?? 1));
  const shortlistIds = new Set(shortlist.map((s) => s.id));
  if (shortlist.length === 0) {
    return { decoyIds: [], picks: [], reasons: ["EMPTY_SHORTLIST"], ok: false, requested: 0, carouselIds: [] };
  }
  const requested = Math.max(o.minDecoys, o.carouselSize - shortlist.length);
  const rand = seededRandom(`${o.seed}:decoys`);

  // Deal decoy slots round-robin, most isolated shortlist item first (so no shortlist item is left
  // without a look-alike when there are fewer decoys than items), ties in seeded order.
  const isolation = (s: CatalogSku) =>
    Math.max(0, ...shortlist.filter((x) => x.id !== s.id).map((x) => visibleSimilarity(visible(s), visible(x))));
  const order = seededShuffle(shortlist, `${o.seed}:shadows`).sort((a, b) => isolation(a) - isolation(b));
  const slots = new Map<string, number>();
  for (let i = 0; i < requested; i++) {
    const s = order[i % order.length];
    slots.set(s.id, (slots.get(s.id) ?? 0) + 1);
  }

  const used = new Set<string>(shortlistIds);
  const categories = new Set(shortlist.map((s) => s.category));
  const pool = catalog.filter((c) => !shortlistIds.has(c.id));
  const picks: DecoyPick[] = [];
  const shortlistMetals = shortlist.map((x) => x.attributes.metal as string);
  const coveredMetals: string[] = [];
  const shadowPools = new Map<string, ShadowPool>();

  for (const s of order) {
    const k = slots.get(s.id) ?? 0;
    if (k === 0) continue;
    // Each candidate's best (lowest) tier and its swatch-count gap to s. Gender-presentation parity:
    // only compatible presentations unless the catalog cannot fill k (then GENDER_RELAXED).
    const allowedGenders = compatibleGenders(s, shortlist);
    const all: Cand[] = [];
    for (const c of pool) {
      if (used.has(c.id)) continue;
      const tier = ([0, 1, 2, 3, 4] as DecoyTier[]).find((t) => eligible(s, c, t, o));
      if (tier !== undefined) all.push({ c, tier, sim: skuSimilarity(c, s), parity: parity(c, s) });
    }
    const compatible = all.filter((x) => allowedGenders.has(genderOf(x.c)));
    const cands: Cand[] = compatible.length >= k ? compatible : all;
    const genderRank = (x: Cand) => (genderOf(x.c) === genderOf(s) ? 0 : allowedGenders.has(genderOf(x.c)) ? 1 : 2);
    // Inside tiers 0–2 (all same category, ±20%) the directly visible things rank before style.
    // Parity mode: when the pool can give ALL k decoys the shadow's swatch count, count parity comes
    // first (so leveling can keep every metal visible). Otherwise leveling will cap the swatches anyway,
    // and the default metal (the first render, and after leveling often the only swatch) comes first.
    const group = (t: DecoyTier) => (t <= 2 ? 0 : t);
    const multiShadow = (swatchCount.get(s.id) ?? 1) > 1;
    const parityMode = multiShadow && cands.filter((x) => x.tier <= 2 && x.parity === 0).length >= k;
    const metalGap = (x: Cand) => Number(x.c.attributes.metal !== s.attributes.metal);
    cands.sort(
      (a, b) =>
        Number(genderRank(a) === 2) - Number(genderRank(b) === 2) ||
        group(a.tier) - group(b.tier) ||
        genderRank(a) - genderRank(b) ||
        (parityMode ? a.parity - b.parity || metalGap(a) - metalGap(b) : metalGap(a) - metalGap(b) || a.parity - b.parity) ||
        a.tier - b.tier ||
        Number(categories.has(b.c.category)) - Number(categories.has(a.c.category)) ||
        b.sim - a.sim ||
        seededKey(o.seed, a.c.id) - seededKey(o.seed, b.c.id),
    );
    const upTo = (t: number) => cands.filter((x) => x.tier <= t);
    const cheaperIn = (xs: typeof cands) => xs.filter((x) => x.c.price < s.price);
    const pricierIn = (xs: typeof cands) => xs.filter((x) => x.c.price >= s.price);

    // Smallest tier that fills k; then, only if that makes every price rank r ∈ [0, k] for s
    // feasible, widen up to tier 2 (still same category, ±20%).
    const fullRange = (t: number) => cheaperIn(upTo(t)).length >= k && pricierIn(upTo(t)).length >= k;
    let T = ([0, 1, 2, 3, 4] as DecoyTier[]).find((t) => upTo(t).length >= k) ?? 4;
    if (!fullRange(T)) T = ([T, 1, 2] as DecoyTier[]).find((t) => t >= T && fullRange(t)) ?? T;
    // Parity extension: a multi-swatch item may reach into tier 2 (same category, ±20%) when that
    // offers a decoy with a closer swatch count.
    const bestParity = (t: number) => Math.min(Infinity, ...upTo(t).map((x) => x.parity));
    if (T < 2 && parityMode && bestParity(2) < bestParity(T)) T = 2;
    // Gender extension: reach into tier 2 (same category, ±20%) for an exact gender-presentation match.
    if (T < 2 && !upTo(T).some((x) => genderRank(x) === 0) && upTo(2).some((x) => genderRank(x) === 0)) T = 2;
    const usable = upTo(T);
    const cheaper = cheaperIn(usable);
    const pricier = pricierIn(usable);
    const rMin = Math.max(0, k - pricier.length);
    const rMax = Math.min(k, cheaper.length);
    let chosen: typeof cands;
    if (rMin > rMax) {
      chosen = usable.slice(0, k); // not enough candidates at all
    } else {
      if (rMin > 0 || rMax < k) reasons.add("PRICE_SPREAD_SKEWED");
      const r = rMin + Math.floor(rand() * (rMax - rMin + 1));
      chosen = [...cheaper.slice(0, r), ...pricier.slice(0, k - r)];
      if (k >= 2 && usable.length > k) chosen = balanceCentrality(s, chosen, [...cheaper.slice(0, SEARCH_POOL / 2), ...pricier.slice(0, SEARCH_POOL / 2)], r, rand);
    }
    // Swatch parity guarantee (parity mode): every decoy of a multi-swatch item gets its swatch count
    // (each replaces the chosen decoy with the worst count gap). Swatch counts are directly visible, so
    // this outranks price-rank balance.
    if (parityMode) {
      for (const match of usable.filter((x) => x.parity === 0 && genderRank(x) < 2 && !chosen.includes(x))) {
        if (chosen.every((x) => x.parity === 0)) break;
        const worst = chosen.reduce((a, b) => (b.parity > a.parity ? b : a));
        chosen = chosen.map((x) => (x === worst ? match : x));
      }
    }
    // Gender guarantee: an exact gender-presentation match outranks price-rank balance (prices are
    // hidden from recipients): if the usable pool has one and none was chosen, it replaces the least exact.
    if (chosen.length > 0 && !chosen.some((x) => genderRank(x) === 0)) {
      const exact = usable.find((x) => genderRank(x) === 0 && !chosen.includes(x) && (!parityMode || x.parity === 0));
      if (exact) {
        const worst = chosen.reduce((a, b) => (genderRank(b) > genderRank(a) ? b : a));
        chosen = chosen.map((x) => (x === worst ? exact : x));
      }
    }
    // Default-metal guarantee: recipients see metals but never prices (ADR-032). At least one decoy
    // shares s's default metal whenever tiers 0–2 offer one (in parity mode, one with the same count);
    // failing that, one decoy takes a shortlist metal no earlier decoy covers yet, from no wider a
    // tier than already chosen, so no pick's metal is the odd one out.
    const uncovered = [...shortlistMetals];
    for (const m of coveredMetals) {
      const i = uncovered.indexOf(m);
      if (i >= 0) uncovered.splice(i, 1);
    }
    const helps = (x: Cand) => metalGap(x) === 0 || uncovered.includes(x.c.attributes.metal);
    if (chosen.length > 0 && !chosen.some((x) => metalGap(x) === 0)) {
      const maxTier = Math.max(...chosen.map((x) => x.tier));
      // Never trade an exact gender match for a merely compatible one.
      const bestGender = Math.min(...chosen.map(genderRank));
      const ok = (x: Cand) => genderRank(x) <= Math.min(1, bestGender) && !chosen.includes(x) && (!parityMode || x.parity === 0);
      const match =
        upTo(2).find((x) => metalGap(x) === 0 && ok(x)) ??
        (chosen.some(helps) ? undefined : cands.find((x) => x.tier <= maxTier && uncovered.includes(x.c.attributes.metal) && ok(x)));
      if (match) {
        const worst = chosen.reduce((a, b) => (Number(!helps(b)) * 100 + metalGap(b) * 10 + b.parity > Number(!helps(a)) * 100 + metalGap(a) * 10 + a.parity ? b : a));
        chosen = chosen.map((x) => (x === worst ? match : x));
      }
    }
    for (const x of chosen) coveredMetals.push(x.c.attributes.metal);
    if (chosen.some((x) => genderRank(x) === 2)) reasons.add("GENDER_RELAXED");
    for (const x of chosen) {
      used.add(x.c.id);
      picks.push({ decoyId: x.c.id, shadowOf: s.id, tier: x.tier, similarity: x.sim, priceRatio: x.c.price / s.price });
      if (x.tier > 0) reasons.add(TIER_REASON[x.tier as Exclude<DecoyTier, 0>]);
    }
    shadowPools.set(s.id, { s, cands: cands.filter((x) => genderRank(x) < 2), allowed: allowedGenders });
  }

  balanceGenderShares(shortlist, catalog, picks, shadowPools, used);
  const decoyIds = picks.map((p) => p.decoyId);
  if (decoyIds.length < requested) reasons.add("INSUFFICIENT_CATALOG");
  return {
    decoyIds,
    picks,
    reasons: [...reasons],
    ok: decoyIds.length >= requested && decoyIds.length >= o.minDecoys,
    requested,
    carouselIds: carouselOrder([...shortlist.map((s) => s.id), ...decoyIds], o.seed),
  };
}

/** Seeded shuffle of the carousel ids (input order is normalised first, so it carries no signal). */
export function carouselOrder(ids: readonly string[], seed: string): string[] {
  return seededShuffle([...ids].sort(), `${seed}:order`);
}

/**
 * The recipient-visible view of one carousel item. This is the complete list of fields the
 * recipient UI may render; none of them differs in kind between shortlist items and decoys.
 */
export interface CarouselItem {
  id: string;
  title: string;
  category: JewelryCategory;
  price: number;
  currency: string;
  metal: string;
  metalTone: string;
  /** Spec-compliant product try-on image path (never the recipient). */
  image: string;
  hasImage: boolean;
  vtoSpecOk: boolean;
  /** Always empty: no "picked for you", "new" or "shortlisted" badges in a Fit Request. */
  badges: string[];
  /** Metal swatch labels in listing order (eligible variants only when a request is given). */
  swatches: string[];
  /** Visible through the design itself (not a rendered field): feminine, masculine or unisex. */
  genderPresentation: GenderPresentation;
  /** Design-language family from `attributes.style` (classic, minimal, statement, boho, ...). */
  styleFamily: string;
}

/** Recipient view of a design; with a request, its default eligible variant and eligible swatches. */
export function toCarouselItem(sku: CatalogSku, request?: VariantRequest, cap?: number): CarouselItem {
  const variants = request ? visibleVariants(sku, request, cap) : variantsOf(sku);
  const def = request ? defaultVariant(sku, request, null, cap) : undefined;
  const view = def ? variantView(sku, def) : sku;
  return {
    id: sku.id,
    title: sku.title,
    category: sku.category,
    price: view.price,
    currency: sku.currency,
    metal: view.attributes.metal,
    metalTone: view.attributes.metal_tone,
    image: view.attributes.vto_image,
    hasImage: Boolean(view.attributes.vto_image),
    vtoSpecOk: view.attributes.vto_spec_ok === true,
    badges: [],
    swatches: variants.map((v) => SWATCH_LABEL[v.metal]),
    genderPresentation: genderOf(sku),
    styleFamily: String(sku.attributes.style ?? "").toLowerCase(),
  };
}

/** Builds the ordered recipient carousel from a selection. Unknown ids are skipped. */
export function buildCarousel(selection: DecoySelection, skus: readonly CatalogSku[], request?: VariantRequest): CarouselItem[] {
  const byId = new Map(skus.map((s) => [s.id, s]));
  const decoyIds = new Set(selection.decoyIds);
  const pick = (want: boolean) => selection.carouselIds.filter((id) => decoyIds.has(id) === want).flatMap((id) => byId.get(id) ?? []);
  const cap = request ? swatchCap(pick(false), pick(true), request) : undefined;
  return selection.carouselIds.flatMap((id) => {
    const sku = byId.get(id);
    return sku ? [toCarouselItem(sku, request, cap)] : [];
  });
}

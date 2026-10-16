/**
 * "Guess probability" (MASTER_PLAN v2 §3.4): the chance that a recipient who looks only at the
 * carousel guesses the piece the giver will buy. With 6 indistinguishable items the floor is 1/6.
 *
 * Method: simulate many Fit Requests on a catalog (shortlist of 1–4 try-on-ready SKUs within ±50%
 * of each other's price, decoys from `selectDecoys`, seeded order), assume the giver buys one
 * shortlist item uniformly at random, and let a set of attackers each pick one carousel item using
 * only recipient-visible fields (position, price, category, metal, badges, metal swatches). With
 * `variants` (default) each request has a budget cap and sometimes a gold-only lock, and the carousel
 * shows eligible, leveled swatches (ADR-032). For one request,
 * P(hit) = [pick ∈ shortlist] / |shortlist|. We report every attacker's mean hit rate, per shortlist
 * size and overall, and the best attacker's rate as the headline number.
 */
import type { CatalogSku } from "@/lib/contracts/giftfit";
import { type CarouselItem, HARD_DECOY_REASONS, buildCarousel, selectDecoys, tryOnReady, visibleSimilarity } from "./decoys";
import { seededRandom } from "./rng";
import { SWATCH_LABEL, type VariantRequest, eligibleVariants } from "./variants";

export type Attacker = (items: CarouselItem[]) => number;

const byPrice = (items: CarouselItem[]) => items.map((it, i) => ({ p: it.price, i })).sort((a, b) => a.p - b.p || a.i - b.i);

const centrality = (items: CarouselItem[], i: number) =>
  items.reduce((sum, other, j) => (j === i ? sum : sum + visibleSimilarity(items[i], other)), 0);

const logPriceSpread = (items: CarouselItem[], i: number) =>
  items.reduce((sum, other) => sum + Math.abs(Math.log(items[i].price) - Math.log(other.price)), 0);

const argBest = (items: CarouselItem[], f: (i: number) => number, dir: 1 | -1) =>
  items.map((_, i) => ({ v: f(i), i })).sort((a, b) => dir * (b.v - a.v) || a.i - b.i)[0].i;

/** The item whose value of `f` is rarest in the carousel (ties: earliest position). */
function rarest(items: CarouselItem[], f: (i: CarouselItem) => string): number {
  const counts = new Map<string, number>();
  for (const it of items) counts.set(f(it), (counts.get(f(it)) ?? 0) + 1);
  return argBest(items, (i) => counts.get(f(items[i]))!, -1);
}

/** Similarity without price (recipients never see prices): category, default metal, shared swatches. */
const priceFreeSimilarity = (a: CarouselItem, b: CarouselItem) => {
  const shared = a.swatches.filter((x) => b.swatches.includes(x)).length;
  const union = new Set([...a.swatches, ...b.swatches]).size || 1;
  return (a.category === b.category ? 1 : 0) + (a.metal === b.metal ? 1 : 0) + shared / union;
};
const priceFreeCentrality = (items: CarouselItem[], i: number) =>
  items.reduce((sum, other, j) => (j === i ? sum : sum + priceFreeSimilarity(items[i], other)), 0);

/** Attackers that read prices. Recipients never see prices (ADR-032); these give a stricter bound. */
export const PRICE_ATTACKERS: ReadonlySet<string> = new Set([
  "highestPrice",
  "lowestPrice",
  "medianPrice",
  "mostCentral",
  "leastCentral",
  "priceCentroid",
  "mostSwatchesPriciest",
  "mostSwatchesCheapest",
]);

/** Attackers over recipient-visible fields (plus price, for the stricter bound). */
export const ATTACKERS: Record<string, Attacker> = {
  mostCentralNoPrice: (items) => argBest(items, (i) => priceFreeCentrality(items, i), 1),
  leastCentralNoPrice: (items) => argBest(items, (i) => priceFreeCentrality(items, i), -1),
  firstPosition: () => 0,
  lastPosition: (items) => items.length - 1,
  highestPrice: (items) => byPrice(items).at(-1)!.i,
  lowestPrice: (items) => byPrice(items)[0].i,
  medianPrice: (items) => byPrice(items)[Math.floor((items.length - 1) / 2)].i,
  mostCentral: (items) => argBest(items, (i) => centrality(items, i), 1),
  leastCentral: (items) => argBest(items, (i) => centrality(items, i), -1),
  priceCentroid: (items) => argBest(items, (i) => logPriceSpread(items, i), -1),
  majorityCategory: (items) => {
    const counts = new Map<string, number>();
    for (const it of items) counts.set(it.category, (counts.get(it.category) ?? 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    return items.findIndex((it) => it.category === top);
  },
  majorityMetal: (items) => {
    const counts = new Map<string, number>();
    for (const it of items) counts.set(it.metal, (counts.get(it.metal) ?? 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    return items.findIndex((it) => it.metal === top);
  },
  hasBadge: (items) => Math.max(0, items.findIndex((it) => it.badges.length > 0)),
  // Metal swatches (ADR-032): count and metal labels are visible.
  mostSwatches: (items) => argBest(items, (i) => items[i].swatches.length, 1),
  fewestSwatches: (items) => argBest(items, (i) => items[i].swatches.length, -1),
  // Price-band proxy: among the designs with the most metals, the most expensive default price.
  mostSwatchesPriciest: (items) => {
    const top = Math.max(...items.map((i) => i.swatches.length));
    return argBest(items, (i) => (items[i].swatches.length === top ? items[i].price : -1), 1);
  },
  mostSwatchesCheapest: (items) => {
    const top = Math.max(...items.map((i) => i.swatches.length));
    return argBest(items, (i) => (items[i].swatches.length === top ? -items[i].price : -Infinity), 1);
  },
  ...Object.fromEntries(
    Object.values(SWATCH_LABEL).map((label) => [`offers:${label}`, (items: CarouselItem[]) => Math.max(0, items.findIndex((i) => i.swatches.includes(label)))]),
  ),
  ...Object.fromEntries(
    Object.values(SWATCH_LABEL).map((label) => [`lacks:${label}`, (items: CarouselItem[]) => Math.max(0, items.findIndex((i) => !i.swatches.includes(label)))]),
  ),
  // Gender presentation and style family, visible through the designs themselves.
  oddGenderOut: (items) => rarest(items, (i) => i.genderPresentation),
  ...Object.fromEntries(
    (["feminine", "masculine", "unisex"] as const).map((g) => [`gender:${g}`, (items: CarouselItem[]) => Math.max(0, items.findIndex((i) => i.genderPresentation === g))]),
  ),
  oddStyleOut: (items) => rarest(items, (i) => i.styleFamily),
  rarestSwatchSet: (items) => {
    const key = (it: CarouselItem) => [...it.swatches].sort().join("+");
    const counts = new Map<string, number>();
    for (const it of items) counts.set(key(it), (counts.get(key(it)) ?? 0) + 1);
    return argBest(items, (i) => counts.get(key(items[i]))!, -1);
  },
};

export interface GuessStats {
  trials: number;
  byAttacker: Record<string, number>;
  /** Best attacker over every attacker, including price-based ones (a stricter bound). */
  guessProbability: number;
  bestAttacker: string;
  standardError: number;
  /**
   * Best attacker using only what the recipient actually sees: recipients never see prices
   * (ADR-032), so price-based attackers (PRICE_ATTACKERS) are excluded. The headline number.
   */
  visibleGuessProbability: number;
  bestVisibleAttacker: string;
}

export interface GuessReport extends GuessStats {
  carouselSize: number;
  /** 1 / carousel size: a blind guess. */
  baseline: number;
  /** Same statistics per shortlist size (1–4). */
  bySize: Record<number, GuessStats>;
  /** Share of simulated requests that needed a hard relaxation (HARD_DECOY_REASONS). */
  fallbackRate: number;
}

function stats(hits: Record<string, number>, n: number): GuessStats {
  const byAttacker = Object.fromEntries(Object.entries(hits).map(([k, v]) => [k, n ? v / n : 0]));
  const ranked = Object.entries(byAttacker).sort((a, b) => b[1] - a[1]);
  const [bestAttacker, guessProbability] = ranked[0];
  const [bestVisibleAttacker, visibleGuessProbability] = ranked.find(([k]) => !PRICE_ATTACKERS.has(k)) ?? ranked[0];
  return {
    trials: n,
    byAttacker,
    guessProbability,
    bestAttacker,
    standardError: Math.sqrt((guessProbability * (1 - guessProbability)) / Math.max(1, n)),
    visibleGuessProbability,
    bestVisibleAttacker,
  };
}

export function estimateGuessProbability(
  catalog: readonly CatalogSku[],
  {
    trials = 2000,
    seed = "guess",
    sizes = [1, 2, 3, 4],
    attackers = ATTACKERS,
    variants = true,
    firstIds,
    fixedShortlist,
    fixedRequest,
  }: {
    trials?: number;
    seed?: string;
    sizes?: readonly number[];
    attackers?: Record<string, Attacker>;
    /**
     * Simulate the variant flow (ADR-032): a budget cap of 1.25 × the first pick's price (rounded up
     * to $10), a gold-only metal lock in 1 of 5 requests, eligible swatches only. Default true.
     */
    variants?: boolean;
    /** Restrict the giver's first pick to these designs (e.g. the demo's Halo Drop). */
    firstIds?: readonly string[];
    /** A fixed shortlist for every run (the demo configuration); overrides sizes and firstIds. */
    fixedShortlist?: readonly string[];
    /** A fixed request for every run (cap, currency, lock); default: 1.25 × the first pick's price. */
    fixedRequest?: VariantRequest;
  } = {},
): GuessReport {
  const ready = catalog.filter(tryOnReady);
  const firstPool = firstIds ? ready.filter((s) => firstIds.includes(s.id)) : ready;
  const rand = seededRandom(`${seed}:sim`);
  const zero = () => Object.fromEntries(Object.keys(attackers).map((k) => [k, 0])) as Record<string, number>;
  const hits = zero();
  const hitsBySize = new Map<number, { hits: Record<string, number>; n: number }>();
  let fallbacks = 0;
  let carouselSize = 6;
  for (let t = 0; t < trials; t++) {
    const size = sizes[t % sizes.length];
    const fixed = fixedShortlist ? catalog.filter((s) => fixedShortlist.includes(s.id)) : null;
    const first = fixed ? fixed[0] : firstPool[Math.floor(rand() * firstPool.length)];
    const lockDraw = rand();
    const request: VariantRequest | undefined =
      fixedRequest ??
      (variants
        ? { budgetMax: Math.ceil((first.price * 1.25) / 10) * 10, currency: first.currency, metalLock: lockDraw < 0.2 ? ["yellow_gold", "rose_gold"] : undefined }
        : undefined);
    const fits = (s: CatalogSku) => !request || eligibleVariants(s, request).length > 0;
    if (!fixed && !fits(first)) {
      t--; // the giver could not have picked it under this lock; draw again
      continue;
    }
    const near = ready.filter((s) => s.id !== first.id && Math.abs(s.price / first.price - 1) <= 0.5 && fits(s));
    const shortlist = fixed ? [...fixed] : [first];
    while (!fixed && shortlist.length < size && near.length > 0) shortlist.push(near.splice(Math.floor(rand() * near.length), 1)[0]);
    const sel = selectDecoys(shortlist, catalog, { seed: `${seed}:${t}`, request });
    if (sel.reasons.some((r) => HARD_DECOY_REASONS.has(r))) fallbacks++;
    const items = buildCarousel(sel, catalog, request);
    carouselSize = items.length;
    const inShortlist = new Set(shortlist.map((s) => s.id));
    const bucket = hitsBySize.get(shortlist.length) ?? { hits: zero(), n: 0 };
    bucket.n++;
    for (const [name, attack] of Object.entries(attackers)) {
      const pick = items[attack(items)];
      if (pick && inShortlist.has(pick.id)) {
        hits[name] += 1 / shortlist.length;
        bucket.hits[name] += 1 / shortlist.length;
      }
    }
    hitsBySize.set(shortlist.length, bucket);
  }
  return {
    ...stats(hits, trials),
    carouselSize,
    baseline: 1 / carouselSize,
    bySize: Object.fromEntries([...hitsBySize.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [k, stats(v.hits, v.n)])),
    fallbackRate: trials ? fallbacks / trials : 0,
  };
}

/**
 * Fixed-carousel check (e.g. the demo shortlist, whose decoys are deterministic on a small catalog):
 * hit rates are meaningless there (any order-independent attacker scores 0 or 1/|S|), so instead we
 * list, per visible attribute, values that appear only on shortlist items and only on decoys. A
 * leak is an attribute where shortlist-only values outnumber decoy-only values: "the odd one out"
 * then points at a pick more often than at a decoy. Gender presentation is also checked by share
 * (masculine/feminine no more common among picks than among decoys); for that rule the two lists
 * carry every item's presentation.
 */
export function fixedCarouselLeaks(items: readonly CarouselItem[], shortlistIds: readonly string[]): { attribute: string; shortlistOnly: string[]; decoyOnly: string[] }[] {
  const S = items.filter((i) => shortlistIds.includes(i.id));
  const D = items.filter((i) => !shortlistIds.includes(i.id));
  const attributes: Record<string, (i: CarouselItem) => string> = {
    category: (i) => i.category,
    defaultMetal: (i) => i.metal,
    swatchCount: (i) => String(i.swatches.length),
    swatchSet: (i) => [...i.swatches].sort().join("+"),
    categoryAndMetal: (i) => `${i.category}:${i.metal}`,
    genderPresentation: (i) => i.genderPresentation,
    styleFamily: (i) => i.styleFamily,
  };
  const out: { attribute: string; shortlistOnly: string[]; decoyOnly: string[] }[] = [];
  for (const [attribute, f] of Object.entries(attributes)) {
    const sv = S.map(f);
    const dv = D.map(f);
    const shortlistOnly = sv.filter((v) => !dv.includes(v));
    const decoyOnly = dv.filter((v) => !sv.includes(v));
    if (shortlistOnly.length * Math.max(1, D.length) > decoyOnly.length * Math.max(1, S.length)) out.push({ attribute, shortlistOnly, decoyOnly });
  }
  // Gender presentation also carries a prior ("they would buy me masculine pieces"), so its shares
  // must match: a gendered presentation may not be more common among picks than among decoys.
  if (!out.some((l) => l.attribute === "genderPresentation")) {
    for (const v of ["masculine", "feminine"]) {
      const sv = S.filter((i) => i.genderPresentation === v).length;
      const dv = D.filter((i) => i.genderPresentation === v).length;
      if (sv * Math.max(1, D.length) > dv * Math.max(1, S.length)) {
        out.push({ attribute: "genderPresentation", shortlistOnly: S.map((i) => i.genderPresentation), decoyOnly: D.map((i) => i.genderPresentation) });
        break;
      }
    }
  }
  return out;
}

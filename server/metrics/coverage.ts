/**
 * Undertone Coverage (owner: A6, MASTER_PLAN v2 G8 / §3.4): the share of catalog SKUs whose metal
 * the published rules mark "recommended" for a warm, neutral or cool undertone estimate.
 *
 *   suits(sku, tone)   = jewelryRules.metalFit(sku.attributes.metal, tone).strength === "recommended"
 *   coverage(tone)     = |{ sku : suits(sku, tone) }| / |catalog|
 *   gap                = the tone with the lowest coverage, and its weakest category
 *   toAdd(category)    = ceil((target × total − count) / (1 − target)), target = 50%
 *
 * Pure: no recipient data is involved. The rule table is A10's (server/verticals/jewelry.ts); no
 * metal is ever "avoid", so "not recommended" means "acceptable", never "wrong".
 */
import type { CatalogSku, JewelryCategory, JewelryRules, Metal, Undertone } from "@/server/contracts/giftfit";
import { METALS } from "@/server/contracts/giftfit";
import { jewelryRules } from "@/server/verticals/jewelry";
import type { CategoryCoverage, Coverage, CoverageGap, ToneShare } from "./types";

export const TONES: readonly Undertone[] = ["warm", "neutral", "cool"];
export const CATEGORY_ORDER: readonly JewelryCategory[] = ["earring", "necklace", "ring", "bracelet", "watch"];
export const COVERAGE_TARGET = 0.5;

export const COVERAGE_RULE =
  "A SKU suits a tone when jewelryRules.metalFit(metal, tone) is \"recommended\". Coverage = suiting SKUs / all SKUs.";

type SkuLike = Pick<CatalogSku, "category"> & { attributes: { metal: Metal } };

const share = (count: number, total: number): ToneShare => ({ count, share: total ? count / total : 0 });

export function suitsTone(metal: Metal, tone: Undertone, rules: Pick<JewelryRules, "metalFit"> = jewelryRules): boolean {
  return rules.metalFit(metal, tone).strength === "recommended";
}

/** Metals the rules recommend for a tone, in canonical order. */
export function recommendedMetals(tone: Undertone, rules: Pick<JewelryRules, "metalFit"> = jewelryRules): Metal[] {
  return METALS.filter((m) => suitsTone(m, tone, rules));
}

/** Smallest n with (count + n) / (total + n) ≥ target. */
export function skusToReach(count: number, total: number, target = COVERAGE_TARGET): number {
  if (total === 0 || count / total >= target) return 0;
  return Math.ceil((target * total - count) / (1 - target));
}

export function computeCoverage(catalog: readonly SkuLike[], rules: Pick<JewelryRules, "metalFit"> = jewelryRules, target = COVERAGE_TARGET): Coverage {
  const total = catalog.length;
  const counts: Record<Undertone, number> = { warm: 0, neutral: 0, cool: 0 };
  const perCat = new Map<JewelryCategory, { total: number } & Record<Undertone, number>>();
  for (const s of catalog) {
    const c = perCat.get(s.category) ?? { total: 0, warm: 0, neutral: 0, cool: 0 };
    c.total++;
    for (const t of TONES) {
      if (suitsTone(s.attributes.metal, t, rules)) {
        counts[t]++;
        c[t]++;
      }
    }
    perCat.set(s.category, c);
  }
  const byCategory: CategoryCoverage[] = [...perCat.entries()]
    .sort((a, b) => CATEGORY_ORDER.indexOf(a[0]) - CATEGORY_ORDER.indexOf(b[0]))
    .map(([category, c]) => ({ category, total: c.total, warm: share(c.warm, c.total), neutral: share(c.neutral, c.total), cool: share(c.cool, c.total) }));
  const byTone = { warm: share(counts.warm, total), neutral: share(counts.neutral, total), cool: share(counts.cool, total) };

  let gap: CoverageGap | null = null;
  if (total > 0) {
    // Lowest overall tone; ties broken by the fixed tone order.
    const tone = [...TONES].sort((a, b) => byTone[a].share - byTone[b].share)[0];
    const weakest = [...byCategory].sort((a, b) => a[tone].share - b[tone].share || b.total - a.total)[0];
    gap = {
      tone,
      share: byTone[tone].share,
      count: byTone[tone].count,
      total,
      category: weakest.category,
      categoryShare: weakest[tone].share,
      categoryCount: weakest[tone].count,
      categoryTotal: weakest.total,
      toAdd: skusToReach(weakest[tone].count, weakest.total, target),
      targetShare: target,
      metals: recommendedMetals(tone, rules),
    };
  }
  return { total, byTone, byCategory, gap, rule: COVERAGE_RULE };
}

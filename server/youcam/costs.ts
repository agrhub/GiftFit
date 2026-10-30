/**
 * Unit pricing. Live prices come from GET /s2s/v2.0/credit/feature-cost (free);
 * the snapshot below (2026-10-15, docs/hackathon/feature_costs.md) is used for
 * estimates in mock mode and for budgeting before any network call. Real calls
 * always price against the live endpoint.
 */
import type { FeatureSlug, TierSelector } from "./features";
import type { FeatureCostSku } from "./types";

const sku = (feature: string, description: string, amount: number): FeatureCostSku => ({
  feature,
  description,
  amount,
  unit: "result_image",
  proc_unit: 1,
});

export const FEATURE_COST_SNAPSHOT_DATE = "2026-10-15";

export const FEATURE_COST_SNAPSHOT: readonly FeatureCostSku[] = [
  sku("skin-analysis", "AI Skin Analysis V2.1 HD (1-4 concerns)", 12),
  sku("skin-analysis", "AI Skin Analysis V2.1 HD (5-8 concerns)", 16),
  sku("skin-analysis", "AI Skin Analysis V2.1 HD (9-12 concerns)", 20),
  sku("skin-analysis", "AI Skin Analysis V2.1 HD (13-16 concerns)", 22),
  sku("skin-analysis", "AI Skin Analysis V2.1 SD (1-4 concerns)", 9),
  sku("skin-analysis", "AI Skin Analysis V2.1 SD (5-8 concerns)", 12),
  sku("skin-analysis", "AI Skin Analysis V2.1 SD (9-12 concerns)", 14),
  sku("skin-analysis", "AI Skin Analysis V2.1 SD (13-16 concerns)", 16),
  sku("fitzpatrick-scale-analyzer", "AI Fitzpatrick Skin Type Analysis V1.0", 10),
  sku("skin-tone-analysis", "AI Facial Color Tones Analyzer V1.0", 20),
  sku("face-attr-analysis", "Face Attribute & Ratio Analysis (1-5 features)", 10),
  sku("face-attr-analysis", "Face Attribute & Ratio Analysis (6-14 features)", 20),
  sku("face-attr-analysis", "Face Attribute & Ratio Analysis (15-28 features)", 30),
  sku("skin-simulation", "Skin Simulation (1-4 concerns)", 4),
  sku("skin-simulation", "Skin Simulation (5-10 concerns)", 6),
  sku("makeup-vto", "AI Makeup Virtual Try-On V1.0", 1),
  sku("hair-color", "AI Hair Color Virtual Try-On V1.0 (Full)", 1),
  sku("hair-color", "AI Hair Color Virtual Try-On V1.0 (Ombre)", 1),
  sku("cloth-v4", "AI Clothes Virtual Try-On V4.0", 2),
  sku("2d-vto/earring", "AI Earrings Virtual Try-On V1.0 (Single)", 1),
  sku("2d-vto/earring", "AI Earrings Virtual Try-On V1.0 (Stacked)", 2),
  sku("2d-vto/necklace", "AI Necklace Virtual Try-On V1.0", 1),
  sku("2d-vto/ring", "AI Ring Virtual Try-On V1.0 (Single)", 1),
  sku("2d-vto/ring", "AI Ring Virtual Try-On V1.0 (Stacked)", 2),
  sku("2d-vto/bracelet", "AI Bracelet Virtual Try-On V1.0 (Single)", 1),
  sku("2d-vto/bracelet", "AI Bracelet Virtual Try-On V1.0 (Stacked)", 2),
  sku("2d-vto/watch", "AI Watch Virtual Try-On V1.0", 1),
];

/** "https://.../s2s/v2.1/task/skin-analysis" -> "skin-analysis". */
export function slugFromTaskUrl(url: string | undefined): string {
  if (!url || !url.includes("/task/")) return "(other)";
  return url.replace(/\/+$/, "").split("/task/").pop() as string;
}

const RANGE = /\((\d+)\s*-\s*(\d+)\s+(?:concerns|features)\)/i;

function matchesTier(description: string, tier: TierSelector): boolean {
  if (tier.versionLabel && !description.includes(tier.versionLabel)) return false;
  if (tier.quality && !new RegExp(`\\b${tier.quality}\\b`).test(description)) return false;
  if (tier.variant && !description.includes(`(${tier.variant})`)) return false;
  if (tier.count !== undefined) {
    const m = RANGE.exec(description);
    if (!m) return false;
    if (tier.count < Number(m[1]) || tier.count > Number(m[2])) return false;
  }
  return true;
}

/**
 * Price of one task in the given tier, or undefined when no SKU matches
 * (the guard then refuses: never run a task with an unknown price).
 * If several SKUs match, the most expensive one is used (conservative).
 */
export function priceFor(
  skus: readonly FeatureCostSku[],
  feature: FeatureSlug,
  tier: TierSelector,
): number | undefined {
  const candidates = skus.filter((s) => s.feature === feature && matchesTier(s.description ?? "", tier));
  if (candidates.length === 0) return undefined;
  return Math.max(...candidates.map((s) => Number(s.amount) * (s.proc_unit ?? 1)));
}

/** Normalizes one page of the feature-cost endpoint. */
export function parseFeatureCostPage(json: unknown): { skus: FeatureCostSku[]; nextToken?: string } {
  const result = (json as { result?: { skus?: unknown[]; next_token?: string } })?.result ?? {};
  const skus = (result.skus ?? []).map((raw) => {
    const s = raw as Record<string, unknown>;
    return {
      description: typeof s.description === "string" ? s.description : undefined,
      amount: Number(s.amount ?? 0),
      unit: typeof s.unit === "string" ? s.unit : undefined,
      proc_unit: typeof s.proc_unit === "number" ? s.proc_unit : undefined,
      run_task_url: typeof s.run_task_url === "string" ? s.run_task_url : undefined,
      feature: slugFromTaskUrl(typeof s.run_task_url === "string" ? s.run_task_url : undefined),
    };
  });
  return { skus, nextToken: result.next_token || undefined };
}

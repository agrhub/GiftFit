/**
 * Metal variants (ADR-032, MASTER_PLAN §3.2b). A product is a design; each metal is a variant with
 * its own price and try-on image. Only variants priced ≤ budgetMax and inside the optional metal
 * lock are "eligible": they are the only swatches the recipient ever sees, so any choice is affordable.
 */
import type { CatalogSku, Metal, MetalVariant, RecipientProfile } from "@/server/contracts/giftfit";

/** What eligibility needs from a request (FitRequestInput satisfies it). */
export interface VariantRequest {
  budgetMax: number;
  currency: string;
  metalLock?: readonly Metal[];
}

/** Swatch labels shown to the recipient (no prices). */
export const SWATCH_LABEL: Record<Metal, string> = {
  yellow_gold: "Yellow gold",
  rose_gold: "Rose gold",
  white_gold: "White gold",
  silver: "Sterling silver",
  platinum: "Platinum",
  mixed_two_tone: "Two-tone",
};

/** The design's variants; a SKU without `variants` is one variant built from its top-level fields. */
export function variantsOf(sku: CatalogSku): MetalVariant[] {
  if (sku.variants && sku.variants.length > 0) return sku.variants;
  const a = sku.attributes;
  return [
    {
      variantId: `${sku.id}:${a.metal}`,
      metal: a.metal,
      metal_tone: a.metal_tone,
      price: sku.price,
      images: sku.images,
      vto_image: a.vto_image,
      vto_spec_ok: a.vto_spec_ok,
    },
  ];
}

/** Variants priced ≤ budgetMax, in the request currency and inside metalLock (if set), in listing order. */
export function eligibleVariants(sku: CatalogSku, request: VariantRequest): MetalVariant[] {
  if (sku.currency !== request.currency) return [];
  const lock = request.metalLock && request.metalLock.length > 0 ? request.metalLock : null;
  return variantsOf(sku).filter((v) => v.price <= request.budgetMax + 1e-9 && (!lock || lock.includes(v.metal)));
}

/**
 * The swatch rendered first: the eligible variant whose metal tone matches the undertone (the
 * recipient's override, else the estimate even at low confidence); else the variant the giver
 * listed (variants[0]) when eligible; else the first eligible one. Undefined when none is eligible.
 * With `cap` (swatch leveling) only the visible variants are considered.
 */
export function defaultVariant(
  sku: CatalogSku,
  request: VariantRequest,
  profile?: Pick<RecipientProfile, "undertoneEstimate" | "undertoneOverride"> | null,
  cap?: number,
): MetalVariant | undefined {
  const eligible = visibleVariants(sku, request, cap);
  if (eligible.length === 0) return undefined;
  const undertone = profile ? (profile.undertoneOverride ?? profile.undertoneEstimate) : undefined;
  if (undertone) {
    const match = eligible.find((v) => v.metal_tone === undertone);
    if (match) return match;
  }
  const listed = variantsOf(sku)[0];
  return eligible.find((v) => v.variantId === listed.variantId) ?? eligible[0];
}

/** The design as seen in one metal: same id and attributes, the variant's metal, price and images. */
export function variantView(sku: CatalogSku, v: MetalVariant): CatalogSku {
  return {
    ...sku,
    price: v.price,
    images: v.images,
    attributes: { ...sku.attributes, metal: v.metal, metal_tone: v.metal_tone, vto_image: v.vto_image, vto_spec_ok: v.vto_spec_ok },
  };
}

/** Index from variant id to its design id, for reading hearts stored as variant ids. */
export function variantIndex(catalog: readonly CatalogSku[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const sku of catalog) for (const v of variantsOf(sku)) index.set(v.variantId, sku.id);
  return index;
}

/**
 * Swatch leveling (decoy parity, ADR-032). Few designs have several metals, so "the design with the
 * most swatches" could betray the giver's pick. The cap is the largest c such that the share of
 * shortlist designs showing ≥ c swatches is no larger than the share of decoys showing ≥ c:
 * S_c / |S| ≤ D_c / |D|. Designs above the cap show their first `cap` eligible variants in listing
 * order. c = 1 always qualifies. Undefined when either side is empty (nothing to compare).
 */
export function swatchCap(shortlist: readonly CatalogSku[], decoys: readonly CatalogSku[], request: VariantRequest): number | undefined {
  if (shortlist.length === 0 || decoys.length === 0) return undefined;
  const sCounts = shortlist.map((s) => eligibleVariants(s, request).length);
  const dCounts = decoys.map((s) => eligibleVariants(s, request).length);
  for (let c = Math.max(1, ...sCounts); c > 1; c--) {
    const sc = sCounts.filter((n) => n >= c).length;
    const dc = dCounts.filter((n) => n >= c).length;
    if (sc * decoys.length <= dc * shortlist.length) return c;
  }
  return 1;
}

/** The swatches the recipient sees for a design: eligible variants, leveled to `cap` when given. */
export function visibleVariants(sku: CatalogSku, request: VariantRequest, cap?: number): MetalVariant[] {
  const eligible = eligibleVariants(sku, request);
  return cap !== undefined && cap >= 1 ? eligible.slice(0, cap) : eligible;
}

/** Visible swatches for every carousel design (shortlist and decoys), keyed by design id. */
export function carouselSwatches(shortlist: readonly CatalogSku[], decoys: readonly CatalogSku[], request: VariantRequest): Map<string, MetalVariant[]> {
  const cap = swatchCap(shortlist, decoys, request);
  return new Map([...shortlist, ...decoys].map((s) => [s.id, visibleVariants(s, request, cap)]));
}

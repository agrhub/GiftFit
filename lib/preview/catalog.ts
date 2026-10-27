/**
 * Preview catalog view (owner: A10; consumers: A6 preview page /s/<key>, A6/A7 widget + Concierge).
 *
 * `getPreviewCatalog(key)` returns a ready preview's products in two shapes:
 *   - `products`: every PreviewProduct (any kind of store), minus the ones the owner removed;
 *   - `skus`: the subset that is a valid `CatalogSku` (lib/contracts/giftfit.ts) — a jewelry category, a
 *     stated metal, a price and a currency — so `buildConciergeCatalog(skus)` (lib/concierge/catalog.ts)
 *     and `searchCatalog` work unchanged. `toConciergeCatalog()` does that in one call.
 * Try-on stays OFF for previews (ADR-055): every SKU has vto_spec_ok=false and an empty vto_image.
 * Nothing here invents a field: products without a jewelry category or metal are simply not in `skus`.
 */
import { buildConciergeCatalog, type ConciergeCatalog } from "@/lib/concierge/catalog";
import type { CatalogSku, GiftFitAttributes } from "@/lib/contracts/giftfit";
import { inferEarringShape, inferNecklaceStyle } from "@/lib/ingest/normalise";
import { METAL_TONE } from "@/lib/verticals/jewelry";
import { defaultPreviewRepo, type PreviewRepo } from "./repo";
import type { PreviewPlatform, PreviewProduct } from "./types";

export interface PreviewCatalog {
  key: string;
  domain: string;
  storeName: string;
  platform: PreviewPlatform | null;
  /** Dominant currency (USD when the store states none). */
  currency: string;
  products: PreviewProduct[];
  skus: CatalogSku[];
  expiresAt: Date;
}

const safeId = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "item";

/** The CatalogSku view of one preview product, or null when a contract field is unknown. */
export function previewProductToSku(p: PreviewProduct, domain: string, index: number): CatalogSku | null {
  if (!p.category || !p.metal || p.price === null || !p.currency) return null;
  const attributes: GiftFitAttributes = {
    category: p.category,
    metal: p.metal,
    metal_tone: METAL_TONE[p.metal],
    style: p.style ?? "unspecified",
    occasions: [],
    vto_spec_ok: false,
    vto_image: "",
  };
  if (p.category === "earring") {
    const shape = inferEarringShape(p.title, p.summary);
    if (shape) attributes.earring_shape = shape;
  }
  if (p.category === "necklace") {
    const style = inferNecklaceStyle(null, p.title, p.summary);
    if (style) attributes.necklace_style = style;
  }
  const extra = attributes as GiftFitAttributes & Record<string, unknown>;
  if (p.summary) extra.description = p.summary;
  return {
    id: `pv-${index}-${safeId(p.id)}`,
    storeId: `preview:${domain}`,
    title: p.title,
    category: p.category,
    price: p.price,
    currency: p.currency,
    images: p.images,
    attributes,
    sourceUrl: p.url,
  };
}

export async function getPreviewCatalog(key: string, repo: PreviewRepo = defaultPreviewRepo(), nowMs: number = Date.now()): Promise<PreviewCatalog | null> {
  const rec = await repo.get(key, nowMs);
  if (!rec || rec.state !== "ready") return null;
  const removed = new Set(rec.settings.removedProductIds ?? []);
  const products = rec.products.filter((p) => !removed.has(p.id));
  const skus = products.map((p, i) => previewProductToSku(p, rec.domain, i)).filter((s): s is CatalogSku => s !== null);
  return {
    key: rec.key,
    domain: rec.domain,
    storeName: rec.storeName ?? rec.domain,
    platform: rec.platform,
    currency: rec.currency ?? skus[0]?.currency ?? "USD",
    products,
    skus,
    expiresAt: rec.expiresAt,
  };
}

/** The Concierge view of a preview (jewelry-compatible SKUs only); null when the preview is not ready. */
export async function toConciergeCatalog(key: string, repo?: PreviewRepo): Promise<ConciergeCatalog | null> {
  const c = await getPreviewCatalog(key, repo);
  return c ? buildConciergeCatalog(c.skus) : null;
}

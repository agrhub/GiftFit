/**
 * Preview store keys in the widget, the Concierge and the gift flow (owner: A6, ADR-055). Server-only.
 *
 *   data-store="preview:<key>"   a ready store-URL preview (A10's lib/preview), 22-char key
 *
 * `loadPreviewStore(key)` is the single place that turns a preview record into what the widget needs:
 *   - `products`     every product the owner did not remove (any kind of store);
 *   - `skus`         the jewelry subset (A10's previewProductToSku) with KEY-SCOPED ids `<key>~<sku id>` and
 *                    storeId `preview:<key>`, so a Fit Request can only ever draw from its own preview.
 *                    All are marked vto_spec_ok so curation/decoys accept them; `attributes.tryon_eligible`
 *                    (A16, from the ingest's try-on eligibility) says which ones a try-on may render. Whether a
 *                    try-on happens at all is decided per recipient session (lib/privacy/tryon-mode.ts:
 *                    owner recording / mock rehearsal → try-on, public production → hearts-only).
 *   - `settings`     the owner's widget settings (Admin v0), validated.
 * Missing, expired, queued, crawling, refused or failed previews are `null` everywhere.
 */
import type { CatalogSku } from "@/lib/contracts/giftfit";
import { previewProductToSku } from "@/lib/preview/catalog";
import { defaultPreviewRepo, PREVIEW_KEY_RE, type PreviewRecord, type PreviewRepo } from "@/lib/preview/repo";
import type { PreviewProduct } from "@/lib/preview/types";
import { widgetSettingsFrom, type WidgetStoreSettings } from "./preview-settings";

import { isPreviewStoreId, previewKeyOf, previewStoreId } from "./preview-key";

export { isPreviewStoreId, isReadyPreviewStore, PREVIEW_STORE_PREFIX, previewKeyOf, previewStoreId } from "./preview-key";

const SKU_SEP = "~";

export const scopedSkuId = (key: string, skuId: string) => `${key}${SKU_SEP}${skuId}`;

/** The preview key a scoped sku id belongs to, or null for any other id. */
export function previewKeyOfSkuId(id: string): string | null {
  const i = id.indexOf(SKU_SEP);
  if (i !== 22) return null;
  const key = id.slice(0, i);
  return PREVIEW_KEY_RE.test(key) ? key : null;
}

export interface PreviewStoreView {
  key: string;
  domain: string;
  storeName: string;
  currency: string;
  expiresAt: Date;
  products: PreviewProduct[];
  /** Jewelry subset as key-scoped CatalogSkus ([] for a non-jewelry store). */
  skus: CatalogSku[];
  /** product id → scoped sku id, for products that are giftable through a Fit Request. */
  skuIdByProduct: Record<string, string>;
  settings: WidgetStoreSettings;
}

export function previewStoreView(rec: PreviewRecord): PreviewStoreView {
  const removed = new Set(rec.settings.removedProductIds ?? []);
  const products = rec.products.filter((p) => !removed.has(p.id));
  const skus: CatalogSku[] = [];
  const skuIdByProduct: Record<string, string> = {};
  products.forEach((p, i) => {
    const sku = previewProductToSku(p, rec.domain, i);
    // A recipient chooses from photos, so a giftable design needs one.
    if (!sku || !p.images[0]) return;
    const id = scopedSkuId(rec.key, sku.id);
    skuIdByProduct[p.id] = id;
    skus.push({
      ...sku,
      id,
      storeId: previewStoreId(rec.key),
      // vto_spec_ok keeps every piece giftable (curation/decoys); `tryon_eligible` (A16) says which ones a
      // try-on may render, on `tryOnImage` (the photo that passed the checks). The rest stay hearts-only.
      attributes: { ...sku.attributes, vto_spec_ok: true, vto_image: p.tryOnImage ?? p.images[0], tryon_eligible: p.tryOnEligible === true },
    });
  });
  return {
    key: rec.key,
    domain: rec.domain,
    storeName: rec.storeName ?? rec.domain,
    currency: rec.currency ?? skus[0]?.currency ?? "USD",
    expiresAt: rec.expiresAt,
    products,
    skus,
    skuIdByProduct,
    settings: widgetSettingsFrom(rec.settings),
  };
}

/** A READY, unexpired preview as the widget sees it; null otherwise. */
export async function loadPreviewStore(key: string, repo: PreviewRepo = defaultPreviewRepo(), nowMs: number = Date.now()): Promise<PreviewStoreView | null> {
  if (!PREVIEW_KEY_RE.test(key)) return null;
  const rec = await repo.get(key, nowMs);
  if (!rec || rec.state !== "ready") return null;
  return previewStoreView(rec);
}


/**
 * The preview's catalog for Fit Requests that already exist (lib/fit, lib/privacy, snapshots): any
 * unexpired record that still has products, whatever its state, so a re-read of the store (state
 * queued/crawling, old products kept until it finishes) never breaks a live gift link. New chats and
 * new requests still need a READY preview (loadPreviewStore).
 */
export async function loadPreviewCatalogView(key: string, repo: PreviewRepo = defaultPreviewRepo(), nowMs: number = Date.now()): Promise<PreviewStoreView | null> {
  if (!PREVIEW_KEY_RE.test(key)) return null;
  const rec = await repo.get(key, nowMs);
  if (!rec || rec.products.length === 0) return null;
  return previewStoreView(rec);
}

interface SkuSource {
  getSkus(ids: readonly string[]): Promise<CatalogSku[]>;
  listCatalog?(storeId?: string): Promise<CatalogSku[]>;
}

/**
 * A catalog that answers Aurum ids from `base` and key-scoped preview ids from the preview repo, for
 * lib/fit (getSkus + listCatalog) and lib/privacy (getSkus). Listing every store never includes previews.
 */
export class PreviewAwareCatalog {
  constructor(
    private readonly base: SkuSource,
    private readonly load: (key: string) => Promise<PreviewStoreView | null> = (k) => loadPreviewCatalogView(k),
  ) {}

  async getSkus(ids: readonly string[]): Promise<CatalogSku[]> {
    const keys = [...new Set(ids.map(previewKeyOfSkuId).filter((k): k is string => k !== null))];
    if (!keys.length) return this.base.getSkus(ids);
    const views = new Map<string, Map<string, CatalogSku>>();
    for (const k of keys) views.set(k, new Map(((await this.load(k))?.skus ?? []).map((s) => [s.id, s])));
    const plain = ids.filter((id) => previewKeyOfSkuId(id) === null);
    const fromBase = new Map((plain.length ? await this.base.getSkus(plain) : []).map((s) => [s.id, s]));
    return ids.flatMap((id) => {
      const k = previewKeyOfSkuId(id);
      const s = k ? views.get(k)?.get(id) : fromBase.get(id);
      return s ? [s] : [];
    });
  }

  async listCatalog(storeId?: string): Promise<CatalogSku[]> {
    const key = previewKeyOf(storeId);
    if (key) return (await this.load(key))?.skus ?? [];
    if (storeId && isPreviewStoreId(storeId)) return [];
    return this.base.listCatalog ? this.base.listCatalog(storeId) : [];
  }
}

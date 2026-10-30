/**
 * Gift links made from a store-URL preview (owner: A6, ADR-055, user decision before the traffic shift).
 * Server-only. Plugged into server/fit as FitDeps.stores (server/fit/deps.ts).
 *
 * 1. Lifetime: creating a Fit Request from `preview:<key>` extends that preview's `expiresAt` (also its
 *    Firestore TTL field) to
 *        max(current expiresAt, min(request expiresAt, preview createdAt + 72 h))
 *    so the preview lives as long as its gift links, never past 72 h after it was made, and never
 *    shorter than it already was (several requests: the latest one wins, within the cap).
 * 2. Snapshot: the request stores the display data of the preview's jewelry pieces (name, price,
 *    currency, first https image URL, merchant product page) so the giver's report and e-card still
 *    name the pieces after the preview is gone. Product data only.
 * 3. Gone: a preview that was deleted, expired or lost its products. Recipient pages show "This preview
 *    has expired"; the report falls back to its cached results, else says the same.
 */
import type { StoreProductSnapshot } from "@/server/contracts/api";
import { defaultPageSnapshotStore } from "@/server/preview/page-snapshot-store";
import { defaultPreviewRepo, type PreviewRepo } from "@/server/preview/repo";
import { isPreviewStoreId, loadPreviewCatalogView, loadPreviewStore, previewKeyOf } from "./preview";

export const PREVIEW_MAX_LIFETIME_MS = 72 * 60 * 60 * 1000;

/** The preview's new expiry after a request that expires at `requestExpiresAt` (pure). */
export function extendedPreviewExpiry(current: Date, previewCreatedAt: Date, requestExpiresAt: Date): Date {
  const cap = previewCreatedAt.getTime() + PREVIEW_MAX_LIFETIME_MS;
  return new Date(Math.max(current.getTime(), Math.min(requestExpiresAt.getTime(), cap)));
}

/** Extends the preview behind `storeId` for a new request; returns the new expiry (null when not a live preview). */
export async function extendPreviewForRequest(storeId: string | undefined, requestExpiresAt: Date, repo: PreviewRepo = defaultPreviewRepo(), nowMs: number = Date.now()): Promise<Date | null> {
  const key = previewKeyOf(storeId);
  if (!key) return null;
  const rec = await repo.get(key, nowMs);
  if (!rec) return null;
  const next = extendedPreviewExpiry(rec.expiresAt, rec.createdAt, requestExpiresAt);
  if (next.getTime() > rec.expiresAt.getTime()) {
    await repo.update(key, { expiresAt: next });
    // A15: the preview's store-page copies keep the same expiry (and Firestore TTL) as the preview.
    if (rec.snapshot?.mode === "snapshot") await defaultPageSnapshotStore().extend(key, next).catch(() => undefined);
  }
  return next;
}

const firstHttps = (images: readonly string[]) => images.find((u) => /^https?:\/\//i.test(u) && !/^http:\/\//i.test(u)) ?? images.find((u) => /^https?:\/\//i.test(u));

/** Display data of every giftable piece of the preview behind `storeId` (undefined when not a preview). */
export async function previewSnapshot(storeId: string | undefined, repo?: PreviewRepo): Promise<StoreProductSnapshot[] | undefined> {
  const key = previewKeyOf(storeId);
  if (!key) return undefined;
  const view = await loadPreviewCatalogView(key, repo);
  if (!view) return undefined;
  const out: StoreProductSnapshot[] = [];
  for (const p of view.products) {
    const catalogId = view.skuIdByProduct[p.id];
    if (!catalogId) continue;
    const image = firstHttps(p.images);
    out.push({ catalogId, title: p.title, price: p.price, currency: p.currency, ...(image ? { image } : {}), url: p.url });
  }
  return out;
}

/** True when `storeId` is a preview whose catalog is no longer available. */
export async function isPreviewGone(storeId: string | undefined, repo?: PreviewRepo): Promise<boolean> {
  const key = previewKeyOf(storeId);
  if (!key) return isPreviewStoreId(storeId); // a malformed preview id can never resolve
  try {
    return (await loadPreviewCatalogView(key, repo)) === null;
  } catch {
    return false; // storage hiccup: don't declare it gone
  }
}

/** server/fit's StoreHooks for store-URL previews. */
export const previewStoreHooks = {
  snapshot: (storeId: string | undefined) => previewSnapshot(storeId),
  afterCreate: async (storeId: string | undefined, requestExpiresAt: Date) => {
    await extendPreviewForRequest(storeId, requestExpiresAt);
  },
  isGone: (storeId: string | undefined) => isPreviewGone(storeId),
  /** The preview's store name (for the gift pages' header after the preview is gone). */
  name: async (storeId: string | undefined) => {
    const key = previewKeyOf(storeId);
    if (!key) return undefined;
    return (await loadPreviewStore(key).catch(() => null))?.storeName || undefined;
  },
  /**
   * A16: previews can be tried on (pieces whose photo passed the eligibility checks), so the store itself never
   * rules a try-on out; whether one happens is the recipient session's call (server/privacy/tryon-mode.ts) and
   * the report reads it from the capture.
   */
  tryOnEnabled: () => true,
};

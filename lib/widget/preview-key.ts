/**
 * `data-store="preview:<key>"` parsing and the readiness check (owner: A6, ADR-055). Light on purpose:
 * middleware imports it, so it depends on the preview repo only (no catalog, no crawler).
 */
import { defaultPreviewRepo, PREVIEW_KEY_RE, type PreviewRepo } from "@/lib/preview/repo";

export const PREVIEW_STORE_PREFIX = "preview:";

/** "preview:<key>" → key; anything else → null. */
export function previewKeyOf(store: unknown): string | null {
  if (typeof store !== "string" || !store.startsWith(PREVIEW_STORE_PREFIX)) return null;
  const key = store.slice(PREVIEW_STORE_PREFIX.length);
  return PREVIEW_KEY_RE.test(key) ? key : null;
}

export const previewStoreId = (key: string) => `${PREVIEW_STORE_PREFIX}${key}`;

/** Is this Fit Request (its storeId) from a preview store? Try-on is off for those. */
export function isPreviewStoreId(storeId: string | null | undefined): boolean {
  return typeof storeId === "string" && storeId.startsWith(PREVIEW_STORE_PREFIX);
}

/** Is `store` a READY, unexpired preview? (/w frame-ancestors and the parent allow-list ask this.) */
export async function isReadyPreviewStore(store: unknown, repo: PreviewRepo = defaultPreviewRepo(), nowMs: number = Date.now()): Promise<boolean> {
  const key = previewKeyOf(store);
  if (!key) return false;
  try {
    return (await repo.get(key, nowMs))?.state === "ready";
  } catch {
    return false;
  }
}

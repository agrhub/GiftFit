/**
 * Client-side purchase beacon (owner: A6). Called once by the Aurum demo checkout
 * (components/store/CartView.tsx). The giver's own saved Fit Requests (this browser only,
 * components/gift/savedRequests.ts) hold their report links /g/<giverToken>; for each one we tell
 * POST /api/retailer/purchase which catalog ids were just bought. The server keeps only the ones
 * on that request's shortlist. No recipient data is involved and nothing is sent when the giver
 * has no saved requests. Never throws: checkout must not depend on metrics.
 */
import { loadSavedRequests } from "@/components/gift/savedRequests";

export const PURCHASE_ROUTE = "/api/retailer/purchase";

/** "/g/<token>" → token (undefined for anything else). */
export function giverTokenFromPath(path: string): string | undefined {
  const m = /^\/g\/([A-Za-z0-9_-]{16,})\/?$/.exec(path);
  return m?.[1];
}

export function recordGiftPurchases(catalogIds: readonly string[], fetchImpl: typeof fetch = fetch): void {
  try {
    const skuIds = [...new Set(catalogIds)].slice(0, 20);
    if (!skuIds.length) return;
    for (const r of loadSavedRequests()) {
      const giverToken = giverTokenFromPath(r.giverReportPath);
      if (!giverToken) continue;
      void fetchImpl(PURCHASE_ROUTE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ giverToken, skuIds }),
        keepalive: true,
      }).catch(() => undefined);
    }
  } catch {
    /* metrics are best-effort */
  }
}

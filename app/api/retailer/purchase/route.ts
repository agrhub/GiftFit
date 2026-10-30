/**
 * POST /api/retailer/purchase { giverToken, skuIds } → { recorded } (owner: A6). Records that
 * shortlisted pieces of the giver's Fit Request were bought as a gift. Same-origin only (no CORS).
 * Stores (fit request id, catalog id, time): no recipient data.
 */
import { handlePurchase } from "@/server/metrics/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request): Promise<Response> {
  return handlePurchase(req);
}

/**
 * GET /api/retailer/lookup?store=aurum&sku=&url=&name= (owner: A6). Public and CORS-enabled: the
 * script tag (client/plugin/giftfit.js) asks whether a PDP's product is in the store's catalog.
 * Product data only.
 */
import { handleLookup, LOOKUP_CORS } from "@/server/metrics/api";

export const runtime = "nodejs";

export function GET(req: Request): Response {
  return handleLookup(req);
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: LOOKUP_CORS });
}

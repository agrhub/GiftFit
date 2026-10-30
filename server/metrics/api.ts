/**
 * Handlers behind app/api/retailer/* (owner: A6). Route files stay thin; tests call these and the
 * routes. Every JSON body goes through assertGiverSafe (retailer data is aggregate or product data
 * only), and none of them returns tokens, request ids or recipient data.
 */
import { z } from "zod";
import { assertGiverSafe } from "@/server/privacy/giver-guard";
import { getPrivacyDeps } from "@/server/privacy/runtime";
import { hashToken, looksLikeToken } from "@/server/privacy/tokens";
import type { PrivacyRepos } from "@/server/privacy/repos/types";
import { findStore, matchProduct } from "./catalog";
import { buildRetailerSnapshot, type DataView } from "./console";
import { getPurchaseLog, type PurchaseLog } from "./purchases";

export interface RetailerApiDeps {
  repos: () => Promise<PrivacyRepos>;
  purchases: () => PurchaseLog;
  now: () => Date;
}

export const defaultRetailerDeps: RetailerApiDeps = {
  repos: async () => (await getPrivacyDeps()).repos,
  purchases: getPurchaseLog,
  now: () => new Date(),
};

function json(payload: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
  try {
    assertGiverSafe(payload);
  } catch {
    // Fail closed without echoing the payload (same policy as server/privacy giverJson).
    console.error("[retailer] blocked a response that failed the leak scan");
    headers.set("Cache-Control", "no-store");
    return Response.json({ error: "internal_error" }, { status: 500, headers });
  }
  return Response.json(payload, { ...init, headers });
}

// ---------------------------------------------------------------------------------------------
// GET /api/retailer/lookup?store=aurum&sku=&url=&name= (public, CORS: the script tag calls it)
// ---------------------------------------------------------------------------------------------

export const LOOKUP_CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

export interface LookupResponse {
  found: boolean;
  reason?: "unknown_store" | "not_in_catalog" | "missing_hints";
  product?: { id: string; slug: string; sku: string; title: string; price: number; currency: string; category: string };
  /** Path (on our origin) of the embed page for this product. */
  embedPath?: string;
}

export function handleLookup(req: Request): Response {
  const q = new URL(req.url).searchParams;
  const clip = (k: string) => (q.get(k) ?? "").slice(0, 512) || undefined;
  const headers = { ...LOOKUP_CORS, "Cache-Control": "public, max-age=300" };
  const store = findStore(clip("store"));
  if (!store) return json({ found: false, reason: "unknown_store" } satisfies LookupResponse, { headers });
  const hints = { sku: clip("sku"), url: clip("url"), name: clip("name") };
  if (!hints.sku && !hints.url && !hints.name) return json({ found: false, reason: "missing_hints" } satisfies LookupResponse, { headers });
  const sku = matchProduct(store, hints);
  if (!sku) return json({ found: false, reason: "not_in_catalog" } satisfies LookupResponse, { headers });
  const slug = sku.attributes.slug ?? sku.id;
  const body: LookupResponse = {
    found: true,
    product: { id: sku.id, slug, sku: sku.attributes.sku ?? sku.id, title: sku.title, price: sku.price, currency: sku.currency, category: sku.category },
    embedPath: `/embed?store=${encodeURIComponent(store.key)}&sku=${encodeURIComponent(slug)}`,
  };
  return json(body, { headers });
}

// ---------------------------------------------------------------------------------------------
// POST /api/retailer/purchase { giverToken, skuIds } → { recorded }
// ---------------------------------------------------------------------------------------------

const PurchaseBody = z
  .object({
    giverToken: z.string().max(128),
    skuIds: z.array(z.string().min(1).max(128)).min(1).max(20),
  })
  .strict();

export async function handlePurchase(req: Request, deps: RetailerApiDeps = defaultRetailerDeps): Promise<Response> {
  let body: z.infer<typeof PurchaseBody>;
  try {
    body = PurchaseBody.parse(await req.json());
  } catch {
    return json({ error: "bad_request", message: "body must be { giverToken, skuIds[1..20] }" }, { status: 400 });
  }
  // Unknown, malformed and foreign tokens all answer the same way, so the route is no token oracle.
  if (!looksLikeToken(body.giverToken)) return json({ recorded: 0 });
  const repos = await deps.repos();
  const request = await repos.fitRequests.findByGiverTokenHash(hashToken(body.giverToken));
  if (!request) return json({ recorded: 0 });
  const onShortlist = body.skuIds.filter((id) => request.shortlistIds.includes(id));
  const recorded = onShortlist.length ? deps.purchases().record(request.id, onShortlist, deps.now()) : 0;
  return json({ recorded });
}

// ---------------------------------------------------------------------------------------------
// GET /api/retailer/metrics?store=aurum&data=all|real → RetailerSnapshot (aggregates only)
// ---------------------------------------------------------------------------------------------

export async function handleMetrics(req: Request, deps: RetailerApiDeps = defaultRetailerDeps): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const view: DataView = q.get("data") === "real" ? "real" : "all";
  const snapshot = await buildRetailerSnapshot({ repos: await deps.repos(), purchases: deps.purchases(), now: deps.now }, { store: q.get("store") ?? undefined, view });
  return json(snapshot);
}

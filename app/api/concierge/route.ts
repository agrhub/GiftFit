/**
 * POST /api/concierge (owner: A7, ADR-040) — the Gift Concierge. Body: ConciergeRequestBody
 * ({messages:[{role,content}]}). Streams application/x-ndjson ConciergeEvents: start, text deltas,
 * a compact tool transcript, then `final` with a DRAFT GiftBrief and ≤ 3 grounded suggestions.
 * Nothing is created here: the giver confirms the brief, then the normal POST /api/fit/requests runs.
 *
 * Per-IP limit `concierge` (20/h, 60/day) → 429 + Retry-After before any Claude call. Every streamed
 * event passes assertGiverSafe (lib/concierge/stream.ts); error responses go through giverJson.
 * Catalog only: no recipient data, no photos, no YouCam calls.
 */
import { buildConciergeCatalog } from "@/lib/concierge/catalog";
import { runConcierge } from "@/lib/concierge/engine";
import { runGenericConcierge } from "@/lib/concierge/generic";
import { parseConciergeRequest } from "@/lib/concierge/request";
import { conciergeNdjson, NDJSON_CONTENT_TYPE } from "@/lib/concierge/stream";
import { giverJson } from "@/lib/privacy/giver-guard";
import { giverRateLimit } from "@/lib/privacy/rate-limit";
import { loadPreviewStore, previewKeyOf } from "@/lib/widget/preview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const limited = await giverRateLimit(req, "concierge");
  if (limited) return limited;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return giverJson({ error: "invalid_request" }, { status: 400 });
  }
  const parsed = parseConciergeRequest(body);
  if (!parsed.ok) return giverJson({ error: parsed.error }, { status: 400 });

  // Which catalog to ground on (ADR-055): the Aurum demo catalog, or a READY store-URL preview.
  let events = runConcierge(parsed.messages, { signal: req.signal, pageContext: parsed.context });
  if (parsed.store !== undefined && parsed.store !== "aurum") {
    const key = previewKeyOf(parsed.store);
    if (!key) return giverJson({ error: "invalid_request" }, { status: 400 });
    const store = await loadPreviewStore(key).catch(() => null);
    if (!store) return giverJson({ error: "store_not_found" }, { status: 404 });
    events = store.skus.length
      ? // Jewelry preview: the usual tools, grounded on that preview's key-scoped SKUs only.
        runConcierge(parsed.messages, { signal: req.signal, pageContext: parsed.context, catalog: buildConciergeCatalog(store.skus), tryOn: false })
      : // Any other store: product suggestions from its own products, no brief (no Fit Request, no try-on).
        runGenericConcierge(parsed.messages, { storeName: store.storeName, currency: store.currency, products: store.products }, { signal: req.signal, pageContext: parsed.context });
  }
  const stream = conciergeNdjson(events, req.signal);
  // NDJSON stream (manifest flag `ndjsonStream`): each line was checked by assertGiverSafe.
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": NDJSON_CONTENT_TYPE,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Accel-Buffering": "no",
    },
  });
}

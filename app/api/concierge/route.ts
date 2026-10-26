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
import { runConcierge } from "@/lib/concierge/engine";
import { parseConciergeRequest } from "@/lib/concierge/request";
import { conciergeNdjson, NDJSON_CONTENT_TYPE } from "@/lib/concierge/stream";
import { giverJson } from "@/lib/privacy/giver-guard";
import { giverRateLimit } from "@/lib/privacy/rate-limit";

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

  const stream = conciergeNdjson(runConcierge(parsed.messages, { signal: req.signal, pageContext: parsed.context }), req.signal);
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

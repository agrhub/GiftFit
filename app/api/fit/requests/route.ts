/**
 * POST /api/fit/requests (giver-facing). Body: CreateFitRequestBody (server/contracts/api.ts).
 * Returns CreateFitRequestResponse (201): the giver token, the recipient link path and expiry.
 * Decoys are chosen server-side and never returned; tokens are stored only as SHA-256 hashes.
 * Optional `Idempotency-Key` header: a retry with the same key gets the same response (server/fit/idempotency.ts).
 */
import { handleCreateRequest } from "@/server/fit/api";
import { giverRateLimit } from "@/server/privacy/rate-limit";
import { getFitDeps } from "@/server/fit/deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  // A5 per-IP limit, 10/h; run inside the handler so an Idempotency-Key replay (A25) spends no slot.
  return handleCreateRequest(req, getFitDeps(), () => giverRateLimit(req, "fit_requests"));
}

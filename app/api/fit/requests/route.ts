/**
 * POST /api/fit/requests (giver-facing). Body: CreateFitRequestBody (lib/contracts/api.ts).
 * Returns CreateFitRequestResponse (201): the giver token, the recipient link path and expiry.
 * Decoys are chosen server-side and never returned; tokens are stored only as SHA-256 hashes.
 */
import { handleCreateRequest } from "@/lib/fit/api";
import { giverRateLimit } from "@/lib/privacy/rate-limit";
import { getFitDeps } from "@/lib/fit/deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  return giverRateLimit(req, "fit_requests") ?? handleCreateRequest(req, getFitDeps()); // A5 per-IP limit, 10/h
}

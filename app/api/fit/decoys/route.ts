/**
 * POST /api/fit/decoys (giver-facing). Body `{ shortlistIds: string[1..4] }`. A preview with a fresh
 * random seed: it never reproduces the decoys of a stored Fit Request.
 * Returns DecoysResponse: decoy ids, ok flag and fallback reason codes. No recipient data exists here.
 */
import { handleDecoys } from "@/server/fit/api";
import { getFitDeps } from "@/server/fit/deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  return handleDecoys(req, getFitDeps());
}

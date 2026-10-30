/**
 * POST /api/fit/report (giver-facing). Body `{ giverToken }` (or header `x-giver-token`).
 * Returns GiverReportStatus (server/contracts/api.ts): the status and, once completed, the shortlist's
 * scores, breakdown and reasons, label strings and hearted shortlist ids. Never recipient images,
 * hex values, CIELAB, face attributes or undertone numbers.
 */
import { handleReport } from "@/server/fit/api";
import { getFitDeps } from "@/server/fit/deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  return handleReport(req, getFitDeps());
}

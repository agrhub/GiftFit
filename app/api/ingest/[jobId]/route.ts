/**
 * GET /api/ingest/<jobId> → { id, url, status, progress, skuCount, coverage, tier, platform, error }
 */
import { loadIngestConfig } from "@/server/ingest/config";
import { getJob } from "@/server/ingest/worker/jobs";
import { authorised } from "@/server/ingest/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ jobId: string }> }): Promise<Response> {
  if (!authorised(req, loadIngestConfig().adminToken)) return Response.json({ error: "unauthorised" }, { status: 401 });
  const { jobId } = await ctx.params;
  const job = getJob(jobId);
  if (!job) return Response.json({ error: "job not found" }, { status: 404 });
  return Response.json(job);
}

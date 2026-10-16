/**
 * POST /api/ingest  { url, tier?, maxProducts? } → 202 { jobId, status, statusUrl }
 * GET  /api/ingest  → { jobs: [...] } (most recent first)
 *
 * Starts an Auto-Ingest job for a store URL (owner: A10; called by A6's Retailer Console). Guards:
 * optional bearer token (INGEST_ADMIN_TOKEN), host allow-list (INGEST_ALLOWED_HOSTS; fixture hosts
 * only with INGEST_FIXTURE=1; never raw IPs), one running job per host, politeness inside the pipeline.
 */
import { z } from "zod";
import { authorised } from "@/lib/ingest/auth";
import { isHostAllowed, loadIngestConfig } from "@/lib/ingest/config";
import { listJobs, startIngestJob } from "@/workers/ingest/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z
  .object({
    url: z.string().min(1).max(2048),
    tier: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal("auto")]).optional(),
    maxProducts: z.number().int().min(1).max(1000).optional(),
  })
  .strict();

export async function POST(req: Request): Promise<Response> {
  const config = loadIngestConfig();
  if (!authorised(req, config.adminToken)) return Response.json({ error: "unauthorised" }, { status: 401 });
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return Response.json({ error: "body must be { url, tier?, maxProducts? }" }, { status: 400 });
  }
  const allowed = isHostAllowed(body.url, config);
  if (!allowed.ok) return Response.json({ error: allowed.reason }, { status: 403 });
  const { job, reused } = startIngestJob({ url: allowed.url.href, tier: body.tier, maxProducts: body.maxProducts });
  return Response.json(
    { jobId: job.id, status: job.status, reused, statusUrl: `/api/ingest/${job.id}`, skuCount: job.skuCount },
    { status: reused ? 200 : 202 },
  );
}

export async function GET(req: Request): Promise<Response> {
  const config = loadIngestConfig();
  if (!authorised(req, config.adminToken)) return Response.json({ error: "unauthorised" }, { status: 401 });
  return Response.json({ jobs: listJobs() });
}

/**
 * GET /api/preview/<key> → { state: "queued"|"crawling"|"ready"|"refused"|"failed", domain, name?, productCount?, reason? }
 * (owner: A10; ADR-055). 404 { error: "not_found" } for unknown or expired keys. No products or URLs here:
 * the preview page reads them server-side through server/preview/catalog.ts.
 */
import { clientKey } from "@/server/privacy/client-ip";
import { giverJson } from "@/server/privacy/giver-guard";
import { rateLimitsEnabled, takeRate } from "@/server/privacy/rate-limit";
import { getPreviewStatus } from "@/server/preview/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ key: string }> }): Promise<Response> {
  if (rateLimitsEnabled()) {
    const d = takeRate("preview_status", clientKey(req, "preview_status"), Date.now());
    if (!d.ok) return giverJson({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(d.retryAfterSec) } });
  }
  const { key } = await ctx.params;
  let status;
  try {
    status = await getPreviewStatus(key);
  } catch (err) {
    console.error("[preview] status read failed:", (err as Error).message);
    return giverJson({ error: "unavailable" }, { status: 503 });
  }
  if (!status) return giverJson({ error: "not_found" }, { status: 404 });
  return giverJson(status);
}

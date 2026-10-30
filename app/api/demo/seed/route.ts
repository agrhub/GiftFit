/**
 * POST /api/demo/seed  (audience: giver, contract: DemoSeedBody → DemoSeedResponse)
 * Seeded judge demo (MASTER_PLAN §8): creates a fresh Fit Request for an AI-generated model from the
 * committed showcase fixtures, already consented and captured, so /r/<token> opens on the carousel.
 * No selfie, no YouCam call, 0 units. Rate-limited per trusted client IP (10 per hour, salted hash only;
 * server/privacy/rate-limit.ts). The response holds
 * only links and labels.
 */
import { giverJson } from "@/server/privacy/giver-guard";
import { DemoError, seedDemoRequest } from "@/server/privacy/demo";
import { takeRateFor } from "@/server/privacy/rate-limit";
import { getPrivacyDeps } from "@/server/privacy/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const deps = await getPrivacyDeps();
  const limit = await takeRateFor(req, "demo_seed", deps.now().getTime());
  if (!limit.ok) return giverJson({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } });
  let body: unknown = {};
  const text = await req.text();
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      return giverJson({ error: "invalid_json" }, { status: 400 });
    }
  }
  try {
    const seeded = await seedDemoRequest(deps, { subject: (body as { subject?: unknown } | null)?.subject });
    return giverJson(seeded, { status: 201 });
  } catch (err) {
    if (err instanceof DemoError) return giverJson({ error: err.code }, { status: err.status });
    throw err;
  }
}

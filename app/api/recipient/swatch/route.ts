/**
 * POST /api/recipient/swatch  (audience: recipient, contract: SwatchBody → SwatchResponse)
 * Renders one metal of one design lazily on the photo kept from capture (YOUCAM_MOCK=1 by default;
 * the cost guard decides any real call). Cached per (photo, variant): repeats are free and don't
 * count. At most 4 extra renders per Fit Request; the 5th returns `cap_reached` without a call.
 */
import { FlowError, flowErrorResponse, swatchFlow } from "@/lib/privacy/recipient-flow";
import { takeRateFor } from "@/lib/privacy/rate-limit";
import { getPrivacyDeps } from "@/lib/privacy/runtime";
import { recipientError, recipientJson, resolveRecipientSession } from "@/lib/privacy/session";
import { isPreviewStoreId } from "@/lib/widget/preview-key";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request): Promise<Response> {
  const deps = await getPrivacyDeps();
  const session = await resolveRecipientSession(req, deps);
  if (!session.ok) return recipientError(session.status, session.error);
  // ADR-055: try-on is off for store-URL previews (no YouCam call, no render).
  if (isPreviewStoreId(session.request.storeId)) return recipientError(409, "tryon_disabled_preview");
  if (!deps.capturePorts) return recipientError(503, "capture_not_configured");
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return recipientError(400, "invalid_json");
  }
  const baseUrl = new URL(req.url).origin;
  try {
    return recipientJson(await swatchFlow(deps, {
        request: session.request,
        sessionToken: session.token,
        body,
        baseUrl,
        ports: deps.capturePorts(baseUrl),
        // Per-IP limit (8/h) only for a real render: not mock, demo, cached, capped or refused.
        beforeYoucam: (deps.youcamMode?.() ?? "mock") === "real" ? () => takeRateFor(req, "swatch", deps.now().getTime()) : undefined,
      }));
  } catch (err) {
    if (err instanceof FlowError) return flowErrorResponse(err); // 429 rate_limited / 503 daily_cap_reached carry Retry-After
    throw err;
  }
}

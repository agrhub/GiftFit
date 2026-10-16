/**
 * POST /api/recipient/capture  (audience: recipient, contract: CaptureResponse)
 * multipart/form-data: `selfie` (jpeg/png ≤ 10 MB, required), `hand` (optional).
 * Runs Facial Color Tones + Face Attributes + jewelry try-ons through lib/youcam (YOUCAM_MOCK=1 by
 * default; the cost guard decides any real call). Photos are deleted in `finally` (runCapture).
 * Items needing a hand photo without one come back as `skipped_needs_hand`.
 *
 * GET /api/recipient/capture (ADR-023): the same CaptureResponse for an already-captured session,
 * with freshly signed image URLs; 404 { error: "not_captured" } before capture.
 */
import { jewelryRules } from "@/lib/verticals/jewelry";
import { FlowError, flowErrorResponse, captureFlow, capturedView, readPhoto } from "@/lib/privacy/recipient-flow";
import { takeRateFor } from "@/lib/privacy/rate-limit";
import { getPrivacyDeps } from "@/lib/privacy/runtime";
import { recipientError, recipientJson, resolveRecipientSession } from "@/lib/privacy/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request): Promise<Response> {
  const deps = await getPrivacyDeps();
  const session = await resolveRecipientSession(req, deps);
  if (!session.ok) return recipientError(session.status, session.error);
  const baseUrl = new URL(req.url).origin;
  if (!deps.capturePorts) return recipientError(503, "capture_not_configured");
  try {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw new FlowError(400, "multipart_form_required");
    }
    const selfie = await readPhoto(form, "selfie", true);
    const hand = await readPhoto(form, "hand", false);
    const body = await captureFlow(deps, {
      request: session.request,
      sessionToken: session.token,
      selfie: selfie!,
      hand,
      baseUrl,
      rules: jewelryRules,
      ports: deps.capturePorts(baseUrl),
      // Per-IP limit (2/h, 4/24h) only when this capture can reach the paid API (not mock, not demo).
      beforeYoucam: (deps.youcamMode?.() ?? "mock") === "real" ? () => takeRateFor(req, "capture", deps.now().getTime()) : undefined,
    });
    return recipientJson(body);
  } catch (err) {
    if (err instanceof FlowError) return flowErrorResponse(err); // 429 rate_limited / 503 daily_cap_reached carry Retry-After
    throw err;
  }
}

export async function GET(req: Request): Promise<Response> {
  const deps = await getPrivacyDeps();
  const session = await resolveRecipientSession(req, deps);
  if (!session.ok) return recipientError(session.status, session.error);
  try {
    return recipientJson(await capturedView(deps, session.request, session.token));
  } catch (err) {
    if (err instanceof FlowError) return recipientError(err.status, err.code);
    throw err;
  }
}

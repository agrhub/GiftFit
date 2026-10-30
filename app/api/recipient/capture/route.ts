/**
 * POST /api/recipient/capture  (audience: recipient, contract: CaptureResponse)
 * multipart/form-data: `selfie` (jpeg/png ≤ 10 MB, required), `hand` (optional).
 * Runs Facial Color Tones + Face Attributes + jewelry try-ons through server/youcam (YOUCAM_MOCK=1 by
 * default; the cost guard decides any real call). Photos are deleted in `finally` (runCapture).
 * Items needing a hand photo without one come back as `skipped_needs_hand`.
 * A16: who gets a try-on is decided here per call (server/privacy/tryon-mode.ts): public production recipients get
 * 409 before the upload is read (no YouCam call); only the owner's recording session gets a paid grant.
 *
 * GET /api/recipient/capture (ADR-023): the same CaptureResponse for an already-captured session,
 * with freshly signed image URLs; 404 { error: "not_captured" } before capture.
 */
import { jewelryRules } from "@/server/verticals/jewelry";
import { FlowError, flowErrorResponse, captureFlow, capturedView, readPhoto, tryOnOffCode } from "@/server/privacy/recipient-flow";
import { takeRateFor } from "@/server/privacy/rate-limit";
import { getPrivacyDeps } from "@/server/privacy/runtime";
import { recipientError, recipientJson, resolveRecipientSession } from "@/server/privacy/session";
import { resolveCarousel } from "@/server/privacy/carousel";
import { grantFor, requestTryOn } from "@/server/privacy/tryon-mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request): Promise<Response> {
  const deps = await getPrivacyDeps();
  const session = await resolveRecipientSession(req, deps);
  if (!session.ok) return recipientError(session.status, session.error);
  // A16: no try-on for this recipient (public production, or no usable photo): refuse before the upload is read.
  const access = await requestTryOn(deps, session.request, req, { skus: (await resolveCarousel(deps, session.request)).map((c) => c.sku) });
  if (access.mode === "off") return recipientError(409, tryOnOffCode(session.request));
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
      ports: deps.capturePorts(baseUrl, { paidGrant: grantFor(access, req) }),
      access,
      // Per-IP limit (2/h, 4/24h) whenever this capture can reach the paid API (since A16 only the owner's
      // recording session can): a leaked owner cookie still gets at most 4 captures a day per network.
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

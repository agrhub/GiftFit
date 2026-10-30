/**
 * GET /api/recipient/tryon/{id}?exp=...&sig=...  (audience: recipient)
 * Serves one try-on image to the recipient session that owns it. Requires, all at once:
 * a valid recipient session (cookie or bearer), a valid HMAC signature bound to that session
 * and this try-on id, an unexpired exp (<= 15 min), and the try-on belonging to the session's
 * Fit Request. Every failure is a bare 403/404 with no body detail. Never cached.
 */
import { readFixtureImage } from "@/server/privacy/demo";
import { getPrivacyDeps } from "@/server/privacy/runtime";
import { recipientError, resolveRecipientSession } from "@/server/privacy/session";
import { verifyTryOnSignature } from "@/server/privacy/signed-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const IMAGE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
};

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const deps = await getPrivacyDeps();
  const session = await resolveRecipientSession(req, deps);
  if (!session.ok) return recipientError(session.status === 401 ? 403 : session.status, "forbidden");

  const url = new URL(req.url);
  const check = verifyTryOnSignature({
    tryOnId: id,
    sessionToken: session.token,
    exp: url.searchParams.get("exp"),
    sig: url.searchParams.get("sig"),
    secret: deps.signingSecret,
    nowMs: deps.now().getTime(),
  });
  if (!check.ok) return recipientError(403, "forbidden");

  const tryOn = await deps.repos.tryons.get(id);
  if (!tryOn || tryOn.fitRequestId !== session.request.id || !tryOn.resultRef) return recipientError(404, "not_found");
  if (tryOn.expiresAt.getTime() <= deps.now().getTime()) return recipientError(404, "not_found");
  // No image of the recipient is served after "Delete my photo now", in any case.
  if (session.request.photoDeletedAt) return recipientError(404, "not_found");

  // Seeded judge demo: a committed fixture of an AI-generated model, revoked for this request at Done.
  if (tryOn.resultRef.startsWith("fixture:")) {
    if (session.request.status === "completed") return recipientError(404, "not_found");
    const img = await readFixtureImage(tryOn.resultRef);
    if (!img) return recipientError(404, "not_found");
    return new Response(new Uint8Array(img.bytes), { headers: { ...IMAGE_HEADERS, "Content-Type": img.contentType, "X-GiftFit-Demo": "AI-generated model" } });
  }
  if (!tryOn.resultRef.startsWith("store:")) return recipientError(404, "not_found");

  const obj = await deps.photos.get(tryOn.resultRef.slice("store:".length));
  if (!obj) return recipientError(404, "not_found");
  return new Response(new Uint8Array(obj.bytes), { headers: { ...IMAGE_HEADERS, "Content-Type": obj.contentType } });
}

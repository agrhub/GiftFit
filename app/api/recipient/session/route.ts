/**
 * POST /api/recipient/session  (audience: recipient, contract: RecipientSessionResponse)
 * Opens the recipient link (Bearer recipient token): 6 carousel items with opaque per-request
 * item ids in a per-request shuffled order, and the HttpOnly gf_recipient cookie for signed
 * try-on images. Catalog ids, shortlist and decoys are never distinguishable.
 */
import { sessionResponse } from "@/lib/privacy/carousel";
import { getPrivacyDeps } from "@/lib/privacy/runtime";
import { recipientError, recipientJson, recipientSessionCookie, resolveRecipientSession } from "@/lib/privacy/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const deps = await getPrivacyDeps();
  const session = await resolveRecipientSession(req, deps);
  if (!session.ok) return recipientError(session.status, session.error);
  let request = session.request;
  if (request.status === "created") {
    await deps.repos.fitRequests.setStatus(request.id, "opened");
    request = { ...request, status: "opened" };
  }
  const body = await sessionResponse(deps, request);
  const maxAgeSec = Math.max(1, Math.floor((request.expiresAt.getTime() - deps.now().getTime()) / 1000));
  const secure = new URL(req.url).protocol === "https:" || process.env.NODE_ENV === "production";
  return recipientJson(body, { headers: { "Set-Cookie": recipientSessionCookie(session.token, { secure, maxAgeSec }) } });
}

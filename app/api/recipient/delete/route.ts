/**
 * POST /api/recipient/delete  (audience: recipient)
 * One-tap "Delete everything": blobs, YouCam result cache, YouCam tasks, and every
 * recipient-derived row of this Fit Request; both links stop working. Returns a receipt.
 * Auth: recipient token (Bearer or gf_recipient cookie). A giver token is rejected.
 */
import { deleteEverything } from "@/server/privacy/delete-everything";
import { getPrivacyDeps } from "@/server/privacy/runtime";
import { clearRecipientSessionCookie, recipientError, resolveRecipientSession } from "@/server/privacy/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const deps = await getPrivacyDeps();
  const session = await resolveRecipientSession(req, deps);
  if (!session.ok) {
    // Already gone (expired or deleted) is success from the recipient's point of view.
    if (session.status === 410) return Response.json({ ok: true, alreadyDeleted: true }, { headers: { "Cache-Control": "private, no-store", "Set-Cookie": clearRecipientSessionCookie() } });
    return recipientError(session.status, session.error);
  }
  const receipt = await deleteEverything(deps, session.request.id, "recipient_request");
  return Response.json(
    {
      ok: receipt.verified,
      deleted: receipt.deleted,
      youcamTasksPending: receipt.youcamTasksPending.length,
      verified: receipt.verified,
    },
    { status: receipt.verified ? 200 : 500, headers: { "Cache-Control": "private, no-store", "Set-Cookie": clearRecipientSessionCookie() } },
  );
}

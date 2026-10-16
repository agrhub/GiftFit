/**
 * POST /api/recipient/delete-photo  (audience: recipient, contract: DeletePhotoResponse, ADR-036)
 * "Delete my photo now": deletes the kept selfie and hand photo immediately, at any point in the
 * flow. Rendered try-ons and hearts stay; further metal swatch renders return `photo_deleted`.
 * Idempotent.
 */
import { FlowError, deletePhotoFlow } from "@/lib/privacy/recipient-flow";
import { getPrivacyDeps } from "@/lib/privacy/runtime";
import { recipientError, recipientJson, resolveRecipientSession } from "@/lib/privacy/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const deps = await getPrivacyDeps();
  const session = await resolveRecipientSession(req, deps);
  if (!session.ok) return recipientError(session.status, session.error);
  try {
    return recipientJson(await deletePhotoFlow(deps, session.request));
  } catch (err) {
    if (err instanceof FlowError) return recipientError(err.status, err.code);
    throw err;
  }
}

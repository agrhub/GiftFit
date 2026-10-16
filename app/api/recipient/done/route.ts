/**
 * POST /api/recipient/done  (audience: recipient, contract: DoneResponse)
 * Marks the Fit Request completed and deletes the try-on renders now, so no image of the
 * recipient is stored any more (input photos were already deleted at capture).
 */
import { FlowError, doneFlow } from "@/lib/privacy/recipient-flow";
import { getPrivacyDeps } from "@/lib/privacy/runtime";
import { recipientError, recipientJson, resolveRecipientSession } from "@/lib/privacy/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const deps = await getPrivacyDeps();
  const session = await resolveRecipientSession(req, deps);
  if (!session.ok) return recipientError(session.status, session.error);
  try {
    return recipientJson(await doneFlow(deps, session.request));
  } catch (err) {
    if (err instanceof FlowError) return recipientError(err.status, err.code);
    throw err;
  }
}

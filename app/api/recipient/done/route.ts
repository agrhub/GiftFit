/**
 * POST /api/recipient/done  (audience: recipient, contract: DoneResponse)
 * Marks the Fit Request completed and deletes the try-on renders now, so no image of the
 * recipient is stored any more (input photos were already deleted at capture).
 */
import { FlowError, doneFlow } from "@/server/privacy/recipient-flow";
import { getPrivacyDeps } from "@/server/privacy/runtime";
import { recipientError, recipientJson, resolveRecipientSession } from "@/server/privacy/session";
import { notifyGiverReportReady } from "@/server/widget/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const deps = await getPrivacyDeps();
  const session = await resolveRecipientSession(req, deps);
  if (!session.ok) return recipientError(session.status, session.error);
  try {
    const done = await doneFlow(deps, session.request);
    // A6 widget (ADR-046): one "Fit Report ready" e-mail if the giver left an address; never throws.
    // A16: "finished trying on" only when a try-on happened (an estimate exists); otherwise "sent their hearts".
    const tried = Boolean((await deps.repos.profiles.get(session.request.id))?.undertoneEstimate);
    await notifyGiverReportReady(session.request, req, undefined, { tryOn: tried });
    return recipientJson(done);
  } catch (err) {
    if (err instanceof FlowError) return recipientError(err.status, err.code);
    throw err;
  }
}

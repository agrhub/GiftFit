/**
 * POST /api/recipient/hearts  (audience: recipient)  body { itemIds: string[] } → { hearted: string[] }
 * Replaces the hearted set. Item ids are mapped to catalog ids server-side only.
 */
import { FlowError, setHeartsFlow } from "@/lib/privacy/recipient-flow";
import { getPrivacyDeps } from "@/lib/privacy/runtime";
import { recipientError, recipientJson, resolveRecipientSession } from "@/lib/privacy/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const deps = await getPrivacyDeps();
  const session = await resolveRecipientSession(req, deps);
  if (!session.ok) return recipientError(session.status, session.error);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return recipientError(400, "invalid_json");
  }
  try {
    return recipientJson(await setHeartsFlow(deps, session.request, body));
  } catch (err) {
    if (err instanceof FlowError) return recipientError(err.status, err.code);
    throw err;
  }
}

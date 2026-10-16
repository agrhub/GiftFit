/**
 * POST /api/recipient/wish-metal  (audience: recipient)  body { itemId } → { wished: itemId[] }
 * "Love the style, wish it came in another metal": stores a metal_wishes row. No render.
 */
import { FlowError, wishMetalFlow } from "@/lib/privacy/recipient-flow";
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
    return recipientJson(await wishMetalFlow(deps, session.request, body));
  } catch (err) {
    if (err instanceof FlowError) return recipientError(err.status, err.code);
    throw err;
  }
}

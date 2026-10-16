/**
 * POST /api/recipient/consent  (audience: recipient)  body { accepted: true } → RecipientSessionResponse
 * Records consent (recipient_profiles.consent_at) and moves the request to `consented`. Idempotent.
 */
import { sessionResponse } from "@/lib/privacy/carousel";
import { recordConsent } from "@/lib/privacy/recipient-flow";
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
  if ((body as { accepted?: unknown } | null)?.accepted !== true) return recipientError(400, "consent_not_given");
  const request = await recordConsent(deps, session.request);
  return recipientJson(await sessionResponse(deps, request));
}

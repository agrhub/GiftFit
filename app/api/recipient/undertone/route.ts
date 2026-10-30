/**
 * /api/recipient/undertone  (audience: recipient)
 * GET  -> { estimate, confidence, override, effective, label: "estimate" }
 * POST { undertone: "warm" | "neutral" | "cool" | null } -> sets (or clears) the override.
 * The recipient's override always wins over the estimate in the Fit Engine.
 */
import { getPrivacyDeps } from "@/server/privacy/runtime";
import { recipientError, resolveRecipientSession } from "@/server/privacy/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UNDERTONES = ["warm", "neutral", "cool"] as const;
const NO_STORE = { "Cache-Control": "private, no-store" };

export async function GET(req: Request): Promise<Response> {
  const deps = await getPrivacyDeps();
  const session = await resolveRecipientSession(req, deps);
  if (!session.ok) return recipientError(session.status, session.error);
  const p = await deps.repos.profiles.get(session.request.id);
  if (!p) return recipientError(404, "no_profile");
  return Response.json(
    {
      label: "estimate",
      estimate: p.undertoneEstimate,
      confidence: p.undertoneConfidence,
      override: p.undertoneOverride,
      effective: p.undertoneOverride ?? p.undertoneEstimate,
    },
    { headers: NO_STORE },
  );
}

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
  const value = (body as { undertone?: unknown } | null)?.undertone;
  if (value !== null && !(typeof value === "string" && (UNDERTONES as readonly string[]).includes(value))) {
    return recipientError(400, "undertone must be warm, neutral, cool or null");
  }
  const ok = await deps.repos.profiles.setOverride(session.request.id, value as (typeof UNDERTONES)[number] | null);
  if (!ok) return recipientError(404, "no_profile");
  const p = await deps.repos.profiles.get(session.request.id);
  return Response.json(
    { label: "estimate", estimate: p?.undertoneEstimate ?? null, override: p?.undertoneOverride ?? null, effective: p?.undertoneOverride ?? p?.undertoneEstimate ?? null },
    { headers: NO_STORE },
  );
}

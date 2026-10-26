/**
 * Voice session key for the per-session caps (owner: A13). The widget sends `x-voice-session: <uuid>`
 * (crypto.randomUUID() kept in the iframe's sessionStorage) on /api/voice/stt and /api/voice/tts. It is
 * not a credential and never touches a giver or recipient token. Caps are keyed on
 * HMAC(signing secret, ip-key | uuid): the salted per-IP key (lib/privacy/client-ip.ts) binds the id to
 * the caller's network, so a copied id does not share another shopper's allowance, and neither the
 * UUID nor the IP is stored. A client that mints a fresh UUID per request only escapes the per-session
 * cap; the per-IP rate limits (voice_stt / voice_tts) and the daily caps still hold.
 */
import { createHmac } from "node:crypto";
import { clientKey } from "@/lib/privacy/client-ip";
import { getSigningSecret } from "@/lib/privacy/signed-url";

export const VOICE_SESSION_HEADER = "x-voice-session";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isVoiceSessionId(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}

/** 24 lowercase hex chars (fits the daily-counter key format), or null when the header is not a UUID. */
export function voiceSessionKey(req: Request, env: Record<string, string | undefined> = process.env): string | null {
  const raw = req.headers.get(VOICE_SESSION_HEADER)?.trim();
  if (!isVoiceSessionId(raw)) return null;
  const ip = clientKey(req, "voice_session", env);
  return createHmac("sha256", getSigningSecret(env)).update(`voice-session|${ip}|${raw.toLowerCase()}`, "utf8").digest("hex").slice(0, 24);
}

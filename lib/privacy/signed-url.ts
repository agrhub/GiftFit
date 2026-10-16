/**
 * Short-lived signed URLs for try-on images (owner: A5).
 *
 * A try-on image is fetched from GET /api/recipient/tryon/{tryOnId}?exp=...&sig=...
 * The signature is HMAC-SHA256(GIFTFIT_URL_SIGNING_SECRET) over the try-on id, the expiry
 * and the SHA-256 of the recipient session token. The fetch route recomputes it from the
 * session token the request carries (cookie or bearer), so a copied URL is useless to anyone
 * without the recipient's own session, and it dies after at most 15 minutes.
 */
import { createHmac, randomBytes } from "node:crypto";
import { privacyState } from "./global-state";
import { hashToken, safeEqual } from "./tokens";

export const SIGNED_URL_MAX_TTL_SEC = 15 * 60;
export const SIGNED_URL_DEFAULT_TTL_SEC = 10 * 60;
/** Clock skew tolerated when checking that exp is not too far in the future. */
const MAX_SKEW_SEC = 30;
const VERSION = "v1";

export const TRYON_IMAGE_PATH = "/api/recipient/tryon";

/**
 * GIFTFIT_URL_SIGNING_SECRET (>= 32 chars). In production a missing secret is an error. Elsewhere
 * a random per-PROCESS secret is used (kept on globalThis so every route bundle shares it; URLs
 * die with the process), with a one-time warning except under tests.
 */
export function getSigningSecret(env: Record<string, string | undefined> = process.env): string {
  const s = env.GIFTFIT_URL_SIGNING_SECRET?.trim();
  if (s) {
    if (s.length < 32) throw new Error("GIFTFIT_URL_SIGNING_SECRET must be at least 32 characters");
    return s;
  }
  if (env.NODE_ENV === "production") throw new Error("GIFTFIT_URL_SIGNING_SECRET is not set");
  const state = privacyState();
  if (!state.devSigningSecret) {
    state.devSigningSecret = randomBytes(32).toString("base64url");
    if (env.NODE_ENV !== "test" && !state.devSecretWarned) {
      state.devSecretWarned = true;
      console.warn("[privacy] GIFTFIT_URL_SIGNING_SECRET is not set: using a random per-process secret (signed URLs and item ids change on restart). Set it outside local dev.");
    }
  }
  return state.devSigningSecret;
}

function mac(secret: string, tryOnId: string, exp: number, sessionToken: string): string {
  return createHmac("sha256", secret)
    .update(`${VERSION}|tryon|${tryOnId}|${exp}|${hashToken(sessionToken)}`, "utf8")
    .digest("base64url");
}

export interface SignTryOnUrlInput {
  tryOnId: string;
  /** The recipient session token (clear text, held by the recipient only). */
  sessionToken: string;
  secret: string;
  nowMs?: number;
  ttlSec?: number;
}

export interface SignedTryOnUrl {
  url: string;
  exp: number;
  sig: string;
}

export function signTryOnUrl(input: SignTryOnUrlInput): SignedTryOnUrl {
  const ttl = input.ttlSec ?? SIGNED_URL_DEFAULT_TTL_SEC;
  if (!(ttl > 0) || ttl > SIGNED_URL_MAX_TTL_SEC) throw new Error(`signed URL TTL must be 1..${SIGNED_URL_MAX_TTL_SEC} s`);
  if (!input.tryOnId || !input.sessionToken) throw new Error("tryOnId and sessionToken are required");
  const exp = Math.floor((input.nowMs ?? Date.now()) / 1000) + Math.floor(ttl);
  const sig = mac(input.secret, input.tryOnId, exp, input.sessionToken);
  const url = `${TRYON_IMAGE_PATH}/${encodeURIComponent(input.tryOnId)}?exp=${exp}&sig=${sig}`;
  return { url, exp, sig };
}

export type SignatureCheck = { ok: true } | { ok: false; reason: "malformed" | "expired" | "too_far_in_future" | "bad_signature" };

export interface VerifyTryOnSignatureInput {
  tryOnId: string;
  sessionToken: string;
  exp: string | null | undefined;
  sig: string | null | undefined;
  secret: string;
  nowMs?: number;
}

export function verifyTryOnSignature(input: VerifyTryOnSignatureInput): SignatureCheck {
  const { exp: expRaw, sig } = input;
  if (!expRaw || !sig || !/^\d{1,12}$/.test(expRaw) || !/^[A-Za-z0-9_-]{43}$/.test(sig)) return { ok: false, reason: "malformed" };
  const exp = Number(expRaw);
  const now = Math.floor((input.nowMs ?? Date.now()) / 1000);
  // Compute the MAC before branching on time so a forged URL and an expired one cost the same.
  const expected = mac(input.secret, input.tryOnId, exp, input.sessionToken);
  const sigOk = safeEqual(expected, sig);
  if (!sigOk) return { ok: false, reason: "bad_signature" };
  if (now > exp) return { ok: false, reason: "expired" };
  if (exp - now > SIGNED_URL_MAX_TTL_SEC + MAX_SKEW_SEC) return { ok: false, reason: "too_far_in_future" };
  return { ok: true };
}

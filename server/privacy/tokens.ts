/**
 * Fit Request link tokens (owner: A5).
 *
 * - Giver and recipient each get their own token: 32 random bytes (256 bits), base64url.
 * - Only SHA-256 hashes are stored (fit_requests.giver_token_hash / recipient_token_hash).
 * - Links expire FIT_REQUEST_TTL_HOURS (72 h) after creation; an expired, deleted or
 *   unknown token is treated the same way ("link not valid") so nothing is revealed.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { FIT_REQUEST_TTL_HOURS } from "@/server/db/schema";

/** Bytes of entropy per token. 32 bytes = 256 bits (brief requires >= 128). */
export const TOKEN_BYTES = 32;
export const FIT_REQUEST_TTL_MS = FIT_REQUEST_TTL_HOURS * 60 * 60 * 1000;

export function newToken(bytes = TOKEN_BYTES): string {
  if (bytes < 16) throw new Error("tokens must carry at least 128 bits of entropy");
  return randomBytes(bytes).toString("base64url");
}

/** Hex SHA-256 of a token: the only form that is ever stored. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time string comparison (length difference returns false without early exit on content). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // Compare against itself to keep timing roughly independent of where the strings differ.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** Plausible token shape: base64url, 22..86 chars (128..512 bits). Cheap pre-check before hashing. */
export function looksLikeToken(token: unknown): token is string {
  return typeof token === "string" && /^[A-Za-z0-9_-]{22,86}$/.test(token);
}

export function fitRequestExpiresAt(createdAt: Date): Date {
  return new Date(createdAt.getTime() + FIT_REQUEST_TTL_MS);
}

export interface FitRequestTokens {
  giverToken: string;
  recipientToken: string;
  giverTokenHash: string;
  recipientTokenHash: string;
}

/** A fresh, independent token pair for a new Fit Request. */
export function newFitRequestTokens(): FitRequestTokens {
  const giverToken = newToken();
  let recipientToken = newToken();
  while (recipientToken === giverToken) recipientToken = newToken();
  return { giverToken, recipientToken, giverTokenHash: hashToken(giverToken), recipientTokenHash: hashToken(recipientToken) };
}

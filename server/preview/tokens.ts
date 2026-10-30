/**
 * Preview keys and owner tokens (owner: A10; ADR-055). The key (128-bit) is the unguessable preview URL;
 * the owner token (256-bit) opens Admin v0 and is shown once: only its SHA-256 is stored.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const newPreviewKey = (): string => randomBytes(16).toString("base64url");
export const newOwnerToken = (): string => randomBytes(32).toString("base64url");

export function hashOwnerToken(token: string): string {
  return createHash("sha256").update(`giftfit-preview-owner|${token}`, "utf8").digest("hex");
}

/** Constant-time check of a presented owner token against the stored hash (for A6's Admin v0). */
export function ownerTokenMatches(storedHash: string, presented: string | null | undefined): boolean {
  if (!presented || !/^[A-Za-z0-9_-]{43}$/.test(presented) || !/^[0-9a-f]{64}$/.test(storedHash)) return false;
  const a = Buffer.from(hashOwnerToken(presented), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

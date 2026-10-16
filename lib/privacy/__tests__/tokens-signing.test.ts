import { describe, expect, it } from "vitest";
import { FIT_REQUEST_TTL_HOURS } from "@/db/schema";
import {
  SIGNED_URL_MAX_TTL_SEC,
  getSigningSecret,
  signTryOnUrl,
  verifyTryOnSignature,
} from "../signed-url";
import { fitRequestExpiresAt, hashToken, looksLikeToken, newFitRequestTokens, newToken, safeEqual } from "../tokens";

const SECRET = "s".repeat(40);
const NOW = Date.parse("2026-10-20T12:00:00Z");

describe("Fit Request tokens", () => {
  it("are unguessable: 256 bits, base64url, unique, distinct per side", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const t = newToken();
      expect(Buffer.from(t, "base64url").length).toBe(32);
      expect(looksLikeToken(t)).toBe(true);
      seen.add(t);
    }
    expect(seen.size).toBe(2000);
    const pair = newFitRequestTokens();
    expect(pair.giverToken).not.toBe(pair.recipientToken);
    expect(pair.giverTokenHash).toBe(hashToken(pair.giverToken));
    expect(pair.recipientTokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(() => newToken(8)).toThrow(/128 bits/);
  });

  it("expire 72 h after creation (FIT_REQUEST_TTL_HOURS)", () => {
    expect(FIT_REQUEST_TTL_HOURS).toBe(72);
    const created = new Date(NOW);
    expect(fitRequestExpiresAt(created).getTime() - NOW).toBe(72 * 3600 * 1000);
  });

  it("compares in constant time and rejects bad shapes", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(looksLikeToken("short")).toBe(false);
    expect(looksLikeToken("x".repeat(30) + "!")).toBe(false);
    expect(looksLikeToken(undefined)).toBe(false);
  });
});

describe("signed try-on URLs", () => {
  const session = newToken();
  const sign = (over: Partial<Parameters<typeof signTryOnUrl>[0]> = {}) =>
    signTryOnUrl({ tryOnId: "tryon-1", sessionToken: session, secret: SECRET, nowMs: NOW, ...over });
  const verify = (exp: string | null, sig: string | null, over: Partial<Parameters<typeof verifyTryOnSignature>[0]> = {}) =>
    verifyTryOnSignature({ tryOnId: "tryon-1", sessionToken: session, exp, sig, secret: SECRET, nowMs: NOW, ...over });

  it("verifies within the TTL and lives at most 15 minutes", () => {
    const s = sign();
    expect(s.url).toBe(`/api/recipient/tryon/tryon-1?exp=${s.exp}&sig=${s.sig}`);
    expect(s.exp - NOW / 1000).toBe(600);
    expect(verify(String(s.exp), s.sig)).toEqual({ ok: true });
    expect(verify(String(s.exp), s.sig, { nowMs: NOW + 599_000 })).toEqual({ ok: true });
    expect(() => sign({ ttlSec: SIGNED_URL_MAX_TTL_SEC + 1 })).toThrow(/TTL/);
    expect(() => sign({ ttlSec: 0 })).toThrow(/TTL/);
    expect(SIGNED_URL_MAX_TTL_SEC).toBeLessThanOrEqual(900);
  });

  it("rejects expired URLs", () => {
    const s = sign({ ttlSec: 60 });
    expect(verify(String(s.exp), s.sig, { nowMs: NOW + 61_000 })).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects tampering with the signature, expiry, try-on id, session or secret", () => {
    const s = sign();
    const flipped = (s.sig[0] === "A" ? "B" : "A") + s.sig.slice(1);
    expect(verify(String(s.exp), flipped)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verify(String(s.exp + 600), s.sig)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verify(String(s.exp), s.sig, { tryOnId: "tryon-2" })).toEqual({ ok: false, reason: "bad_signature" });
    expect(verify(String(s.exp), s.sig, { sessionToken: newToken() })).toEqual({ ok: false, reason: "bad_signature" });
    expect(verify(String(s.exp), s.sig, { secret: "t".repeat(40) })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects malformed or far-future parameters", () => {
    const s = sign();
    expect(verify(null, s.sig).ok).toBe(false);
    expect(verify(String(s.exp), null).ok).toBe(false);
    expect(verify("12x", s.sig)).toEqual({ ok: false, reason: "malformed" });
    expect(verify(String(s.exp), s.sig + "A")).toEqual({ ok: false, reason: "malformed" });
    // A correctly signed URL minted with a long TTL (e.g. a leaked secret) is still refused.
    const far = signTryOnUrl({ tryOnId: "tryon-1", sessionToken: session, secret: SECRET, nowMs: NOW + 3600_000 });
    expect(verify(String(far.exp), far.sig)).toEqual({ ok: false, reason: "too_far_in_future" });
  });

  it("requires GIFTFIT_URL_SIGNING_SECRET in production", () => {
    expect(() => getSigningSecret({ NODE_ENV: "production" })).toThrow(/GIFTFIT_URL_SIGNING_SECRET/);
    expect(() => getSigningSecret({ GIFTFIT_URL_SIGNING_SECRET: "short" })).toThrow(/32/);
    expect(getSigningSecret({ GIFTFIT_URL_SIGNING_SECRET: SECRET })).toBe(SECRET);
    const dev = getSigningSecret({ NODE_ENV: "development" });
    expect(dev.length).toBeGreaterThanOrEqual(32);
    expect(getSigningSecret({ NODE_ENV: "test" })).toBe(dev);
  });
});

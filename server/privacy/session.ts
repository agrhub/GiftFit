/**
 * Recipient session resolution for app/api/recipient/* (owner: A5).
 *
 * The recipient token travels as `Authorization: Bearer <token>` (API calls) or the
 * HttpOnly cookie `gf_recipient` (needed for <img src> of signed try-on URLs). Only the
 * SHA-256 is looked up, and only against recipient_token_hash, so a giver token never
 * opens a recipient route. A request past its 72 h expiry is purged on first touch.
 */
import type { PrivacyDeps } from "./deps";
import { deleteEverything } from "./delete-everything";
import { CLOSED_STATUSES, type FitRequestRecord } from "./repos/types";
import { FIT_REQUEST_TTL_MS, hashToken, looksLikeToken } from "./tokens";

export const RECIPIENT_COOKIE = "gf_recipient";

export function readRecipientToken(req: Request): string | undefined {
  const auth = req.headers.get("authorization");
  if (auth) {
    const m = /^Bearer\s+(\S+)$/i.exec(auth.trim());
    if (m) return m[1];
  }
  const cookie = req.headers.get("cookie");
  if (cookie) {
    for (const part of cookie.split(";")) {
      const i = part.indexOf("=");
      if (i > 0 && part.slice(0, i).trim() === RECIPIENT_COOKIE) return decodeURIComponent(part.slice(i + 1).trim());
    }
  }
  return undefined;
}

export type RecipientSession =
  | { ok: true; token: string; request: FitRequestRecord }
  | { ok: false; status: 401 | 404 | 410; error: "missing_token" | "link_not_valid" | "link_expired" };

export async function resolveRecipientSession(req: Request, deps: PrivacyDeps): Promise<RecipientSession> {
  const token = readRecipientToken(req);
  if (!token) return { ok: false, status: 401, error: "missing_token" };
  if (!looksLikeToken(token)) return { ok: false, status: 404, error: "link_not_valid" };
  const request = await deps.repos.fitRequests.findByRecipientTokenHash(hashToken(token));
  if (!request) return { ok: false, status: 404, error: "link_not_valid" };
  if (CLOSED_STATUSES.includes(request.status)) return { ok: false, status: 410, error: "link_expired" };
  if (request.expiresAt.getTime() <= deps.now().getTime()) {
    await deleteEverything(deps, request.id, "expired");
    return { ok: false, status: 410, error: "link_expired" };
  }
  return { ok: true, token, request };
}

/** Standard JSON error for recipient routes; never cached. A 410 also carries `status: "expired"`. */
export function recipientError(status: number, error: string): Response {
  const body = status === 410 ? { error, status: "expired" } : { error };
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

/** JSON for recipient routes; never cached. */
export function recipientJson(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "private, no-store");
  return Response.json(body, { ...init, headers });
}

/** Cookie path: the session is only needed by recipient API calls and signed image fetches. */
export const RECIPIENT_COOKIE_PATH = "/api/recipient";

/** Set-Cookie value that opens a recipient session (HttpOnly, Secure, SameSite=Strict, path-scoped). */
export function recipientSessionCookie(token: string, opts: { secure?: boolean; maxAgeSec?: number } = {}): string {
  const maxAge = Math.floor(opts.maxAgeSec ?? FIT_REQUEST_TTL_MS / 1000);
  return [
    `${RECIPIENT_COOKIE}=${encodeURIComponent(token)}`,
    `Path=${RECIPIENT_COOKIE_PATH}`,
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
    ...(opts.secure === false ? [] : ["Secure"]),
  ].join("; ");
}

/** Set-Cookie value that clears the recipient session. */
export function clearRecipientSessionCookie(): string {
  return `${RECIPIENT_COOKIE}=; Path=${RECIPIENT_COOKIE_PATH}; HttpOnly; SameSite=Strict; Max-Age=0; Secure`;
}

/**
 * Admin v0 owner auth for store-URL previews (owner: A6, ADR-055). Server-only.
 *
 * POST /api/preview returns the owner link once: /admin/<key>?t=<ownerToken> (or #t=<token>). The token
 * is checked with A10's ownerTokenMatches (constant time, only its hash is stored) and then moved into
 *   gf_owner=<token>; Path=/admin/<key>; HttpOnly; SameSite=Strict; [Secure]; Max-Age=<until expiry>
 * and the URL is stripped (303 to /admin/<key>), so the token is never in a link, a Referer or a page.
 * Every /admin/<key> request (page and server actions) re-checks the cookie; bad or missing → 403.
 * Tokens are never logged.
 */
import { defaultPreviewRepo, PREVIEW_KEY_RE, type PreviewRecord, type PreviewRepo } from "@/server/preview/repo";
import { ownerTokenMatches } from "@/server/preview/tokens";

export const OWNER_COOKIE = "gf_owner";
export const OWNER_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export const adminPath = (key: string) => `/admin/${key}`;

/** /admin/<key>[/...] → key, else null. */
export function adminKeyOf(pathname: string): string | null {
  const m = /^\/admin\/([A-Za-z0-9_-]{22})(?:\/|$)/.exec(pathname);
  return m && PREVIEW_KEY_RE.test(m[1]) ? m[1] : null;
}

/** The preview record when `token` is its owner token (any state, unexpired); else null. */
export async function verifyOwner(key: string, token: string | null | undefined, repo: PreviewRepo = defaultPreviewRepo(), nowMs: number = Date.now()): Promise<PreviewRecord | null> {
  if (!PREVIEW_KEY_RE.test(key) || !token || !OWNER_TOKEN_RE.test(token)) return null;
  let rec: PreviewRecord | null;
  try {
    rec = await repo.get(key, nowMs);
  } catch {
    return null;
  }
  return rec && ownerTokenMatches(rec.ownerTokenHash, token) ? rec : null;
}

export function ownerCookie(key: string, token: string, expiresAt: Date, opts: { secure: boolean; nowMs?: number }): string {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - (opts.nowMs ?? Date.now())) / 1000));
  return [`${OWNER_COOKIE}=${token}`, `Path=${adminPath(key)}`, "HttpOnly", "SameSite=Strict", ...(opts.secure ? ["Secure"] : []), `Max-Age=${maxAge}`].join("; ");
}

/** A tiny self-contained 403 page; it also accepts the token from a #t= fragment (never sent to servers), on load or when the owner link is pasted into this same tab (hashchange). */
export function forbiddenHtml(key: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>Owner link needed · GiftFit</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:48px 16px;background:#fbf8f3;color:#1f1a17}main{max-width:520px;margin:auto}a{color:inherit}</style></head>
<body><main><h1>Owner link needed</h1><p data-testid="admin-forbidden">This preview's settings open only from the private owner link you got when you created the preview. Previews last 24 hours.</p><p><a href="/">GiftFit home</a></p></main>
<script>(function(){if(location.search)history.replaceState(null,"",location.pathname+location.hash);function use(){var m=/[#&]t=([A-Za-z0-9_-]{43})/.exec(location.hash);if(!m)return;history.replaceState(null,"",location.pathname);fetch(${JSON.stringify(`/api/preview/${key}/session`)},{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:m[1]}),credentials:"same-origin"}).then(function(r){if(r.ok)location.reload();});}use();addEventListener("hashchange",use);})();</script></body></html>`;
}



/**
 * POST /api/preview  { url } → 202 { key, previewPath, statusPath, ownerPath }   (owner: A10; ADR-055)
 *
 * Starts a store-URL preview: the URL is checked against the SSRF policy (https, default port, no
 * userinfo, public DNS only) before anything is queued, then crawled asynchronously through the hardened
 * fetcher. ownerPath carries the owner token once; only its hash is stored.
 * Errors: 400 invalid_url | blocked_url (resolved addresses are never echoed), 429 rate_limited | daily_cap
 * (Retry-After), 503 unavailable (counters or storage down: fail closed) | disabled (PREVIEW_ENABLED=off).
 */
import { giverJson } from "@/server/privacy/giver-guard";
import { giverRateLimit } from "@/server/privacy/rate-limit";
import { createPreview } from "@/server/preview/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 4096;

export async function POST(req: Request): Promise<Response> {
  const limited = await giverRateLimit(req, "preview");
  if (limited) return limited;
  let url: unknown;
  try {
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (declared > MAX_BODY_BYTES) throw new Error("too large");
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) throw new Error("too large");
    const body = JSON.parse(text) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
    url = (body as { url?: unknown }).url;
  } catch {
    return giverJson({ error: "invalid_url" }, { status: 400 });
  }
  const r = await createPreview(req, url);
  if (r.ok) return giverJson(r.body, { status: 202 });
  return giverJson({ error: r.error }, { status: r.status, ...(r.retryAfterSec ? { headers: { "Retry-After": String(r.retryAfterSec) } } : {}) });
}

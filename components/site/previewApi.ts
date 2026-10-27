/**
 * Client for the store-URL preview API (owner: A4, P8.4; server: A10). Browser-safe.
 *
 *   POST /api/preview { url }  → 202 { key, previewPath, statusPath, ownerPath }
 *                                400 { error: "invalid_url" | "blocked_url" }
 *                                429 { error: "rate_limited" | "daily_cap" }
 *                                503 { error: "unavailable" | "disabled" }   (shown as "paused")
 *   GET  <statusPath>          → 200 { state: queued|crawling|ready|refused|failed, productCount, reason? }
 *                                404 not_found (expired); 429/503 are transient and polled again
 *   reasons: not_a_store, robots_disallowed, site_blocked, blocked_url, unreachable, timeout,
 *            interrupted, internal
 *
 * `mockPreviewApi` stands in for the server in tests and on `/?previewmock=1` (no site is contacted):
 * hosts starting with "few" are refused, "limit" → 429 rate_limited, "cap" → 429 daily_cap,
 * "paused" → 503, "fail" → failed unreachable, "guarded" → failed site_blocked; anything else is
 * ready after a couple of polls.
 */

export type PreviewState = "queued" | "crawling" | "ready" | "refused" | "failed";

export interface PreviewCreated {
  key: string;
  previewPath: string;
  statusPath: string;
  ownerPath: string;
}

export interface PreviewStatus {
  state: PreviewState;
  productCount: number;
  reason?: string | null;
}

export type CreateError = "invalid_url" | "blocked_url" | "rate_limited" | "daily_cap" | "paused" | "network";

export type CreateResult = { ok: true; created: PreviewCreated } | { ok: false; error: CreateError };

export interface PreviewApi {
  create(url: string): Promise<CreateResult>;
  status(statusPath: string): Promise<PreviewStatus | null>;
}

const STATES: readonly PreviewState[] = ["queued", "crawling", "ready", "refused", "failed"];
const CREATE_ERRORS: readonly CreateError[] = ["invalid_url", "blocked_url", "rate_limited", "daily_cap"];
/** 503 bodies: storage/counters down (fail closed) or the PREVIEW_ENABLED kill switch. */
const PAUSED_ERRORS = ["unavailable", "disabled"];

/** A same-origin path only ("/s/…"), never a URL elsewhere. */
function safePath(v: unknown): string | null {
  return typeof v === "string" && v.startsWith("/") && !v.startsWith("//") && !v.includes("\\") ? v : null;
}

export function parseCreated(body: unknown): PreviewCreated | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const previewPath = safePath(b.previewPath);
  const statusPath = safePath(b.statusPath);
  const ownerPath = safePath(b.ownerPath);
  if (typeof b.key !== "string" || !previewPath || !statusPath || !ownerPath) return null;
  return { key: b.key, previewPath, statusPath, ownerPath };
}

export function parseStatus(body: unknown): PreviewStatus | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (!STATES.includes(b.state as PreviewState)) return null;
  const n = Number(b.productCount ?? 0);
  return { state: b.state as PreviewState, productCount: Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0, reason: typeof b.reason === "string" ? b.reason : null };
}

export const httpPreviewApi: PreviewApi = {
  async create(url) {
    let res: Response;
    try {
      res = await fetch("/api/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
    } catch {
      return { ok: false, error: "network" };
    }
    const body = await res.json().catch(() => null);
    if (res.ok) {
      const created = parseCreated(body);
      return created ? { ok: true, created } : { ok: false, error: "network" };
    }
    const code = (body as { error?: unknown } | null)?.error;
    if (CREATE_ERRORS.includes(code as CreateError)) return { ok: false, error: code as CreateError };
    if (res.status === 503 || PAUSED_ERRORS.includes(code as string)) return { ok: false, error: "paused" };
    if (res.status === 429) return { ok: false, error: "rate_limited" };
    if (res.status === 400) return { ok: false, error: "invalid_url" };
    return { ok: false, error: "network" };
  },
  async status(statusPath) {
    try {
      const res = await fetch(statusPath, { cache: "no-store" });
      if (res.status === 404) return { state: "failed", productCount: 0, reason: "not_found" };
      if (!res.ok) return null;
      return parseStatus(await res.json());
    } catch {
      return null;
    }
  },
};

/** In-memory stand-in for the API (see the header for the host rules). */
export function mockPreviewApi({ pollsUntilDone = 2 } = {}): PreviewApi {
  const jobs = new Map<string, { host: string; polls: number }>();
  let n = 0;
  return {
    async create(url) {
      const host = new URL(url).hostname;
      if (host.startsWith("limit")) return { ok: false, error: "rate_limited" };
      if (host.startsWith("cap")) return { ok: false, error: "daily_cap" };
      if (host.startsWith("blocked")) return { ok: false, error: "blocked_url" };
      if (host.startsWith("paused")) return { ok: false, error: "paused" };
      const key = `mock${(++n).toString(36)}${Math.random().toString(36).slice(2, 10)}`;
      jobs.set(key, { host, polls: 0 });
      return { ok: true, created: { key, previewPath: `/s/${key}`, statusPath: `/api/preview/${key}/status`, ownerPath: `/s/${key}/admin#t=mock-owner-token` } };
    },
    async status(statusPath) {
      const key = statusPath.split("/")[3] ?? "";
      const job = jobs.get(key);
      if (!job) return { state: "failed", productCount: 0, reason: "not_found" };
      job.polls += 1;
      if (job.polls <= pollsUntilDone) return { state: job.polls === 1 ? "queued" : "crawling", productCount: job.polls === 1 ? 0 : 7 };
      if (job.host.startsWith("few")) return { state: "refused", productCount: 2, reason: "not_a_store" };
      if (job.host.startsWith("fail")) return { state: "failed", productCount: 0, reason: "unreachable" };
      if (job.host.startsWith("guarded")) return { state: "failed", productCount: 0, reason: "site_blocked" };
      return { state: "ready", productCount: 12 };
    },
  };
}

export type UrlCheck = { ok: true; url: string } | { ok: false; error: "https" | "invalid" };

/**
 * Light client-side check before calling the API (the server does the real SSRF checks): https only,
 * a dotted public-looking host name, no credentials, no custom port. A bare "shop.com" gets https://.
 */
export function checkStoreUrl(raw: string): UrlCheck {
  const s = raw.trim();
  if (!s) return { ok: false, error: "https" };
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return { ok: false, error: "invalid" };
  }
  if (u.protocol !== "https:") return { ok: false, error: "https" };
  const host = u.hostname.toLowerCase();
  if (u.username || u.password || u.port) return { ok: false, error: "invalid" };
  if (!host.includes(".") || host.endsWith(".") || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return { ok: false, error: "invalid" };
  if (/^[\d.]+$/.test(host) || host.startsWith("[")) return { ok: false, error: "invalid" };
  return { ok: true, url: u.href };
}

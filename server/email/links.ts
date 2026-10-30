/**
 * Absolute links for emails (owner: A12). Every link in an email is built from `appBaseUrl()`:
 *
 *   1. APP_BASE_URL (http/https origin; a path or trailing slash is dropped)
 *   2. the request origin (`new URL(req.url).origin`)
 *   3. http://localhost:3000
 *
 * Set APP_BASE_URL in production: the request origin comes from the Host header, which a caller
 * controls, and a poisoned origin in an email is a phishing link with our name on it.
 */
import type { Env } from "./config";

export const DEFAULT_BASE_URL = "http://localhost:3000";
export const RECIPIENT_PATH = "/r";
export const GIVER_REPORT_PATH = "/g";

function originOf(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const u = new URL(value.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
    if (u.username || u.password) return undefined;
    return u.origin;
  } catch {
    return undefined;
  }
}

/** The origin used for links in emails. `req` may be a Request or anything with a `url`. */
export function appBaseUrl(req?: { url: string } | null, env: Env = process.env): string {
  return originOf(env.APP_BASE_URL) ?? originOf(req?.url) ?? DEFAULT_BASE_URL;
}

/** URL-safe path segment for a token (tokens are base64url, but never trust that here). */
function seg(token: string): string {
  if (typeof token !== "string" || !token) throw new Error("token required");
  return encodeURIComponent(token);
}

/** The recipient's gift link: {base}/r/{recipientToken}. */
export function recipientUrl(recipientToken: string, base: string = appBaseUrl()): string {
  return `${originOf(base) ?? DEFAULT_BASE_URL}${RECIPIENT_PATH}/${seg(recipientToken)}`;
}

/** The giver's Fit Report: {base}/g/{giverToken}. */
export function giverReportUrl(giverToken: string, base: string = appBaseUrl()): string {
  return `${originOf(base) ?? DEFAULT_BASE_URL}${GIVER_REPORT_PATH}/${seg(giverToken)}`;
}

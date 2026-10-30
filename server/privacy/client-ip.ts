/**
 * Trusted client IP for rate limiting (owner: A5; A8 requirement, ADR-039 deploy on Cloud Run).
 *
 * `X-Forwarded-For` is "client-supplied, …, proxy-appended". Google's front end APPENDS the real
 * client address, so the trustworthy entry is the one at index `len − GIFTFIT_TRUSTED_PROXY_HOPS`
 * (1 for direct *.run.app, 2 behind an external Application Load Balancer). The left-most entry is
 * whatever the client sent and is NEVER used. With fewer entries than hops (or no header) every such
 * request shares one conservative "unknown" bucket rather than trusting anything the client sent.
 *
 * Only a salted hash of the IP is ever kept (HMAC-SHA256 with GIFTFIT_IP_HASH_SALT, else the URL
 * signing secret). Raw IPs are never stored or logged.
 */
import { createHmac } from "node:crypto";
import { getSigningSecret } from "./signed-url";

export const UNKNOWN_CLIENT = "unknown";

export function trustedProxyHops(env: Record<string, string | undefined> = process.env): number {
  const n = Number.parseInt(env.GIFTFIT_TRUSTED_PROXY_HOPS ?? "", 10);
  return Number.isInteger(n) && n >= 1 && n <= 10 ? n : 1;
}

/** The client address as seen by the last trusted proxy; `"unknown"` when it cannot be established. */
export function clientIp(req: Request, env: Record<string, string | undefined> = process.env): string {
  const xff = req.headers.get("x-forwarded-for");
  if (!xff) return UNKNOWN_CLIENT;
  const hops = trustedProxyHops(env);
  const entries = xff
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (entries.length < hops) return UNKNOWN_CLIENT;
  const ip = entries[entries.length - hops];
  return /^[0-9A-Fa-f:.[\]%a-zA-Z-]{2,64}$/.test(ip) ? ip : UNKNOWN_CLIENT;
}

function salt(env: Record<string, string | undefined>): string {
  const s = env.GIFTFIT_IP_HASH_SALT?.trim();
  return s && s.length >= 16 ? s : getSigningSecret(env);
}

/** Salted, scope-bound hash of the client IP (what the limiters key on). */
export function clientKey(req: Request, scope: string, env: Record<string, string | undefined> = process.env): string {
  return createHmac("sha256", salt(env)).update(`ip|${scope}|${clientIp(req, env)}`, "utf8").digest("base64url").slice(0, 22);
}

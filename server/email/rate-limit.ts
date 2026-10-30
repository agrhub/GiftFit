/**
 * Email send rate limits (owner: A12).
 *
 *   per giver   5 / hour, 20 / 24 h
 *   per IP     10 / hour
 *
 * Behind the `EmailRateLimiter` interface so R0 can swap the in-memory implementation for the
 * Firestore-backed counters (A11) with `setEmailRateLimiter()`. A send is counted only if EVERY
 * bucket has room (all-or-nothing), so a refused send never burns quota in another bucket.
 *
 * Keys must already be pseudonymous: pass the giver token HASH (never the token) and a salted IP
 * hash (server/privacy `clientKey(req, "email")`). This module never sees a raw IP or address.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export type EmailRateScope = "email_giver" | "email_ip";

export interface RateRule {
  limit: number;
  windowMs: number;
}

export const EMAIL_RATE_LIMITS: Record<EmailRateScope, readonly RateRule[]> = {
  email_giver: [
    { limit: 5, windowMs: HOUR },
    { limit: 20, windowMs: DAY },
  ],
  email_ip: [{ limit: 10, windowMs: HOUR }],
};

export interface EmailRateKeys {
  /** Pseudonymous giver key (e.g. SHA-256 of the giver token). */
  giverKey: string;
  /** Salted IP hash. */
  ipKey: string;
}

export type EmailRateDecision = { ok: true } | { ok: false; scope: EmailRateScope; retryAfterSec: number };

export interface EmailRateLimiter {
  /** Records one send for both keys when every bucket has room; otherwise records nothing. */
  take(keys: EmailRateKeys, nowMs?: number): Promise<EmailRateDecision>;
}

/** 429-style error for routes: `status`, `retryAfterSec`, and `toResponse()`. */
export class EmailRateLimitError extends Error {
  readonly status = 429;
  readonly code = "email_rate_limited";
  constructor(
    readonly scope: EmailRateScope,
    readonly retryAfterSec: number,
  ) {
    super(`email rate limit reached (${scope}); retry after ${retryAfterSec}s`);
    this.name = "EmailRateLimitError";
  }

  toResponse(): Response {
    return Response.json(
      { error: "rate_limited", scope: this.scope },
      { status: 429, headers: { "Retry-After": String(this.retryAfterSec), "Cache-Control": "private, no-store" } },
    );
  }
}

/** Retry-after (ms) for a bucket given its hits, or 0 when there is room. */
function blockedForMs(hits: number[], rules: readonly RateRule[], nowMs: number): number {
  let ms = 0;
  for (const r of rules) {
    const inWindow = hits.filter((t) => t > nowMs - r.windowMs);
    if (inWindow.length >= r.limit) ms = Math.max(ms, inWindow[inWindow.length - r.limit] + r.windowMs - nowMs);
  }
  return ms;
}

/** Sliding-window limiter in process memory. Exact with one instance (Cloud Run --max-instances 1). */
export class MemoryEmailRateLimiter implements EmailRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limits: Record<EmailRateScope, readonly RateRule[]> = EMAIL_RATE_LIMITS,
    private readonly maxKeys = 50_000,
  ) {}

  async take(keys: EmailRateKeys, nowMs: number = Date.now()): Promise<EmailRateDecision> {
    if (!keys.giverKey || !keys.ipKey) throw new Error("giverKey and ipKey are required");
    const buckets: [EmailRateScope, string][] = [
      ["email_giver", keys.giverKey],
      ["email_ip", keys.ipKey],
    ];
    const current = buckets.map(([scope, key]) => {
      const id = `${scope}|${key}`;
      const longest = Math.max(...this.limits[scope].map((r) => r.windowMs));
      const hits = (this.hits.get(id) ?? []).filter((t) => t > nowMs - longest);
      return { scope, id, hits };
    });
    for (const b of current) {
      const ms = blockedForMs(b.hits, this.limits[b.scope], nowMs);
      if (ms > 0) return { ok: false, scope: b.scope, retryAfterSec: Math.max(1, Math.ceil(ms / 1000)) };
    }
    for (const b of current) {
      b.hits.push(nowMs);
      this.hits.set(b.id, b.hits);
    }
    if (this.hits.size > this.maxKeys) {
      for (const [k, v] of this.hits) if (!v.some((t) => t > nowMs - DAY)) this.hits.delete(k);
    }
    return { ok: true };
  }

  /** Tests: forget every bucket. */
  reset(): void {
    this.hits.clear();
  }
}

// One limiter per process, shared across Next route bundles (see server/privacy/global-state.ts).
const KEY = Symbol.for("giftfit.email.rateLimiter.v1");
type G = typeof globalThis & { [KEY]?: EmailRateLimiter };

export function getEmailRateLimiter(): EmailRateLimiter {
  const g = globalThis as G;
  return (g[KEY] ??= new MemoryEmailRateLimiter());
}

/** Swap the implementation (Firestore counters) or pass undefined to go back to a fresh in-memory one. */
export function setEmailRateLimiter(limiter: EmailRateLimiter | undefined): void {
  const g = globalThis as G;
  if (limiter) g[KEY] = limiter;
  else delete g[KEY];
}

/** Takes one send or throws EmailRateLimitError. */
export async function assertEmailRate(keys: EmailRateKeys, nowMs?: number, limiter: EmailRateLimiter = getEmailRateLimiter()): Promise<void> {
  const d = await limiter.take(keys, nowMs);
  if (!d.ok) throw new EmailRateLimitError(d.scope, d.retryAfterSec);
}

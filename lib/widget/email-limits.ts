/**
 * Durable e-mail send limits for the widget (owner: A6). lib/email's limiter is in-memory and resets
 * on every Cloud Run cold start; with STORE=firestore the same EMAIL_RATE_LIMITS (per giver 5/h and
 * 20/24 h, per IP 10/h) are kept in Firestore `rate_limits` instead, as fixed windows in ONE
 * transaction across both keys (all-or-nothing, like MemoryEmailRateLimiter). Keys are already
 * pseudonymous (token hash, salted IP hash). If Firestore fails, the in-memory limiter answers
 * (never unlimited).
 */
import { EMAIL_RATE_LIMITS, getEmailRateLimiter, type EmailRateDecision, type EmailRateKeys, type EmailRateLimiter, type EmailRateScope } from "@/lib/email/rate-limit";
import { isFirestoreStore } from "@/lib/store/config";
import { COLLECTIONS, type FsDb } from "@/lib/store/firestore-types";
import { getFirestoreDb } from "@/lib/store/gcp-clients";

const SAFE = /^[A-Za-z0-9_-]{1,96}$/;

export class FirestoreEmailRateLimiter implements EmailRateLimiter {
  constructor(
    private readonly db: () => Promise<FsDb>,
    private readonly limits: Record<EmailRateScope, ReadonlyArray<{ limit: number; windowMs: number }>> = EMAIL_RATE_LIMITS,
  ) {}

  async take(keys: EmailRateKeys, nowMs: number = Date.now()): Promise<EmailRateDecision> {
    if (!SAFE.test(keys.giverKey) || !SAFE.test(keys.ipKey)) throw new Error("invalid email rate key");
    const db = await this.db();
    const col = db.collection(COLLECTIONS.rateLimits);
    const slots = (
      [
        ["email_giver", keys.giverKey],
        ["email_ip", keys.ipKey],
      ] as const
    ).flatMap(([scope, key]) =>
      this.limits[scope].map((rule) => {
        const bucket = Math.floor(nowMs / rule.windowMs);
        const windowEnd = (bucket + 1) * rule.windowMs;
        return { scope, rule, windowEnd, ref: col.doc(`${scope}_${key}_${Math.round(rule.windowMs / 1000)}s_${bucket}`) };
      }),
    );
    return db.runTransaction(async (tx) => {
      const snaps = await Promise.all(slots.map((s) => tx.get(s.ref)));
      const counts = snaps.map((s) => (s.exists ? Number(s.data()?.count ?? 0) : 0));
      let blocked: { scope: EmailRateScope; ms: number } | undefined;
      slots.forEach((s, i) => {
        if (counts[i] >= s.rule.limit) {
          const ms = s.windowEnd - nowMs;
          if (!blocked || ms > blocked.ms) blocked = { scope: s.scope, ms };
        }
      });
      if (blocked) return { ok: false, scope: blocked.scope, retryAfterSec: Math.max(1, Math.ceil(blocked.ms / 1000)) } as const;
      slots.forEach((s, i) => tx.set(s.ref, { scope: s.scope, count: counts[i] + 1, windowEnd: new Date(s.windowEnd), expiresAt: new Date(s.windowEnd) }));
      return { ok: true } as const;
    });
  }
}

/** Falls back to the in-memory limiter when the durable one throws. */
class WithFallback implements EmailRateLimiter {
  constructor(
    private readonly primary: EmailRateLimiter,
    private readonly fallback: () => EmailRateLimiter,
  ) {}
  async take(keys: EmailRateKeys, nowMs?: number): Promise<EmailRateDecision> {
    try {
      return await this.primary.take(keys, nowMs);
    } catch (err) {
      console.error("[widget] durable email limit unavailable, using the in-memory limiter:", (err as Error).message);
      return this.fallback().take(keys, nowMs);
    }
  }
}

const KEY = Symbol.for("giftfit.widget.emailLimiter.v1");
type G = typeof globalThis & { [KEY]?: EmailRateLimiter };

/** Firestore-backed with STORE=firestore, else lib/email's process-wide limiter. */
export function widgetEmailLimiter(): EmailRateLimiter {
  if (!isFirestoreStore()) return getEmailRateLimiter();
  const g = globalThis as G;
  return (g[KEY] ??= new WithFallback(new FirestoreEmailRateLimiter(() => getFirestoreDb()), getEmailRateLimiter));
}

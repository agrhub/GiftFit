/**
 * Durable per-IP rate limits on Firestore (owner: A11; limits and 429 behaviour from rate-limit.ts).
 *
 * Fixed windows: for each rule of a scope, one counter document per (scope, salted IP key, window,
 * bucket), with bucket = floor(now / windowMs) and expiresAt = the window's end (TTL backstop):
 *   rate_limits/{scope}_{key}_{windowSec}s_{bucket} = { scope, count, windowEnd, expiresAt }
 * One transaction reads every rule's document and either increments all of them or none, so a refused
 * request is not counted (as in the in-memory sliding windows). Only salted HMAC keys are stored.
 * Fixed windows can admit up to 2x a limit across a window boundary; that is accepted here.
 */
import { COLLECTIONS, type FsDb } from "@/lib/store/firestore-types";

export interface RateRule {
  limit: number;
  windowMs: number;
}

export interface RateDecisionLike {
  ok: boolean;
  retryAfterSec: number;
}

const SAFE = /^[A-Za-z0-9_-]{1,64}$/;

export class FirestoreRateLimitStore {
  readonly kind = "firestore";
  constructor(private readonly db: () => Promise<FsDb>) {}

  async take(scope: string, key: string, nowMs: number, rules: readonly RateRule[]): Promise<RateDecisionLike> {
    if (!SAFE.test(scope) || !SAFE.test(key)) throw new Error("invalid rate key");
    const db = await this.db();
    const col = db.collection(COLLECTIONS.rateLimits);
    const slots = rules.map((r) => {
      const bucket = Math.floor(nowMs / r.windowMs);
      const windowEnd = (bucket + 1) * r.windowMs;
      return { rule: r, windowEnd, ref: col.doc(`${scope}_${key}_${Math.round(r.windowMs / 1000)}s_${bucket}`) };
    });
    return db.runTransaction(async (tx) => {
      const snaps = await Promise.all(slots.map((s) => tx.get(s.ref)));
      const counts = snaps.map((s) => (s.exists ? Number(s.data()?.count ?? 0) : 0));
      let retryAfterMs = 0;
      slots.forEach((s, i) => {
        if (counts[i] >= s.rule.limit) retryAfterMs = Math.max(retryAfterMs, s.windowEnd - nowMs);
      });
      if (retryAfterMs > 0) return { ok: false, retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
      slots.forEach((s, i) => {
        tx.set(s.ref, { scope, count: counts[i] + 1, windowEnd: new Date(s.windowEnd), expiresAt: new Date(s.windowEnd) });
      });
      return { ok: true, retryAfterSec: 0 };
    });
  }
}

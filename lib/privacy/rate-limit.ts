/**
 * Per-IP limits (owner: A5; A8 "Requirement for A5"; durable store: A11). With STORE=firestore the
 * windows live in Firestore `rate_limits` (rate-limit-firestore.ts: fixed windows in a transaction), so
 * they survive Cloud Run cold starts; if Firestore is unreachable the in-memory limiter answers instead
 * (never unlimited). Otherwise sliding windows in memory on globalThis (exact with `--max-instances 1`,
 * reset on restart). Keys are salted IP hashes (client-ip.ts).
 *
 *   demo_seed     10 / hour
 *   fit_requests  10 / hour          (creating a request is free but unlocks a paid capture)
 *   capture        2 / hour, 4 / 24 h (only when the call can reach YouCam)
 *   swatch         8 / hour          (only when the call can reach YouCam; the 4-per-request cap stays)
 *
 * Over a limit: 429 {"error":"rate_limited"} with Retry-After, before any YouCam call.
 * Enabled everywhere except under NODE_ENV=test (unit tests force it on with setRateLimitOverride),
 * or when GIFTFIT_RATE_LIMITS=off outside production (local dev convenience; ignored in production).
 */
import { isFirestoreStore } from "@/lib/store/config";
import { getFirestoreDb } from "@/lib/store/gcp-clients";
import { clientKey } from "./client-ip";
import { privacyState } from "./global-state";
import { giverJson } from "./giver-guard";
import { FirestoreRateLimitStore } from "./rate-limit-firestore";

export type RateScope = "demo_seed" | "fit_requests" | "capture" | "swatch";

const HOUR = 60 * 60 * 1000;
export const RATE_LIMITS: Record<RateScope, ReadonlyArray<{ limit: number; windowMs: number }>> = {
  demo_seed: [{ limit: 10, windowMs: HOUR }],
  fit_requests: [{ limit: 10, windowMs: HOUR }],
  capture: [
    { limit: 2, windowMs: HOUR },
    { limit: 4, windowMs: 24 * HOUR },
  ],
  swatch: [{ limit: 8, windowMs: HOUR }],
};

/** Bound on remembered keys; beyond it, keys with no hit inside their longest window are dropped. */
const MAX_KEYS = 50_000;

type RateState = { rateHits?: Map<string, number[]>; rateOverride?: boolean; rateStore?: FirestoreRateLimitStore | null };
const state = () => privacyState() as ReturnType<typeof privacyState> & RateState;

/** Tests: force limits on (true) or off (false); undefined restores the environment default. */
export function setRateLimitOverride(on: boolean | undefined): void {
  state().rateOverride = on;
}

export function rateLimitsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const o = state().rateOverride;
  if (o !== undefined) return o;
  if (env.NODE_ENV === "production") return true;
  if (env.NODE_ENV === "test") return false;
  return env.GIFTFIT_RATE_LIMITS !== "off";
}

export interface RateDecision {
  ok: boolean;
  retryAfterSec: number;
}

/**
 * Records one hit for `key` in `scope` if every window has room; otherwise records nothing and says
 * when the oldest blocking hit leaves its window.
 */
export function takeRate(scope: RateScope, key: string, nowMs: number): RateDecision {
  const rules = RATE_LIMITS[scope];
  const longest = Math.max(...rules.map((r) => r.windowMs));
  const s = state();
  s.rateHits ??= new Map();
  const id = `${scope}|${key}`;
  const hits = (s.rateHits.get(id) ?? []).filter((t) => t > nowMs - longest);
  let retryAfterMs = 0;
  for (const r of rules) {
    const inWindow = hits.filter((t) => t > nowMs - r.windowMs);
    if (inWindow.length >= r.limit) retryAfterMs = Math.max(retryAfterMs, inWindow[inWindow.length - r.limit] + r.windowMs - nowMs);
  }
  if (retryAfterMs > 0) {
    s.rateHits.set(id, hits);
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
  }
  hits.push(nowMs);
  s.rateHits.set(id, hits);
  if (s.rateHits.size > MAX_KEYS) {
    for (const [k, v] of s.rateHits) if (!v.some((t) => t > nowMs - 24 * HOUR)) s.rateHits.delete(k);
  }
  return { ok: true, retryAfterSec: 0 };
}

/** The durable limiter (STORE=firestore), else undefined. Tests may inject one with setRateLimitStore. */
function durableStore(): FirestoreRateLimitStore | undefined {
  const s = state();
  if (s.rateStore === undefined) s.rateStore = isFirestoreStore() ? new FirestoreRateLimitStore(() => getFirestoreDb()) : null;
  return s.rateStore ?? undefined;
}

/** Tests: use this durable store (null = in-memory only; undefined = environment default). */
export function setRateLimitStore(store: FirestoreRateLimitStore | null | undefined): void {
  state().rateStore = store;
}

/**
 * Rate decision for a request (salted IP hash); always ok when limits are disabled. The in-memory path
 * records the hit synchronously (before the returned promise settles).
 */
export async function takeRateFor(req: Request, scope: RateScope, nowMs: number): Promise<RateDecision> {
  if (!rateLimitsEnabled()) return { ok: true, retryAfterSec: 0 };
  const key = clientKey(req, scope);
  const store = durableStore();
  if (!store) return takeRate(scope, key, nowMs);
  try {
    return await store.take(scope, key, nowMs, RATE_LIMITS[scope]);
  } catch (err) {
    console.error("[privacy] durable rate limit unavailable, using the in-memory limiter:", (err as Error).message);
    return takeRate(scope, key, nowMs);
  }
}

export const RATE_LIMITED_BODY = { error: "rate_limited" } as const;

export function rateLimitedResponse(retryAfterSec: number): Response {
  return Response.json(RATE_LIMITED_BODY, { status: 429, headers: { "Retry-After": String(retryAfterSec), "Cache-Control": "private, no-store" } });
}

/** One-line hook for giver routes: a 429 (through giverJson) when over the limit, else undefined. */
export async function giverRateLimit(req: Request, scope: RateScope, nowMs = Date.now()): Promise<Response | undefined> {
  const d = await takeRateFor(req, scope, nowMs);
  return d.ok ? undefined : giverJson(RATE_LIMITED_BODY, { status: 429, headers: { "Retry-After": String(d.retryAfterSec) } });
}

/** Test helper: every stored rate key (salted hashes only). */
export function rateKeysForTests(): string[] {
  return [...(state().rateHits?.keys() ?? [])];
}

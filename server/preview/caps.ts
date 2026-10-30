/**
 * Preview abuse caps (owner: A10; ADR-055), on durable daily counters (server/store/daily-counter.ts):
 *   previewip-<salted ip hash>-<YYYY-MM-DD>   ≤ PREVIEW_IP_DAILY_CAP  (default 5) per IP per UTC day
 *   preview-<YYYY-MM-DD>                      ≤ PREVIEW_DAILY_CAP     (default 100) per UTC day, global
 * STORE=firestore → Firestore `daily_counters` (atomic transactions, survive cold starts); otherwise a
 * process-wide memory store. Fail closed: if the counter store errors, no preview is started.
 * Only the salted HMAC of the IP is kept (server/privacy/client-ip.ts), never the IP.
 */
import { clientKey } from "@/server/privacy/client-ip";
import { dailyCounterKey, defaultDailyCounterStore, MemoryDailyCounterStore, type DailyCounterStore } from "@/server/store/daily-counter";
import type { Env } from "@/server/store/config";

export const DEFAULT_PREVIEW_IP_DAILY_CAP = 5;
export const DEFAULT_PREVIEW_DAILY_CAP = 100;

function intEnv(v: string | undefined, def: number, max: number): number {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isInteger(n) && n >= 1 && n <= max ? n : def;
}

export function previewCaps(env: Env = process.env): { perIp: number; global: number } {
  return { perIp: intEnv(env.PREVIEW_IP_DAILY_CAP, DEFAULT_PREVIEW_IP_DAILY_CAP, 100), global: intEnv(env.PREVIEW_DAILY_CAP, DEFAULT_PREVIEW_DAILY_CAP, 1000) };
}

/** Counter key for this client's previews today (lower-case hex of the salted, scope-bound IP hash). */
export function ipCounterKey(req: Request, nowMs: number, env: Env = process.env): string {
  const hex = Buffer.from(clientKey(req, "preview_day", env), "base64url").toString("hex").slice(0, 32);
  return dailyCounterKey(`previewip-${hex}`, nowMs);
}

const MEM_KEY = Symbol.for("giftfit.preview.counters.v1");

export function defaultPreviewCounters(env: Env = process.env): DailyCounterStore {
  const durable = defaultDailyCounterStore(env);
  if (durable) return durable;
  const g = globalThis as typeof globalThis & { [MEM_KEY]?: DailyCounterStore };
  return (g[MEM_KEY] ??= new MemoryDailyCounterStore());
}

/** Seconds until the next UTC midnight (Retry-After for the daily caps). */
export function secondsUntilUtcMidnight(nowMs: number): number {
  const d = new Date(nowMs);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - nowMs) / 1000));
}

export type CapDecision = { ok: true; refund: () => Promise<void> } | { ok: false; error: "rate_limited" | "daily_cap" | "unavailable"; retryAfterSec?: number };

/** Reserves one preview for this client today (per-IP first, then global). */
export async function reservePreview(req: Request, counters: DailyCounterStore, nowMs: number, env: Env = process.env): Promise<CapDecision> {
  const caps = previewCaps(env);
  let ipKey: string;
  let globalKey: string;
  try {
    ipKey = ipCounterKey(req, nowMs, env);
    globalKey = dailyCounterKey("preview", nowMs);
  } catch {
    return { ok: false, error: "unavailable" };
  }
  try {
    const ip = await counters.tryReserve(ipKey, 1, caps.perIp);
    if (!ip.ok) return { ok: false, error: "rate_limited", retryAfterSec: secondsUntilUtcMidnight(nowMs) };
    let global;
    try {
      global = await counters.tryReserve(globalKey, 1, caps.global);
    } catch (err) {
      await counters.refund(ipKey, 1).catch(() => undefined);
      throw err;
    }
    if (!global.ok) {
      await counters.refund(ipKey, 1).catch(() => undefined);
      return { ok: false, error: "daily_cap", retryAfterSec: secondsUntilUtcMidnight(nowMs) };
    }
    return {
      ok: true,
      refund: async () => {
        await Promise.all([counters.refund(ipKey, 1), counters.refund(globalKey, 1)]).catch(() => undefined);
      },
    };
  } catch (err) {
    console.error("[preview] daily counters unavailable, refusing (fail closed):", (err as Error).message);
    return { ok: false, error: "unavailable" };
  }
}

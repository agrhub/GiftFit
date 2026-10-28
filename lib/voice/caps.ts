/**
 * Voice caps on the durable daily counters (owner: A13; same pattern as lib/anthropic/budget.ts):
 * reserve BEFORE the paid call, settle or refund after it. Fails closed: when the counter cannot be
 * read or written, no call is made (503 voice_unavailable).
 *
 *   voice-stt-<YYYY-MM-DD>    billed Speech-to-Text audio seconds per UTC day (default cap 3600)
 *   voice-tts-<YYYY-MM-DD>    Google TTS characters per UTC day (default cap 150000)
 *   voice-stt-s-<sessionkey>  voice inputs per widget session (default 12)
 *   voice-tts-s-<sessionkey>  spoken replies per widget session (default 12)
 *   voice-supertonic-<YYYY-MM-DD>  sentences synthesised by the server Supertonic engine (default 400;
 *                                  CPU protection, ADR-057). When refused or unreachable → Google.
 *
 * Firestore with STORE=firestore (survives cold starts), process memory otherwise.
 */
import { isFirestoreStore, type Env } from "@/lib/store/config";
import { dailyCounterKey, defaultDailyCounterStore, MemoryDailyCounterStore, type DailyCounterStore } from "@/lib/store/daily-counter";
import { sessionMax, sttDailySeconds, supertonicDailySyntheses, ttsDailyChars } from "./config";

export type VoiceKind = "stt" | "tts";
/** Daily counters: STT seconds, Google TTS characters, server Supertonic sentences. */
export type DailyKind = VoiceKind | "supertonic";

const MEMORY_KEY = Symbol.for("giftfit.voice.counters.memory.v1");

export function voiceCounterStore(env: Env = process.env): DailyCounterStore {
  if (isFirestoreStore(env)) return defaultDailyCounterStore(env)!;
  const g = globalThis as typeof globalThis & { [MEMORY_KEY]?: DailyCounterStore };
  return (g[MEMORY_KEY] ??= new MemoryDailyCounterStore());
}

export const dailyKey = (kind: DailyKind, nowMs?: number) => dailyCounterKey(`voice-${kind}`, nowMs);
export const sessionCounterKey = (kind: VoiceKind, sessionKey: string) => `voice-${kind}-s-${sessionKey}`;

function dailyCap(kind: DailyKind, env: Env): number {
  return kind === "stt" ? sttDailySeconds(env) : kind === "tts" ? ttsDailyChars(env) : supertonicDailySyntheses(env);
}

type CapOpts = { env?: Env; store?: DailyCounterStore; now?: number; log?: (msg: string) => void };
type Refused<R extends string> = { ok: false; reason: R };

export interface SessionSlot {
  ok: true;
  /** The request was not served: give the slot back. */
  release(): Promise<void>;
}

/** Takes one per-session slot (fails closed when the counter is unreachable). */
export async function reserveSessionSlot(kind: VoiceKind, sessionKey: string, opts: CapOpts = {}): Promise<SessionSlot | Refused<"session_cap" | "counter_unavailable">> {
  const env = opts.env ?? process.env;
  const store = opts.store ?? voiceCounterStore(env);
  const log = opts.log ?? ((m: string) => console.error(m));
  const key = sessionCounterKey(kind, sessionKey);
  const cap = sessionMax(kind, env);
  if (!(cap > 0)) return { ok: false, reason: "session_cap" };
  try {
    if (!(await store.tryReserve(key, 1, cap)).ok) return { ok: false, reason: "session_cap" };
  } catch {
    return { ok: false, reason: "counter_unavailable" };
  }
  let done = false;
  return {
    ok: true,
    async release() {
      if (done) return;
      done = true;
      try {
        await store.refund(key, 1);
      } catch {
        log("[voice] session slot refund failed");
      }
    },
  };
}

export interface DailyReservation {
  ok: true;
  /** Settle to the real amount (adds when it exceeded the reservation). */
  settle(actual: number): Promise<void>;
  /** Nothing was spent: give the whole reservation back. */
  refund(): Promise<void>;
}

/** Reserves `amount` units of the day's cap for `kind` (fails closed). */
export async function reserveDaily(kind: DailyKind, amount: number, opts: CapOpts = {}): Promise<DailyReservation | Refused<"daily_cap" | "counter_unavailable">> {
  const env = opts.env ?? process.env;
  const store = opts.store ?? voiceCounterStore(env);
  const log = opts.log ?? ((m: string) => console.error(m));
  const key = dailyKey(kind, opts.now);
  const cap = dailyCap(kind, env);
  if (!(cap > 0)) return { ok: false, reason: "daily_cap" };
  const reserved = Math.max(0, Math.ceil(amount));
  try {
    if (!(await store.tryReserve(key, reserved, cap)).ok) return { ok: false, reason: "daily_cap" };
  } catch {
    return { ok: false, reason: "counter_unavailable" };
  }
  let done = false;
  return {
    ok: true,
    async settle(actual) {
      if (done) return;
      done = true;
      const real = Math.max(0, Math.ceil(actual));
      try {
        if (real < reserved) await store.refund(key, reserved - real);
        else if (real > reserved) await store.tryReserve(key, real - reserved, 0); // already spent: record it uncapped
      } catch {
        log(`[voice] ${kind} daily counter settle failed`);
      }
    },
    async refund() {
      if (done) return;
      done = true;
      try {
        await store.refund(key, reserved);
      } catch {
        log(`[voice] ${kind} daily counter refund failed`);
      }
    },
  };
}

export interface VoiceReservation {
  ok: true;
  /** Settle the daily counter to the real amount (adds when it exceeded the reservation). */
  settle(actual: number): Promise<void>;
  /** The call did not happen or failed (not billed): give back the session slot and the daily amount. */
  refund(): Promise<void>;
}

export type VoiceCapDecision = VoiceReservation | Refused<"session_cap" | "daily_cap" | "counter_unavailable">;

/**
 * Takes one session slot and `amount` units of the day's cap, both or neither.
 * `amount` is seconds for stt and characters for tts.
 */
export async function reserveVoice(kind: VoiceKind, sessionKey: string, amount: number, opts: CapOpts = {}): Promise<VoiceCapDecision> {
  const env = opts.env ?? process.env;
  if (!(dailyCap(kind, env) > 0)) return { ok: false, reason: "daily_cap" };
  const slot = await reserveSessionSlot(kind, sessionKey, opts);
  if (!slot.ok) return slot;
  const day = await reserveDaily(kind, amount, opts);
  if (!day.ok) {
    await slot.release();
    return day;
  }
  return {
    ok: true,
    settle: (actual) => day.settle(actual),
    async refund() {
      await day.refund();
      await slot.release();
    },
  };
}

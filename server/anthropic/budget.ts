/**
 * Daily Anthropic spend cap (owner: R0, ADR-040/044). Shared by the Gift Concierge (A7) and the Fit
 * Report explanations / taste summary (A3): every Claude call reserves its worst-case cost BEFORE the
 * request and settles to the real cost from `usage` afterwards. When the day's cap is reached, callers
 * degrade gracefully (template text, catalog filters) instead of calling the API.
 *
 * Counted in hundredths of a US cent ("centi-cents") on the durable counter `anthropic-<YYYY-MM-DD>`
 * (Firestore with STORE=firestore, so the cap survives cold starts; process memory otherwise).
 *
 *   ANTHROPIC_DAILY_USD_CAP   default 3 (USD per UTC day); 0 or negative disables Claude calls entirely.
 *   ANTHROPIC_PRICE_<TIER>_IN / _OUT  optional USD per million tokens overrides (see PRICES).
 */
import { isFirestoreStore, type Env } from "@/server/store/config";
import { dailyCounterKey, defaultDailyCounterStore, MemoryDailyCounterStore, type DailyCounterStore } from "@/server/store/daily-counter";

/** Default model for GiftFit's Claude features (claude-api reference: latest Sonnet). */
export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-5-5";

/**
 * Conservative USD per million tokens by model family, used for the reservation and the settle-up.
 * Cache reads bill at 0.1× input and cache writes at 1.25× input. Override per deployment with env.
 */
const PRICES: Record<string, { in: number; out: number }> = {
  opus: { in: 15, out: 75 },
  sonnet: { in: 3, out: 15 },
  haiku: { in: 1, out: 5 },
};

export interface ClaudeUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

function tierOf(model: string): keyof typeof PRICES {
  const m = model.toLowerCase();
  if (m.includes("opus")) return "opus";
  if (m.includes("haiku")) return "haiku";
  return "sonnet";
}

export function priceFor(model: string, env: Env = process.env): { in: number; out: number } {
  const tier = tierOf(model);
  const base = PRICES[tier];
  const num = (v: string | undefined, d: number) => (v !== undefined && v.trim() !== "" && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  return { in: num(env[`ANTHROPIC_PRICE_${tier.toUpperCase()}_IN`], base.in), out: num(env[`ANTHROPIC_PRICE_${tier.toUpperCase()}_OUT`], base.out) };
}

/** USD → centi-cents, rounded up so the counter never under-counts. */
export const toCentiCents = (usd: number) => Math.ceil(Math.max(0, usd) * 10_000);

/** Real cost of one response from its `usage` block. */
export function usageCostUsd(model: string, usage: ClaudeUsage, env: Env = process.env): number {
  const p = priceFor(model, env);
  const inTok = usage.input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const outTok = usage.output_tokens ?? 0;
  return (inTok * p.in + cacheWrite * p.in * 1.25 + cacheRead * p.in * 0.1 + outTok * p.out) / 1_000_000;
}

/** Worst case for one call: every input token uncached plus the full max_tokens of output. */
export function worstCaseUsd(model: string, inputTokens: number, maxTokens: number, env: Env = process.env): number {
  const p = priceFor(model, env);
  return (inputTokens * p.in * 1.25 + maxTokens * p.out) / 1_000_000;
}

export function dailyCapUsd(env: Env = process.env): number {
  const raw = env.ANTHROPIC_DAILY_USD_CAP;
  if (raw === undefined || raw.trim() === "") return 3;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 3;
}

const MEMORY_KEY = Symbol.for("giftfit.anthropic.budget.memory.v1");

function counterStore(env: Env): DailyCounterStore {
  if (isFirestoreStore(env)) return defaultDailyCounterStore(env)!;
  const g = globalThis as typeof globalThis & { [MEMORY_KEY]?: DailyCounterStore };
  return (g[MEMORY_KEY] ??= new MemoryDailyCounterStore());
}

export interface SpendReservation {
  ok: true;
  /** Settle to the real cost (refunds the difference). Pass the response usage, or null if no call was made. */
  settle(usage: ClaudeUsage | null): Promise<void>;
}

export type SpendDecision = SpendReservation | { ok: false; reason: "disabled" | "daily_cap" | "counter_unavailable" };

/**
 * Reserve the worst case for one Claude call. Fails closed: if the counter is unreachable, no call.
 * `opts.store` and `opts.now` are for tests.
 */
export async function reserveClaudeSpend(
  input: { model: string; inputTokens: number; maxTokens: number },
  opts: { env?: Env; store?: DailyCounterStore; now?: number } = {},
): Promise<SpendDecision> {
  const env = opts.env ?? process.env;
  const capUsd = dailyCapUsd(env);
  if (!(capUsd > 0)) return { ok: false, reason: "disabled" };
  const store = opts.store ?? counterStore(env);
  const key = dailyCounterKey("anthropic", opts.now);
  const reserved = toCentiCents(worstCaseUsd(input.model, input.inputTokens, input.maxTokens, env));
  let decision;
  try {
    decision = await store.tryReserve(key, reserved, toCentiCents(capUsd));
  } catch {
    return { ok: false, reason: "counter_unavailable" };
  }
  if (!decision.ok) return { ok: false, reason: "daily_cap" };
  let settled = false;
  return {
    ok: true,
    async settle(usage) {
      if (settled) return;
      settled = true;
      const actual = usage ? toCentiCents(usageCostUsd(input.model, usage, env)) : 0;
      const refund = reserved - actual;
      if (refund > 0) {
        try {
          await store.refund(key, refund);
        } catch (err) {
          console.error("[anthropic] spend refund failed:", (err as Error).message);
        }
      }
    },
  };
}

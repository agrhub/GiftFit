import { describe, expect, it } from "vitest";
import { MemoryDailyCounterStore, type DailyCounterStore } from "@/lib/store/daily-counter";
import { dailyCapUsd, reserveClaudeSpend, toCentiCents, usageCostUsd, worstCaseUsd } from "../budget";

const MODEL = "claude-sonnet-5-5";
const NOW = Date.parse("2026-10-17T12:00:00Z");

describe("anthropic daily spend cap", () => {
  it("prices usage with cache reads and writes", () => {
    const usd = usageCostUsd(MODEL, { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 }, {});
    expect(usd).toBeCloseTo(3 + 15 + 0.3 + 3.75, 6);
    expect(worstCaseUsd(MODEL, 1000, 500, {})).toBeCloseTo((1000 * 3 * 1.25 + 500 * 15) / 1e6, 9);
  });

  it("reserves the worst case, settles to the real cost, and refuses past the cap", async () => {
    const store = new MemoryDailyCounterStore();
    const env = { ANTHROPIC_DAILY_USD_CAP: "0.02" };
    const r = await reserveClaudeSpend({ model: MODEL, inputTokens: 2000, maxTokens: 500 }, { env, store, now: NOW });
    expect(r.ok).toBe(true);
    const reserved = toCentiCents(worstCaseUsd(MODEL, 2000, 500, env));
    expect(await store.get("anthropic-2026-10-17")).toBe(reserved);
    if (r.ok) await r.settle({ input_tokens: 2000, output_tokens: 100 });
    expect(await store.get("anthropic-2026-10-17")).toBe(toCentiCents(usageCostUsd(MODEL, { input_tokens: 2000, output_tokens: 100 }, env)));
    // A call whose worst case exceeds what is left of $0.02 is refused before any request.
    const big = await reserveClaudeSpend({ model: MODEL, inputTokens: 2000, maxTokens: 2000 }, { env, store, now: NOW });
    expect(big).toEqual({ ok: false, reason: "daily_cap" });
  });

  it("settling with no call refunds everything, once", async () => {
    const store = new MemoryDailyCounterStore();
    const r = await reserveClaudeSpend({ model: MODEL, inputTokens: 100, maxTokens: 100 }, { env: {}, store, now: NOW });
    if (!r.ok) throw new Error("expected ok");
    await r.settle(null);
    await r.settle(null);
    expect(await store.get("anthropic-2026-10-17")).toBe(0);
  });

  it("is disabled by a zero cap and fails closed when the counter is down", async () => {
    expect(await reserveClaudeSpend({ model: MODEL, inputTokens: 1, maxTokens: 1 }, { env: { ANTHROPIC_DAILY_USD_CAP: "0" }, store: new MemoryDailyCounterStore() })).toEqual({ ok: false, reason: "disabled" });
    const broken: DailyCounterStore = { kind: "broken", get: async () => 0, tryReserve: async () => Promise.reject(new Error("down")), refund: async () => 0 };
    expect(await reserveClaudeSpend({ model: MODEL, inputTokens: 1, maxTokens: 1 }, { env: {}, store: broken })).toEqual({ ok: false, reason: "counter_unavailable" });
    expect(dailyCapUsd({})).toBe(3);
  });
});

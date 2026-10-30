import { describe, expect, it } from "vitest";
import { MemoryDailyCounterStore, type DailyCounterStore } from "@/server/store/daily-counter";
import { dailyKey, reserveVoice, sessionCounterKey } from "../caps";

const NOW = Date.parse("2026-10-27T10:00:00Z");
const S = "0123456789abcdef01234567";

describe("voice caps (durable counters)", () => {
  it("uses voice-stt-<day> / voice-tts-<day> and per-session keys that fit the counter key format", () => {
    expect(dailyKey("stt", NOW)).toBe("voice-stt-2026-10-27");
    expect(dailyKey("tts", NOW)).toBe("voice-tts-2026-10-27");
    expect(sessionCounterKey("tts", S)).toBe(`voice-tts-s-${S}`);
  });

  it("12 inputs per session, then session_cap (and the refused call takes nothing from the day)", async () => {
    const store = new MemoryDailyCounterStore();
    for (let i = 0; i < 12; i += 1) expect((await reserveVoice("stt", S, 5, { env: {}, store, now: NOW })).ok).toBe(true);
    expect(await reserveVoice("stt", S, 5, { env: {}, store, now: NOW })).toEqual({ ok: false, reason: "session_cap" });
    expect(await store.get(dailyKey("stt", NOW))).toBe(60);
    // another session still has room
    expect((await reserveVoice("stt", "f".repeat(24), 5, { env: {}, store, now: NOW })).ok).toBe(true);
  });

  it("daily cap: 150k Google TTS characters; a refused call gives its session slot back", async () => {
    const store = new MemoryDailyCounterStore();
    await store.tryReserve(dailyKey("tts", NOW), 149_800, 0);
    expect((await reserveVoice("tts", S, 200, { env: {}, store, now: NOW })).ok).toBe(true);
    expect(await reserveVoice("tts", S, 1, { env: {}, store, now: NOW })).toEqual({ ok: false, reason: "daily_cap" });
    expect(await store.get(sessionCounterKey("tts", S))).toBe(1);
    // next UTC day is a fresh counter
    expect((await reserveVoice("tts", S, 1, { env: {}, store, now: NOW + 86_400_000 })).ok).toBe(true);
  });

  it("STT daily cap is audio seconds (default 3600) and settles to the billed duration", async () => {
    const store = new MemoryDailyCounterStore();
    const r = await reserveVoice("stt", S, 15, { env: {}, store, now: NOW });
    if (!r.ok) throw new Error("expected ok");
    await r.settle(3.2);
    expect(await store.get(dailyKey("stt", NOW))).toBe(4);
    const r2 = await reserveVoice("stt", S, 2, { env: {}, store, now: NOW });
    if (!r2.ok) throw new Error("expected ok");
    await r2.settle(6);
    expect(await store.get(dailyKey("stt", NOW))).toBe(10);
    await store.tryReserve(dailyKey("stt", NOW), 3590, 0);
    expect(await reserveVoice("stt", S, 1, { env: {}, store, now: NOW })).toEqual({ ok: false, reason: "daily_cap" });
  });

  it("refund gives back both the day and the session slot", async () => {
    const store = new MemoryDailyCounterStore();
    const r = await reserveVoice("tts", S, 300, { env: {}, store, now: NOW });
    if (!r.ok) throw new Error("expected ok");
    await r.refund();
    await r.refund(); // idempotent
    expect(await store.get(dailyKey("tts", NOW))).toBe(0);
    expect(await store.get(sessionCounterKey("tts", S))).toBe(0);
  });

  it("a zero cap disables the paid call", async () => {
    const store = new MemoryDailyCounterStore();
    expect(await reserveVoice("stt", S, 1, { env: { VOICE_STT_DAILY_SECONDS: "0" }, store, now: NOW })).toEqual({ ok: false, reason: "daily_cap" });
  });

  it("fails closed when the counter store is unreachable", async () => {
    const down: DailyCounterStore = {
      kind: "down",
      get: async () => Promise.reject(new Error("unavailable")),
      tryReserve: async () => Promise.reject(new Error("unavailable")),
      refund: async () => Promise.reject(new Error("unavailable")),
    };
    expect(await reserveVoice("tts", S, 10, { env: {}, store: down, now: NOW })).toEqual({ ok: false, reason: "counter_unavailable" });
    // session slot taken, then the daily counter fails: still closed, slot refund attempted
    const mem = new MemoryDailyCounterStore();
    const half: DailyCounterStore = { kind: "half", get: (k) => mem.get(k), refund: (k, a) => mem.refund(k, a), tryReserve: (k, a, c) => (k.startsWith("voice-tts-s-") ? mem.tryReserve(k, a, c) : Promise.reject(new Error("x"))) };
    expect(await reserveVoice("tts", S, 10, { env: {}, store: half, now: NOW, log: () => undefined })).toEqual({ ok: false, reason: "counter_unavailable" });
    expect(await mem.get(sessionCounterKey("tts", S))).toBe(0);
  });
});

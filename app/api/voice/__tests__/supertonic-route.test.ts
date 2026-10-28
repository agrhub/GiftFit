/**
 * /api/voice/tts with the server Supertonic engine (ADR-057): routing, fallback to Google (cold, queue,
 * budget, cap), caps, spike mode, STT warm-up, and /api/voice/metrics. Fake ORT; no weights, no keys.
 */
import { afterEach, describe, expect, it } from "vitest";
import { GET as metricsGET } from "@/app/api/voice/metrics/route";
import { findGiverLeaks } from "@/lib/privacy/giver-guard";
import { setRateLimitOverride } from "@/lib/privacy/rate-limit";
import { MemoryDailyCounterStore, type DailyCounterStore } from "@/lib/store/daily-counter";
import { dailyKey } from "@/lib/voice/caps";
import type { TtsEngine } from "@/lib/voice/google";
import { handleVoiceMetrics } from "@/lib/voice/metrics";
import { mockSttEngine, mockTtsEngine, type VoiceServerDeps } from "@/lib/voice/server";
import { handleStt } from "@/lib/voice/stt";
import { resetSupertonicServer, supertonicServer, SupertonicServer } from "@/lib/voice/supertonic/engine";
import { handleTts } from "@/lib/voice/tts";
import { fakeModel, type FakeOptions } from "@/lib/voice/__tests__/fakeOrt";
import { webmClip } from "@/lib/voice/__tests__/containers";

const NOW = Date.parse("2026-10-28T10:00:00Z");
const SESSION = "3b241101-e2bb-4255-8caf-4136c566a962";
const SECRET = "spike-secret-0123456789abcdef0123456789";

afterEach(() => {
  setRateLimitOverride(undefined);
  resetSupertonicServer();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The fake model takes 40 ms to "load", so a request can see the engine cold. */
function newEngine(o: FakeOptions = {}) {
  return new SupertonicServer({ threads: 1, steps: 3, log: () => undefined, load: async () => (await sleep(40), fakeModel({ durationSec: 0.4, ...o })) });
}

function setup(over: { env?: Record<string, string>; engine?: SupertonicServer | null; counters?: DailyCounterStore; tts?: TtsEngine } = {}) {
  const logs: string[] = [];
  const counters = (over.counters as MemoryDailyCounterStore) ?? new MemoryDailyCounterStore();
  const engine = over.engine === undefined ? newEngine() : over.engine;
  let created = 0;
  const deps: VoiceServerDeps = {
    env: { NODE_ENV: "test", VOICE_SERVER_SUPERTONIC: "on", ...over.env },
    stt: () => mockSttEngine,
    tts: () => over.tts ?? mockTtsEngine,
    counters,
    now: () => NOW,
    log: (l) => logs.push(l),
    supertonic: () => (created++, engine),
  };
  return { deps, logs, counters, engine, created: () => created };
}

const ttsReq = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://giftfit.test/api/voice/tts", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "x-voice-session": SESSION, ...headers } });

describe("POST /api/voice/tts with VOICE_SERVER_SUPERTONIC=on", () => {
  it("cold: answers with the other engine at once and starts loading the model", async () => {
    const { deps, engine, logs } = setup();
    const res = await handleTts(ttsReq({ text: "Hello there.", lang: "en" }), deps);
    expect(res.headers.get("x-voice-engine")).toBe("mock");
    expect(engine!.state).toBe("loading");
    expect(logs.join("\n")).toMatch(/supertonic-server skipped reason=cold/);
  });

  it("ready: one WAV for the chunk, synthesised sentence by sentence; counts sentences, not Google characters", async () => {
    const { deps, engine, counters } = setup();
    await engine!.waitReady(1000);
    const res = await handleTts(ttsReq({ text: "These hoops are light. They come in a gift box!", lang: "en" }), deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-voice-engine")).toBe("supertonic-server");
    expect(res.headers.get("content-type")).toBe("audio/wav");
    expect(res.headers.get("x-voice-sentences")).toBe("2");
    expect(Number(res.headers.get("x-voice-audio-ms"))).toBeGreaterThan(0);
    const wav = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
    expect(new DataView(wav.buffer).getUint32(24, true)).toBe(8000); // the fake model's 8 kHz is kept (not halved)
    expect(await counters.get(dailyKey("supertonic", NOW))).toBe(2);
    expect(await counters.get(dailyKey("tts", NOW))).toBe(0);
  });

  it.each(["ja", "es", "vi", "ko", "de"])("speaks %s on the server engine", async (lang) => {
    const { deps, engine } = setup();
    await engine!.waitReady(1000);
    const res = await handleTts(ttsReq({ text: lang === "ja" ? "軽いです。毎日つけられます。" : "Uno. Dos.", lang }), deps);
    expect(res.headers.get("x-voice-engine")).toBe("supertonic-server");
  });

  it("more than VOICE_SUPERTONIC_QUEUE_MAX requests ahead → Google for the newcomer", async () => {
    const engine = newEngine({ stepDelayMs: 30 });
    const { deps } = setup({ engine, env: { VOICE_SUPERTONIC_QUEUE_MAX: "0" } });
    await engine.waitReady(1000);
    const first = handleTts(ttsReq({ text: "One sentence here.", lang: "en" }), deps);
    await sleep(20); // the first request is now running
    expect(engine.pending()).toBe(1);
    const second = handleTts(ttsReq({ text: "Another sentence.", lang: "en" }, { "x-voice-session": "9f0e8c7d-1a2b-4c3d-8e4f-5a6b7c8d9e0f" }), deps);
    const [a, b] = await Promise.all([first, second]);
    expect(a.headers.get("x-voice-engine")).toBe("supertonic-server");
    expect(b.headers.get("x-voice-engine")).toBe("mock");
  });

  it("a sentence over the budget → aborted, Google answers, the Supertonic count is given back", async () => {
    const engine = newEngine({ stepDelayMs: 200 });
    const { deps, counters, logs } = setup({ engine, env: { VOICE_SUPERTONIC_SENTENCE_BUDGET_MS: "250" } });
    await engine.waitReady(1000);
    const res = await handleTts(ttsReq({ text: "This one is slow.", lang: "en" }), deps);
    expect(res.headers.get("x-voice-engine")).toBe("mock");
    expect(engine.metrics().aborted).toBe(1);
    expect(await counters.get(dailyKey("supertonic", NOW))).toBe(0);
    expect(logs.join("\n")).toMatch(/reason=budget/);
  });

  it("daily synthesis cap reached, or its counter unreachable → Google (fail closed for Supertonic)", async () => {
    const { deps, engine, counters } = setup({ env: { VOICE_SUPERTONIC_DAILY_SYNTHESES: "1" } });
    await engine!.waitReady(1000);
    expect((await handleTts(ttsReq({ text: "One. Two.", lang: "en" }), deps)).headers.get("x-voice-engine")).toBe("mock");
    expect(await counters.get(dailyKey("supertonic", NOW))).toBe(0);
    expect((await handleTts(ttsReq({ text: "One.", lang: "en" }), deps)).headers.get("x-voice-engine")).toBe("supertonic-server");

    const mem = new MemoryDailyCounterStore();
    const flaky: DailyCounterStore = { kind: "flaky", get: (k) => mem.get(k), refund: (k, a) => mem.refund(k, a), tryReserve: (k, a, c) => (k.startsWith("voice-supertonic-") ? Promise.reject(new Error("down")) : mem.tryReserve(k, a, c)) };
    const s2 = setup({ counters: flaky, engine });
    expect((await handleTts(ttsReq({ text: "Hello.", lang: "en" }), s2.deps)).headers.get("x-voice-engine")).toBe("mock");
  });

  it("per-session cap still applies (one slot per request, whichever engine)", async () => {
    const { deps, engine } = setup({ env: { VOICE_SESSION_TTS_MAX: "2" } });
    await engine!.waitReady(1000);
    expect((await handleTts(ttsReq({ text: "One.", lang: "en" }), deps)).status).toBe(200);
    expect((await handleTts(ttsReq({ text: "Two.", lang: "en" }), deps)).status).toBe(200);
    const third = await handleTts(ttsReq({ text: "Three.", lang: "en" }), deps);
    expect(third.status).toBe(429);
    expect(await third.json()).toEqual({ error: "session_cap" });
  });

  it("off (the default): the engine is never created and nothing changes", async () => {
    const s = setup({ env: { VOICE_SERVER_SUPERTONIC: "off" } });
    const res = await handleTts(ttsReq({ text: "Hello.", lang: "en" }), s.deps);
    expect(res.headers.get("x-voice-engine")).toBe("mock");
    expect(s.created()).toBe(0);
    expect(s.engine!.state).toBe("idle");
  });

  it("languages outside Supertonic's 31 are refused; error JSON stays giver-safe", async () => {
    const { deps } = setup();
    const res = await handleTts(ttsReq({ text: "你好", lang: "zh" }), deps);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: "bad_lang" });
    expect(findGiverLeaks(body)).toEqual([]);
  });

  it("the first STT call warms the engine (lazy load on first voice use)", async () => {
    const { deps, engine } = setup();
    const clip = webmClip([{ tc: 0, rels: Array.from({ length: 100 }, (_, i) => i * 20) }]);
    const res = await handleStt(new Request("https://giftfit.test/api/voice/stt", { method: "POST", body: clip as BodyInit, headers: { "content-type": "audio/webm", "x-voice-lang": "en", "x-voice-session": SESSION } }), deps);
    expect(res.status).toBe(200);
    expect(engine!.state).toBe("loading");
  });
});

describe("spike mode (VOICE_SPIKE=1 + Bearer CRON_SECRET)", () => {
  const auth = { authorization: `Bearer ${SECRET}` };

  it("x-voice-engine-force: supertonic waits for the model, skips per-IP and session limits, and reports timings", async () => {
    setRateLimitOverride(true);
    const { deps } = setup({ env: { VOICE_SPIKE: "1", CRON_SECRET: SECRET, VOICE_SERVER_SUPERTONIC: "off", VOICE_SESSION_TTS_MAX: "1" } });
    for (let i = 0; i < 3; i++) {
      const res = await handleTts(ttsReq({ text: "Cold start sentence.", lang: "es" }, { ...auth, "x-voice-engine-force": "supertonic", "x-forwarded-for": "203.0.113.9" }), deps);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-voice-engine")).toBe("supertonic-server");
      for (const h of ["x-voice-queue-ms", "x-voice-synth-ms", "x-voice-audio-ms"]) expect(Number(res.headers.get(h))).toBeGreaterThanOrEqual(0);
    }
  });

  it("without the secret the force header is ignored (normal routing and limits)", async () => {
    const { deps, engine } = setup({ env: { VOICE_SPIKE: "1", CRON_SECRET: SECRET } });
    const res = await handleTts(ttsReq({ text: "Hello.", lang: "en" }, { "x-voice-engine-force": "supertonic", authorization: "Bearer nope" }), deps);
    expect(res.headers.get("x-voice-engine")).toBe("mock");
    expect(engine!.state).toBe("loading");
  });

  it("forced Supertonic that cannot load → 503 (never a silent Google call)", async () => {
    const broken = new SupertonicServer({ threads: 1, steps: 2, log: () => undefined, load: async () => Promise.reject(new Error("missing")) });
    const { deps } = setup({ engine: broken, env: { VOICE_SPIKE: "1", CRON_SECRET: SECRET } });
    const res = await handleTts(ttsReq({ text: "Hello.", lang: "en" }, { ...auth, "x-voice-engine-force": "supertonic" }), deps);
    expect(res.status).toBe(503);
  });

  it("x-voice-engine-force: google pins Google even when Supertonic is ready", async () => {
    const { deps, engine } = setup({ env: { VOICE_SPIKE: "1", CRON_SECRET: SECRET } });
    await engine!.waitReady(1000);
    const res = await handleTts(ttsReq({ text: "Hello.", lang: "en" }, { ...auth, "x-voice-engine-force": "google" }), deps);
    expect(res.headers.get("x-voice-engine")).toBe("mock");
  });
});

describe("GET /api/voice/metrics", () => {
  const get = (auth?: string) => new Request("https://giftfit.test/api/voice/metrics", { headers: auth ? { authorization: auth } : {} });

  it("needs CRON_SECRET configured and the bearer token", () => {
    expect(handleVoiceMetrics(get(`Bearer ${SECRET}`), {}).status).toBe(503);
    expect(handleVoiceMetrics(get("Bearer wrong"), { CRON_SECRET: SECRET }).status).toBe(401);
    expect(handleVoiceMetrics(get(), { CRON_SECRET: SECRET }).status).toBe(401);
  });

  it("reports memory and engine numbers only, without creating or loading the engine", async () => {
    const res = handleVoiceMetrics(get(`Bearer ${SECRET}`), { CRON_SECRET: SECRET, VOICE_SERVER_SUPERTONIC: "on" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.process.rssMb).toBeGreaterThan(0);
    expect(body.process.peakRssMb).toBeGreaterThan(0);
    expect(body.supertonic).toEqual({ enabled: true, spike: false, engine: { state: "idle" } });

    const e = supertonicServer({ threads: 1, steps: 2, log: () => undefined, load: () => fakeModel() });
    await e.waitReady(1000);
    await e.synthesize(["Private reply text."], "en");
    const after = await handleVoiceMetrics(get(`Bearer ${SECRET}`), { CRON_SECRET: SECRET }).json();
    expect(after.supertonic.engine).toMatchObject({ state: "ready", requests: 1, sentences: 1, loadMs: expect.any(Number) });
    expect(JSON.stringify(after)).not.toMatch(/Private reply/);
  });

  it("the route module answers 503 when CRON_SECRET is unset", async () => {
    const prev = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    try {
      expect(metricsGET(get("Bearer x")).status).toBe(503);
    } finally {
      if (prev !== undefined) process.env.CRON_SECRET = prev;
    }
  });
});

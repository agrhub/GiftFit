/**
 * Voice routes (owner: A13): contract, caps, limits, mock mode and the no-logging rule, through the
 * handlers with injected engines/counters and through the real route modules (mock mode under tests).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as sttPOST } from "@/app/api/voice/stt/route";
import { POST as ttsPOST } from "@/app/api/voice/tts/route";
import { findGiverLeaks } from "@/lib/privacy/giver-guard";
import { setRateLimitOverride } from "@/lib/privacy/rate-limit";
import { MemoryDailyCounterStore, type DailyCounterStore } from "@/lib/store/daily-counter";
import { dailyKey, sessionCounterKey } from "@/lib/voice/caps";
import { VoiceEngineError, type SttEngine, type TtsEngine } from "@/lib/voice/google";
import { MOCK_TRANSCRIPTS } from "@/lib/voice/mock";
import { mockSttEngine, mockTtsEngine, type VoiceServerDeps } from "@/lib/voice/server";
import { handleStt } from "@/lib/voice/stt";
import { handleTts } from "@/lib/voice/tts";
import { mp4Clip, oggOpusClip, webmClip } from "@/lib/voice/__tests__/containers";

const NOW = Date.parse("2026-10-27T10:00:00Z");
const SESSION = "3b241101-e2bb-4255-8caf-4136c566a962";

afterEach(() => setRateLimitOverride(undefined));

function makeDeps(over: Partial<VoiceServerDeps> & { env?: Record<string, string> } = {}) {
  const logs: string[] = [];
  const counters = (over.counters as MemoryDailyCounterStore | undefined) ?? new MemoryDailyCounterStore();
  const deps: VoiceServerDeps = { stt: () => mockSttEngine, tts: () => mockTtsEngine, now: () => NOW, log: (l) => logs.push(l), ...over, env: { NODE_ENV: "test", ...over.env }, counters };
  return { deps, logs, counters };
}

const steps = (n: number, step = 20) => Array.from({ length: n }, (_, i) => i * step);
const clip5s = () => webmClip([{ tc: 0, rels: steps(250) }]); // 4.98 s

function sttReq(body: Uint8Array, headers: Record<string, string> = {}) {
  return new Request("https://giftfit.test/api/voice/stt", {
    method: "POST",
    body: body as BodyInit,
    headers: { "content-type": "audio/webm;codecs=opus", "x-voice-lang": "en", "x-voice-session": SESSION, ...headers },
  });
}

function ttsReq(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://giftfit.test/api/voice/tts", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json", "x-voice-session": SESSION, ...headers },
  });
}

describe("POST /api/voice/stt", () => {
  it("mock mode: canned transcript per language, engine header, giver-safe JSON, never cached", async () => {
    const { deps } = makeDeps();
    for (const lang of ["en", "vi"] as const) {
      const res = await handleStt(sttReq(clip5s(), { "x-voice-lang": lang }), deps);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-voice-engine")).toBe("mock");
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      const body = await res.json();
      expect(body).toEqual({ text: MOCK_TRANSCRIPTS[lang], lang });
      expect(findGiverLeaks(body)).toEqual([]);
    }
  });

  it("accepts Ogg/Opus and MP4 clips too", async () => {
    const { deps } = makeDeps();
    expect((await handleStt(sttReq(oggOpusClip(3), { "content-type": "audio/ogg;codecs=opus" }), deps)).status).toBe(200);
    expect((await handleStt(sttReq(mp4Clip(3), { "content-type": "audio/mp4" }), deps)).status).toBe(200);
  });

  it.each([
    ["missing language", { "x-voice-lang": "" }, clip5s(), "bad_lang"],
    ["unsupported language", { "x-voice-lang": "fr" }, clip5s(), "bad_lang"],
    ["missing session", { "x-voice-session": "" }, clip5s(), "bad_session"],
    ["non-UUID session", { "x-voice-session": "giver-token-abc" }, clip5s(), "bad_session"],
    ["wrong content type", { "content-type": "audio/wav" }, clip5s(), "bad_audio"],
    ["declared type differs from the bytes", { "content-type": "audio/mp4" }, clip5s(), "bad_audio"],
    ["longer than 15 s", {}, webmClip([{ tc: 0, rels: steps(800) }]), "too_long"],
    ["larger than 1 MiB", {}, new Uint8Array(1024 * 1024 + 10).fill(1), "too_large"],
  ])("400 for %s", async (_n, headers, body, error) => {
    const { deps, counters } = makeDeps();
    const res = await handleStt(sttReq(body, headers), deps);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error });
    expect(await counters.get(dailyKey("stt", NOW))).toBe(0);
  });

  it("live engine: gets the clip bytes and language; the day is settled to the billed seconds", async () => {
    const seen: Array<{ lang: string; bytes: number }> = [];
    const engine: SttEngine = { name: "google", transcribe: async ({ audio, lang }) => (seen.push({ lang, bytes: audio.byteLength }), { text: "Một chiếc nhẫn bạc.", billedSeconds: 5 }) };
    const { deps, counters } = makeDeps({ stt: () => engine });
    const clip = clip5s();
    const res = await handleStt(sttReq(clip, { "x-voice-lang": "vi" }), deps);
    expect(res.headers.get("x-voice-engine")).toBe("google");
    expect(await res.json()).toEqual({ text: "Một chiếc nhẫn bạc.", lang: "vi" });
    expect(seen).toEqual([{ lang: "vi", bytes: clip.byteLength }]);
    expect(await counters.get(dailyKey("stt", NOW))).toBe(5);
  });

  it("engine failure: 503 voice_unavailable and nothing counted", async () => {
    const engine: SttEngine = { name: "google", transcribe: async () => Promise.reject(new VoiceEngineError("14")) };
    const { deps, counters } = makeDeps({ stt: () => engine });
    const res = await handleStt(sttReq(clip5s()), deps);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "voice_unavailable" });
    expect(await counters.get(dailyKey("stt", NOW))).toBe(0);
    expect([...counters.counts.values()].every((v) => v === 0)).toBe(true);
  });

  it("per-session cap → 429 session_cap; another session continues", async () => {
    const { deps } = makeDeps({ env: { VOICE_SESSION_STT_MAX: "2" } });
    expect((await handleStt(sttReq(clip5s()), deps)).status).toBe(200);
    expect((await handleStt(sttReq(clip5s()), deps)).status).toBe(200);
    const third = await handleStt(sttReq(clip5s()), deps);
    expect(third.status).toBe(429);
    expect(await third.json()).toEqual({ error: "session_cap" });
    expect((await handleStt(sttReq(clip5s(), { "x-voice-session": "9f0e8c7d-1a2b-4c3d-8e4f-5a6b7c8d9e0f" }), deps)).status).toBe(200);
  });

  it("daily audio-seconds cap → 429 daily_cap", async () => {
    const { deps } = makeDeps({ env: { VOICE_STT_DAILY_SECONDS: "10" } });
    expect((await handleStt(sttReq(clip5s()), deps)).status).toBe(200);
    expect((await handleStt(sttReq(clip5s()), deps)).status).toBe(200);
    const res = await handleStt(sttReq(clip5s()), deps);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "daily_cap" });
  });

  it("fails closed when the counters are unreachable, and when voice is switched off", async () => {
    const down: DailyCounterStore = { kind: "down", get: async () => 0, tryReserve: async () => Promise.reject(new Error("x")), refund: async () => 0 };
    const transcribe = vi.fn(mockSttEngine.transcribe);
    const { deps } = makeDeps({ counters: down, stt: () => ({ name: "google", transcribe }) });
    expect((await handleStt(sttReq(clip5s()), deps)).status).toBe(503);
    expect(transcribe).not.toHaveBeenCalled();
    const off = makeDeps({ env: { VOICE_ENABLED: "0" } });
    const res = await handleStt(sttReq(clip5s()), off.deps);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "voice_unavailable" });
  });

  it("per-IP rate limit voice_stt (20/h) answers 429 before anything else", async () => {
    setRateLimitOverride(true);
    const { deps } = makeDeps();
    const ip = { "x-forwarded-for": "203.0.113.77" };
    for (let i = 0; i < 20; i += 1) expect((await handleStt(sttReq(clip5s(), { ...ip, "x-voice-lang": "xx" }), deps)).status).toBe(400);
    const res = await handleStt(sttReq(clip5s(), ip), deps);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
    expect(res.headers.get("retry-after")).toBeTruthy();
  });
});

describe("POST /api/voice/tts", () => {
  it("mock mode: a WAV tone with a syllable envelope and x-voice-engine: mock", async () => {
    const { deps } = makeDeps();
    const res = await handleTts(ttsReq({ text: "Here are three ideas for your sister.", lang: "en" }), deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/wav");
    expect(res.headers.get("x-voice-engine")).toBe("mock");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(buf.subarray(0, 4))).toBe("RIFF");
    expect(Number(res.headers.get("content-length"))).toBe(buf.byteLength);
    // amplitude rises and falls: some 25 ms windows are near-silent, others loud
    const pcm = new Int16Array(buf.buffer.slice(44));
    const win = 400;
    const rms: number[] = [];
    for (let i = 0; i + win <= pcm.length; i += win) {
      let s = 0;
      for (let j = i; j < i + win; j += 1) s += (pcm[j] / 32768) ** 2;
      rms.push(Math.sqrt(s / win));
    }
    expect(Math.min(...rms)).toBeLessThan(0.05);
    expect(Math.max(...rms)).toBeGreaterThan(0.15);
  });

  it("server voice: MP3 bytes with x-voice-engine: google; the day counts characters", async () => {
    const calls: Array<{ text: string; lang: string }> = [];
    const engine: TtsEngine = { name: "google", synthesize: async (i) => (calls.push(i), { audio: new Uint8Array([0xff, 0xfb, 0x90, 0x00]), contentType: "audio/mpeg", voice: "vi-VN-Chirp3-HD-Charon" }) };
    const { deps, counters } = makeDeps({ tts: () => engine });
    const res = await handleTts(ttsReq({ text: "  Đây là ba gợi ý  cho bạn. ", lang: "vi" }), deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(res.headers.get("x-voice-engine")).toBe("google");
    expect(calls).toEqual([{ text: "Đây là ba gợi ý cho bạn.", lang: "vi" }]);
    expect(await counters.get(dailyKey("tts", NOW))).toBe([..."Đây là ba gợi ý cho bạn."].length);
  });

  it.each([
    ["invalid JSON", "{nope", "bad_request"],
    ["missing text", { lang: "en" }, "bad_request"],
    ["blank text", { text: "   ", lang: "en" }, "bad_request"],
    ["bad language", { text: "Hi", lang: "zh" }, "bad_lang"],
    ["over 400 characters", { text: "a".repeat(401), lang: "en" }, "text_too_long"],
    ["huge body", { text: "a".repeat(20_000), lang: "en" }, "text_too_long"],
  ])("400 for %s", async (_n, body, error) => {
    const { deps } = makeDeps();
    const res = await handleTts(ttsReq(body), deps);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error });
  });

  it("exactly 400 characters is allowed; a missing session is not", async () => {
    const { deps } = makeDeps();
    expect((await handleTts(ttsReq({ text: "b".repeat(400), lang: "en" }), deps)).status).toBe(200);
    const res = await handleTts(ttsReq({ text: "Hi", lang: "en" }, { "x-voice-session": "" }), deps);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_session" });
  });

  it("caps: 12 replies per session, then 429 session_cap; the daily character cap → 429 daily_cap", async () => {
    const { deps } = makeDeps();
    for (let i = 0; i < 12; i += 1) expect((await handleTts(ttsReq({ text: "Hello", lang: "en" }), deps)).status).toBe(200);
    const res = await handleTts(ttsReq({ text: "Hello", lang: "en" }), deps);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "session_cap" });

    const small = makeDeps({ env: { VOICE_TTS_DAILY_CHARS: "8" } });
    expect((await handleTts(ttsReq({ text: "Hello", lang: "en" }), small.deps)).status).toBe(200);
    const over = await handleTts(ttsReq({ text: "Hello", lang: "en" }), small.deps);
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ error: "daily_cap" });
  });

  it("engine failure: 503 and the reservation is refunded", async () => {
    const engine: TtsEngine = { name: "google", synthesize: async () => Promise.reject(new VoiceEngineError("3")) };
    const { deps, counters } = makeDeps({ tts: () => engine });
    const res = await handleTts(ttsReq({ text: "Hello", lang: "en" }), deps);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "voice_unavailable" });
    expect(await counters.get(dailyKey("tts", NOW))).toBe(0);
    expect([...counters.counts.entries()].filter(([k]) => k.startsWith("voice-tts-s-")).every(([, v]) => v === 0)).toBe(true);
  });

  it("per-IP rate limit voice_tts (40/h)", async () => {
    setRateLimitOverride(true);
    const { deps } = makeDeps();
    const ip = { "x-forwarded-for": "198.51.100.23" };
    for (let i = 0; i < 40; i += 1) expect((await handleTts(ttsReq({ text: "Hi", lang: "xx" }, ip), deps)).status).toBe(400);
    expect((await handleTts(ttsReq({ text: "Hi", lang: "en" }, ip), deps)).status).toBe(429);
  });
});

describe("privacy: no text or audio in logs", () => {
  it("logs carry metrics only, never the reply text, transcript or clip bytes", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const SECRET_TEXT = "Zebra quartz secret phrase";
    const SECRET_TRANSCRIPT = "Platypus transcript marker";
    const stt: SttEngine = { name: "google", transcribe: async () => ({ text: SECRET_TRANSCRIPT, billedSeconds: 5 }) };
    const failing: TtsEngine = { name: "google", synthesize: async () => Promise.reject(Object.assign(new VoiceEngineError("13"), { detail: SECRET_TEXT })) };
    const { deps, logs } = makeDeps({ stt: () => stt });
    const clip = clip5s();
    await handleStt(sttReq(clip), deps);
    await handleTts(ttsReq({ text: SECRET_TEXT, lang: "en" }), deps);
    await handleTts(ttsReq({ text: SECRET_TEXT, lang: "en" }), { ...deps, tts: () => failing });
    const printed = [...logs, ...spies.flatMap((s) => s.mock.calls.map((c) => c.map(String).join(" ")))].join("\n");
    expect(logs.length).toBeGreaterThanOrEqual(3);
    expect(printed).not.toContain(SECRET_TEXT);
    expect(printed).not.toContain(SECRET_TRANSCRIPT);
    expect(printed).not.toContain(Buffer.from(clip).toString("base64").slice(0, 24));
    expect(printed).not.toContain(SESSION);
    expect(logs.join("\n")).toMatch(/\[voice\] stt engine=google lang=en .*outcome=ok/);
  });
});

describe("route modules (mock mode under NODE_ENV=test)", () => {
  it("POST /api/voice/stt and /api/voice/tts answer with the mock engines", async () => {
    const stt = await sttPOST(sttReq(clip5s(), { "x-voice-session": "c1b2a3d4-0000-4000-8000-000000000001" }));
    expect(stt.status).toBe(200);
    expect(await stt.json()).toEqual({ text: MOCK_TRANSCRIPTS.en, lang: "en" });
    const tts = await ttsPOST(ttsReq({ text: "Xin chào!", lang: "vi" }, { "x-voice-session": "c1b2a3d4-0000-4000-8000-000000000001" }));
    expect(tts.status).toBe(200);
    expect(tts.headers.get("x-voice-engine")).toBe("mock");
    expect(tts.headers.get("content-type")).toBe("audio/wav");
  });

  it("session counter keys never contain the raw session id", async () => {
    const { deps, counters } = makeDeps();
    await handleTts(ttsReq({ text: "Hi", lang: "en" }), deps);
    const keys = [...counters.counts.keys()];
    expect(keys.some((k) => /^voice-tts-s-[0-9a-f]{24}$/.test(k))).toBe(true);
    expect(keys.join(" ")).not.toContain(SESSION.slice(0, 8));
    expect(keys).toContain(sessionCounterKey("tts", keys.find((k) => k.startsWith("voice-tts-s-"))!.slice(12)));
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceAudio } from "../audio";
import { isDesktop, naturalVoiceAvailable } from "../capability";
import { IDLE, Speaker, type LocalEngine, type SpeakerState } from "../speaker";
import { SupertonicClient, type NaturalStatus, type WorkerLike } from "../supertonic/client";
import type { FromWorker, ToWorker } from "../supertonic/protocol";
import { SUPERTONIC_BASE } from "../supertonic/manifest";

/** Plays are pending until `end()`; records everything. */
class FakeAudio {
  supported = true;
  plays: Array<{ buffer: { tag: string }; end(): void; signal?: AbortSignal }> = [];
  stops = 0;
  analyser = { fake: true } as unknown as AnalyserNode;
  unlock = vi.fn();
  close = vi.fn();
  async decode(bytes: ArrayBuffer) {
    return { tag: `server:${new TextDecoder().decode(bytes)}` } as unknown as AudioBuffer;
  }
  fromPcm(pcm: Float32Array, rate: number) {
    return { tag: `local:${pcm.length}@${rate}` } as unknown as AudioBuffer;
  }
  play(buffer: AudioBuffer, signal?: AbortSignal) {
    return new Promise<void>((resolve) => {
      const p = { buffer: buffer as unknown as { tag: string }, end: resolve, signal };
      this.plays.push(p);
      signal?.addEventListener("abort", () => resolve());
    });
  }
  stop() {
    this.stops++;
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(cond: () => boolean) {
  for (let i = 0; i < 100 && !cond(); i++) await tick();
  expect(cond()).toBe(true);
}

function ttsFetch(status = 200, engine = "google") {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (status !== 200) return new Response(JSON.stringify({ error: "capped" }), { status, headers: { "content-type": "application/json" } });
    const { text } = JSON.parse(String(init?.body)) as { text: string };
    return new Response(new TextEncoder().encode(text.slice(0, 12)), { headers: { "content-type": "audio/mpeg", "x-voice-engine": engine } });
  });
}

function make(o: { fetch?: ReturnType<typeof ttsFetch>; local?: LocalEngine | null; browser?: ((t: string) => Promise<void>) | null } = {}) {
  const audio = new FakeAudio();
  const states: SpeakerState[] = [];
  const fetchMock = o.fetch ?? ttsFetch();
  const speaker = new Speaker(
    {
      audio: audio as unknown as VoiceAudio,
      sessionId: "sess-1234",
      fetchImpl: fetchMock as unknown as typeof fetch,
      local: () => o.local ?? null,
      browserSpeak: o.browser === undefined ? null : o.browser,
    },
    (s) => states.push(s),
  );
  return { audio, states, fetchMock, speaker };
}

const LONG = `First sentence is right here for you. ${"This is a sentence about gold hoops and pearls. ".repeat(12)}`;

describe("Speaker", () => {
  it("speaks server TTS chunk by chunk (≤ 400 chars, session header), prefetching the next", async () => {
    const { audio, states, fetchMock, speaker } = make();
    const done = speaker.speak(LONG, "en");
    await until(() => audio.plays.length === 1);
    expect(states.at(-1)).toEqual({ speaking: true, preparing: false, engine: "google", analysed: true });
    // The second chunk is requested while the first plays.
    await until(() => fetchMock.mock.calls.length === 2);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe("/api/voice/tts");
      expect((init!.headers as Record<string, string>)["x-voice-session"]).toBe("sess-1234");
      const body = JSON.parse(String(init!.body)) as { text: string; lang: string };
      expect(body.lang).toBe("en");
      expect(body.text.length).toBeLessThanOrEqual(400);
    }
    audio.plays[0].end();
    await until(() => audio.plays.length === 2);
    audio.plays[1].end();
    await until(() => audio.plays.length === 3 || states.at(-1) === IDLE);
    audio.plays[2]?.end();
    await done;
    expect(states.at(-1)).toEqual(IDLE);
    expect(fetchMock.mock.calls.length).toBe(audio.plays.length);
  });

  it("cancel (interruption) stops playback and requests nothing more", async () => {
    const { audio, fetchMock, speaker, states } = make();
    const done = speaker.speak(LONG, "en");
    await until(() => audio.plays.length === 1);
    await until(() => fetchMock.mock.calls.length === 2);
    speaker.cancel();
    await done;
    expect(audio.plays[0].signal?.aborted).toBe(true);
    expect(audio.stops).toBeGreaterThan(0);
    await tick();
    expect(audio.plays).toHaveLength(1);
    expect(fetchMock.mock.calls.length).toBe(2);
    expect(states.at(-1)).toEqual(IDLE);
  });

  it("a new reply replaces the one playing", async () => {
    const { audio, speaker } = make();
    void speaker.speak("Old reply here.", "en");
    await until(() => audio.plays.length === 1);
    void speaker.speak("New reply here.", "en");
    await until(() => audio.plays.length === 2);
    expect(audio.plays[0].signal?.aborted).toBe(true);
    expect(audio.plays[1].buffer.tag).toBe("server:New reply he");
  });

  it("prefers Supertonic in the browser when ready, falls back to the server when it fails", async () => {
    const local: LocalEngine = { ready: () => true, synth: vi.fn(async () => ({ pcm: new Float32Array(441), sampleRate: 44100 })) };
    const a = make({ local });
    void a.speaker.speak("Hello there.", "en");
    await until(() => a.audio.plays.length === 1);
    expect(a.audio.plays[0].buffer.tag).toBe("local:441@44100");
    expect(a.states.at(-1)).toMatchObject({ engine: "local", analysed: true });
    expect(a.fetchMock).not.toHaveBeenCalled();

    const broken: LocalEngine = { ready: () => true, synth: vi.fn(async () => Promise.reject(new Error("gpu lost"))) };
    const b = make({ local: broken });
    void b.speaker.speak("Hello there.", "vi");
    await until(() => b.audio.plays.length === 1);
    expect(b.audio.plays[0].buffer.tag).toMatch(/^server:/);
    expect(b.fetchMock).toHaveBeenCalledTimes(1);

    const notReady = make({ local: { ready: () => false, synth: vi.fn() } });
    void notReady.speaker.speak("Hello there.", "en");
    await until(() => notReady.audio.plays.length === 1);
    expect(notReady.audio.plays[0].buffer.tag).toMatch(/^server:/);
  });

  it("uses the in-browser Supertonic only for its languages: ja yes; zh and th go to the server", async () => {
    const local: LocalEngine = { ready: () => true, synth: vi.fn(async () => ({ pcm: new Float32Array(441), sampleRate: 44100 })) };
    const ja = make({ local });
    void ja.speaker.speak("軽いピアスです。", "ja");
    await until(() => ja.audio.plays.length === 1);
    expect(ja.audio.plays[0].buffer.tag).toBe("local:441@44100");

    for (const lang of ["zh", "th"] as const) {
      const s = make({ local });
      void s.speaker.speak(lang === "zh" ? "这对耳环很轻。" : "ต่างหูคู่นี้เบามาก", lang);
      await until(() => s.audio.plays.length === 1);
      expect(s.audio.plays[0].buffer.tag).toMatch(/^server:/);
      expect(JSON.parse(String(s.fetchMock.mock.calls[0][1]?.body))).toMatchObject({ lang });
    }
    expect(local.synth).toHaveBeenCalledTimes(1);
  });

  it("server capped (429) → browser speechSynthesis with a rhythm mouth, and the server isn't asked again", async () => {
    const browser = vi.fn(async () => {});
    const { speaker, states, fetchMock, audio } = make({ fetch: ttsFetch(429), browser });
    await speaker.speak("One reply.", "vi");
    expect(browser).toHaveBeenCalledWith("One reply.", "vi", expect.any(AbortSignal));
    expect(states).toContainEqual({ speaking: true, preparing: false, engine: "browser", analysed: false });
    await speaker.speak("Another reply.", "vi");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(browser).toHaveBeenCalledTimes(2);
    expect(audio.plays).toHaveLength(0);
  });

  it("no audio engine at all → text only (nothing plays, back to idle)", async () => {
    const { speaker, states, audio } = make({ fetch: ttsFetch(503), browser: null });
    await speaker.speak("Quiet reply.", "en");
    expect(audio.plays).toHaveLength(0);
    expect(states.some((s) => s.speaking)).toBe(false);
    expect(states.at(-1)).toEqual(IDLE);
  });
});

describe("natural voice capability", () => {
  it("desktop only", () => {
    expect(isDesktop({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140" })).toBe(true);
    expect(isDesktop({ userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 7) Mobile" })).toBe(false);
    expect(isDesktop({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", maxTouchPoints: 5 })).toBe(false);
    expect(isDesktop({ userAgentData: { mobile: true }, userAgent: "Windows" })).toBe(false);
  });

  it("needs a WebGPU adapter", async () => {
    const ua = "Mozilla/5.0 (Windows NT 10.0) Chrome/140";
    expect(await naturalVoiceAvailable({ userAgent: ua })).toBe(false);
    expect(await naturalVoiceAvailable({ userAgent: ua, gpu: { requestAdapter: async () => null } })).toBe(false);
    expect(await naturalVoiceAvailable({ userAgent: ua, gpu: { requestAdapter: async () => ({}) } })).toBe(true);
    expect(await naturalVoiceAvailable({ userAgent: "Android Mobile", gpu: { requestAdapter: async () => ({}) } })).toBe(false);
  });
});

describe("SupertonicClient", () => {
  const ORIGIN = "https://giftfit.example";
  const manifest = {
    revision: "x",
    files: ["onnx/duration_predictor.onnx", "onnx/text_encoder.onnx", "onnx/vector_estimator.onnx", "onnx/vocoder.onnx", "onnx/tts.json", "onnx/unicode_indexer.json", "voice_styles/M1.json"].map((path) => ({
      path,
      size: 100_000_000,
      sha256: "a".repeat(64),
      parts: [{ path: `${path}.part000`, size: 100_000_000, sha256: "a".repeat(64) }],
    })),
  };

  class FakeWorker implements WorkerLike {
    sent: ToWorker[] = [];
    onmessage: ((e: MessageEvent<FromWorker>) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    terminated = false;
    postMessage(m: ToWorker) {
      this.sent.push(m);
    }
    terminate() {
      this.terminated = true;
    }
    emit(m: FromWorker) {
      this.onmessage?.({ data: m } as MessageEvent<FromWorker>);
    }
  }

  function client() {
    const statuses: NaturalStatus[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request) => (String(url).endsWith("manifest.json") ? Response.json(manifest) : new Response("weights!")));
    const workers: FakeWorker[] = [];
    const c = new SupertonicClient({
      origin: ORIGIN,
      fetchImpl: fetchMock as unknown as typeof fetch,
      openCache: async () => null,
      createWorker: () => {
        const w = new FakeWorker();
        workers.push(w);
        return w;
      },
      onStatus: (s) => statuses.push(s),
      synthTimeoutMs: 50,
    });
    return { c, statuses, fetchMock, workers };
  }

  afterEach(() => vi.useRealTimers());

  it("probe reads only the manifest and offers the size; no worker, no weights before the click", async () => {
    const { c, statuses, fetchMock, workers } = client();
    expect(await c.probe()).toEqual({ total: 700_000_000, cached: 0 });
    expect(statuses.at(-1)).toEqual({ kind: "offer", total: 700_000_000, cached: 0 });
    expect(fetchMock.mock.calls.map((x) => String(x[0]))).toEqual([`${ORIGIN}${SUPERTONIC_BASE}manifest.json`]);
    expect(workers).toHaveLength(0);
  });

  it("start → progress → ready; synth round-trips through the worker; cancel terminates it", async () => {
    const { c, statuses, workers } = client();
    await c.probe();
    c.start(true);
    const w = workers[0];
    expect(w.sent[0]).toMatchObject({ type: "init", allowDownload: true, base: `${ORIGIN}${SUPERTONIC_BASE}`, ortModule: `${ORIGIN}/voice/ort/1.30.0/ort.webgpu.min.mjs` });
    w.emit({ type: "progress", phase: "weights", loaded: 5, total: 10, downloaded: 5 });
    expect(statuses.at(-1)).toEqual({ kind: "downloading", loaded: 5, total: 10 });
    w.emit({ type: "progress", phase: "session", loaded: 2, total: 4, downloaded: 0 });
    expect(statuses.at(-1)).toEqual({ kind: "loading", step: 2, of: 4 });
    expect(c.ready()).toBe(false);
    w.emit({ type: "ready", ep: "webgpu", timings: { weightsMs: 1, sessionMs: 2, warmupMs: 3, downloaded: 10, perModelMs: {} } });
    expect(c.ready()).toBe(true);

    const p = c.synth("Hi.", "en", new AbortController().signal);
    const req = w.sent.at(-1) as Extract<ToWorker, { type: "synth" }>;
    expect(req).toMatchObject({ type: "synth", text: "Hi.", lang: "en" });
    w.emit({ type: "audio", id: req.id, pcm: new Float32Array(3), sampleRate: 44100, ms: 5 });
    await expect(p).resolves.toMatchObject({ sampleRate: 44100 });

    // Aborted request → the worker is told to drop it.
    const ctrl = new AbortController();
    const q = c.synth("Bye.", "en", ctrl.signal);
    ctrl.abort();
    await expect(q).rejects.toThrow();
    expect(w.sent.at(-1)).toMatchObject({ type: "drop" });

    // A hung synthesis times out (the speaker then falls back to the server).
    await expect(c.synth("Slow.", "en", new AbortController().signal)).rejects.toThrow("timeout");

    c.cancel();
    expect(w.sent.some((m) => m.type === "cancel")).toBe(true);
    expect(w.terminated).toBe(true);
    expect(c.ready()).toBe(false);
  });

  it("a worker error shows the error state", async () => {
    const { c, statuses, workers } = client();
    await c.probe();
    c.start(true);
    workers[0].emit({ type: "error", code: "integrity", message: "x" });
    expect(statuses.at(-1)).toEqual({ kind: "error", code: "integrity" });
    expect(workers[0].terminated).toBe(true);
  });
});

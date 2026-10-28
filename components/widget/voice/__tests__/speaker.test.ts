import { describe, expect, it, vi } from "vitest";
import type { VoiceAudio } from "../audio";
import { IDLE, Speaker, type SpeakerState } from "../speaker";

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

function make(o: { fetch?: ReturnType<typeof ttsFetch>; browser?: ((t: string) => Promise<void>) | null } = {}) {
  const audio = new FakeAudio();
  const states: SpeakerState[] = [];
  const fetchMock = o.fetch ?? ttsFetch();
  const speaker = new Speaker(
    {
      audio: audio as unknown as VoiceAudio,
      sessionId: "sess-1234",
      fetchImpl: fetchMock as unknown as typeof fetch,
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

  it("every language goes to the server voice (Google), zh and th included; the engine is never anything else", async () => {
    for (const [lang, text] of [["ja", "軽いピアスです。"], ["zh", "这对耳环很轻。"], ["th", "ต่างหูคู่นี้เบามาก"], ["vi", "Đôi khuyên tai rất nhẹ."]] as const) {
      const s = make();
      void s.speaker.speak(text, lang);
      await until(() => s.audio.plays.length === 1);
      expect(s.audio.plays[0].buffer.tag).toMatch(/^server:/);
      expect(JSON.parse(String(s.fetchMock.mock.calls[0][1]?.body))).toMatchObject({ lang });
      expect(s.states.at(-1)).toMatchObject({ engine: "google", analysed: true });
    }
  });

  it("an unknown x-voice-engine header is still labelled google", async () => {
    const { audio, states, speaker } = make({ fetch: ttsFetch(200, "local") });
    void speaker.speak("Hello there.", "en");
    await until(() => audio.plays.length === 1);
    expect(states.at(-1)).toMatchObject({ engine: "google" });
  });

  it("server down (503) → browser speechSynthesis for that chunk", async () => {
    const browser = vi.fn(async () => {});
    const { speaker, states } = make({ fetch: ttsFetch(503), browser });
    await speaker.speak("One reply.", "en");
    expect(browser).toHaveBeenCalledWith("One reply.", "en", expect.any(AbortSignal));
    expect(states).toContainEqual({ speaking: true, preparing: false, engine: "browser", analysed: false });
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

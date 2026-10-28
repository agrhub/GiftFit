/**
 * Spoken replies in any language (ADR-057): the reply's language goes to /api/voice/tts when Google has a
 * voice for it; a language without one stays text only (no request, no browser voice, no error).
 */
import { describe, expect, it, vi } from "vitest";
import type { VoiceAudio } from "../audio";
import { canSpeak, IDLE, Speaker, type SpeakerState } from "../speaker";

class FakeAudio {
  supported = true;
  plays = 0;
  async decode() {
    return {} as AudioBuffer;
  }
  fromPcm() {
    return {} as AudioBuffer;
  }
  async play() {
    this.plays++;
  }
  stop() {}
}

function make() {
  const fetchMock = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(async () => new Response(new Uint8Array([1, 2]), { headers: { "content-type": "audio/mpeg", "x-voice-engine": "google" } }));
  const browser = vi.fn(async () => undefined);
  const states: SpeakerState[] = [];
  const audio = new FakeAudio();
  const speaker = new Speaker({ audio: audio as unknown as VoiceAudio, sessionId: "sess-1", fetchImpl: fetchMock as unknown as typeof fetch, local: () => null, browserSpeak: browser }, (s) => states.push(s));
  return { fetchMock, browser, states, audio, speaker };
}

describe("Speaker languages", () => {
  it("canSpeak: any language with a Google voice or Supertonic; not the rest", () => {
    for (const l of ["en", "vi", "pt", "it", "he", "ru", "hi", "ms"]) expect(canSpeak(l), l).toBe(true);
    for (const l of ["fa", "ka", "sw", "xx", ""]) expect(canSpeak(l), l).toBe(false);
  });

  it("sends the reply's own language to the server voice", async () => {
    const { fetchMock, audio, speaker } = make();
    await speaker.speak("Aqui estão três ideias para a sua mãe.", "pt");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ lang: "pt" });
    expect(audio.plays).toBe(1);
  });

  it("a language without any voice is text only: no request, no browser voice, no state change", async () => {
    const { fetchMock, browser, states, audio, speaker } = make();
    await speaker.speak("سه پیشنهاد برای مادرتان دارم.", "fa");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(browser).not.toHaveBeenCalled();
    expect(audio.plays).toBe(0);
    expect(states.every((s) => !s.preparing && !s.speaking)).toBe(true);
    expect(speaker.current).toEqual(IDLE);
  });
});

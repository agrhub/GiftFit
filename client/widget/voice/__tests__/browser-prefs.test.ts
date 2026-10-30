// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { NoBrowserVoiceError, pickVoice, speakWithBrowser } from "../browserTts";
import { micNoticeSeen, setMicNoticeSeen, setVoiceOn, voiceOn, voiceSessionId, SESSION_KEY } from "../prefs";
import { micErrorKind, pickMimeType } from "../recorder";

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

const voice = (lang: string, name = lang) => ({ lang, name }) as SpeechSynthesisVoice;

class FakeUtterance {
  voice: SpeechSynthesisVoice | null = null;
  lang = "";
  rate = 1;
  onend: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(readonly text: string) {}
}

function fakeSynth(voices: SpeechSynthesisVoice[]) {
  const spoken: FakeUtterance[] = [];
  return {
    spoken,
    synth: {
      getVoices: () => voices,
      speak: vi.fn((u: FakeUtterance) => {
        spoken.push(u);
        setTimeout(() => u.onend?.(), 0);
      }),
      cancel: vi.fn(),
    } as unknown as SpeechSynthesis,
  };
}

describe("browser speechSynthesis fallback", () => {
  it("picks a voice for the language, preferring the exact region", () => {
    expect(pickVoice([voice("en-GB"), voice("en-US")], "en")?.lang).toBe("en-US");
    expect(pickVoice([voice("vi_VN", "An")], "vi")?.name).toBe("An");
    expect(pickVoice([voice("en-US")], "vi")).toBeNull();
  });

  it("speaks with the language's voice, and refuses when there is none", async () => {
    vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
    const { synth, spoken } = fakeSynth([voice("vi-VN", "Linh")]);
    await speakWithBrowser("Xin chào", "vi", undefined, synth);
    expect(spoken[0]).toMatchObject({ text: "Xin chào", lang: "vi-VN" });
    await expect(speakWithBrowser("Hello", "en", undefined, synth)).rejects.toBeInstanceOf(NoBrowserVoiceError);
  });

  it("an abort cancels the browser voice", async () => {
    vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
    const { synth } = fakeSynth([voice("en-US")]);
    (synth.speak as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    const ctrl = new AbortController();
    const p = speakWithBrowser("Hello", "en", ctrl.signal, synth);
    await new Promise((r) => setTimeout(r, 0));
    ctrl.abort();
    await p;
    expect(synth.cancel).toHaveBeenCalled();
  });
});

describe("voice prefs", () => {
  it("voice is off by default and remembered; the mic notice is once per viewer", () => {
    expect(voiceOn()).toBe(false);
    setVoiceOn(true);
    expect(voiceOn()).toBe(true);
    expect(micNoticeSeen()).toBe(false);
    setMicNoticeSeen();
    expect(micNoticeSeen()).toBe(true);
  });

  it("one random session id per page session", () => {
    const a = voiceSessionId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(voiceSessionId()).toBe(a);
    expect(sessionStorage.getItem(SESSION_KEY)).toBe(a);
    sessionStorage.clear();
    expect(voiceSessionId()).not.toBe(a);
  });
});

describe("recorder helpers", () => {
  it("prefers Opus in WebM, then AAC in MP4 (older Safari)", () => {
    expect(pickMimeType((t) => t.startsWith("audio/webm"))).toBe("audio/webm;codecs=opus");
    expect(pickMimeType((t) => t === "audio/mp4")).toBe("audio/mp4");
    expect(pickMimeType(() => false)).toBe("");
  });

  it("classifies getUserMedia errors", () => {
    expect(micErrorKind({ name: "NotAllowedError" })).toBe("denied");
    expect(micErrorKind({ name: "NotFoundError" })).toBe("no-device");
    expect(micErrorKind(new Error("x"))).toBe("error");
  });
});

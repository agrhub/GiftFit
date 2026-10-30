import { describe, expect, it, vi } from "vitest";
import { charCount, sessionMax, sttDailySeconds, ttsDailyChars, ttsVoices, voiceEnabled, voiceMode } from "../config";
import {
  billedSecondsFromResponse,
  buildRecognizeRequest,
  buildSynthesizeRequest,
  googleSttEngine,
  googleTtsEngine,
  recognizerPath,
  transcriptFromResponse,
  VoiceEngineError,
  type SpeechV2ClientLike,
  type TtsClientLike,
} from "../google";

describe("voice config", () => {
  it("mode: VOICE_MOCK wins, tests are mock, Cloud Run / explicit ADC is live, else mock", () => {
    expect(voiceMode({ VOICE_MOCK: "1", K_SERVICE: "giftfit" })).toBe("mock");
    expect(voiceMode({ VOICE_MOCK: "0", NODE_ENV: "test" })).toBe("live");
    expect(voiceMode({ NODE_ENV: "test", K_SERVICE: "giftfit" })).toBe("mock");
    expect(voiceMode({ NODE_ENV: "production", K_SERVICE: "giftfit" })).toBe("live");
    expect(voiceMode({ GOOGLE_APPLICATION_CREDENTIALS: "/x.json" })).toBe("live");
    expect(voiceMode({})).toBe("mock");
  });

  it("kill switch and caps from env with safe defaults", () => {
    expect(voiceEnabled({})).toBe(true);
    expect(voiceEnabled({ VOICE_ENABLED: "0" })).toBe(false);
    expect(sttDailySeconds({})).toBe(3600);
    expect(ttsDailyChars({})).toBe(150_000);
    expect(ttsDailyChars({ VOICE_TTS_DAILY_CHARS: "nope" })).toBe(150_000);
    expect(sttDailySeconds({ VOICE_STT_DAILY_SECONDS: "0" })).toBe(0);
    expect(sessionMax("stt", {})).toBe(12);
    expect(sessionMax("tts", { VOICE_SESSION_TTS_MAX: "3" })).toBe(3);
  });

  it("TTS voices: Chirp 3 HD primary, Neural2 fallback, configurable, language-checked", () => {
    expect(ttsVoices("vi", {})).toEqual(["vi-VN-Chirp3-HD-Charon", "vi-VN-Neural2-D"]);
    expect(ttsVoices("en", {})).toEqual(["en-US-Chirp3-HD-Charon", "en-US-Neural2-D"]);
    expect(ttsVoices("vi", { VOICE_TTS_VOICE_VI: "vi-VN-Neural2-A", VOICE_TTS_FALLBACK_VOICE_VI: "off" })).toEqual(["vi-VN-Neural2-A"]);
    expect(() => ttsVoices("vi", { VOICE_TTS_VOICE_VI: "en-US-Neural2-D" })).toThrow(/vi-VN/);
  });

  it("counts characters as code points", () => {
    expect(charCount("Xin chào 👋")).toBe(10);
  });
});

describe("Speech-to-Text V2 request shape", () => {
  it("uses the implicit us recognizer, chirp_3, autoDecodingConfig and automatic language identification", () => {
    const content = new Uint8Array([1, 2, 3]);
    expect(buildRecognizeRequest("gcp-project-405602", "vi", content)).toEqual({
      recognizer: "projects/gcp-project-405602/locations/us/recognizers/_",
      config: { autoDecodingConfig: {}, model: "chirp_3", languageCodes: ["auto"], features: { enableAutomaticPunctuation: true } },
      content,
    });
    // VOICE_STT_LANGUAGE=fixed: one forced language, the widget's.
    expect(buildRecognizeRequest("gcp-project-405602", "vi", content, "fixed").config.languageCodes).toEqual(["vi-VN"]);
    expect(buildRecognizeRequest("gcp-project-405602", "en", content, "fixed").config.languageCodes).toEqual(["en-US"]);
    expect(() => recognizerPath("../other")).toThrow();
  });

  it("joins result transcripts and reads billed seconds (Long-like seconds)", () => {
    const resp = { results: [{ alternatives: [{ transcript: " Hello there. " }] }, { alternatives: [] }, { alternatives: [{ transcript: "A ring, please." }] }], metadata: { totalBilledDuration: { seconds: { toString: () => "4" }, nanos: 0 } } };
    expect(transcriptFromResponse(resp)).toBe("Hello there. A ring, please.");
    expect(billedSecondsFromResponse(resp)).toBe(4);
    expect(transcriptFromResponse({})).toBe("");
    expect(billedSecondsFromResponse({})).toBeNull();
  });

  it("engine: resolves the project through ADC when GOOGLE_CLOUD_PROJECT is unset, passes a timeout", async () => {
    const recognize = vi.fn(async () => [{ results: [{ alternatives: [{ transcript: "xin chào" }] }], metadata: { totalBilledDuration: { seconds: 2 } } }] as [object]);
    const client = { recognize, getProjectId: vi.fn(async () => "proj-abc-123") } as unknown as SpeechV2ClientLike;
    const engine = googleSttEngine(async () => client, {});
    expect(await engine.transcribe({ audio: new Uint8Array([9]), lang: "vi" })).toEqual({ text: "xin chào", billedSeconds: 2 });
    const calls = recognize.mock.calls as unknown as Array<[{ recognizer: string }, { timeout: number }]>;
    expect(calls[0][0].recognizer).toBe("projects/proj-abc-123/locations/us/recognizers/_");
    expect(calls[0][1].timeout).toBeGreaterThan(0);
  });

  it("engine errors carry only a status code", async () => {
    const client = { recognize: async () => Promise.reject(Object.assign(new Error("PERMISSION_DENIED: secret detail"), { code: 7 })), getProjectId: async () => "p-12345" } as unknown as SpeechV2ClientLike;
    const err = await googleSttEngine(async () => client, { GOOGLE_CLOUD_PROJECT: "p-12345" }).transcribe({ audio: new Uint8Array([1]), lang: "en" }).catch((e) => e);
    expect(err).toBeInstanceOf(VoiceEngineError);
    expect(err.code).toBe("7");
    expect(err.message).not.toMatch(/secret/);
  });
});

describe("Text-to-Speech request shape and fallback", () => {
  it("asks for MP3 with the stock voice and its language code", () => {
    expect(buildSynthesizeRequest("Xin chào", "vi-VN-Chirp3-HD-Charon")).toEqual({
      input: { text: "Xin chào" },
      voice: { languageCode: "vi-VN", name: "vi-VN-Chirp3-HD-Charon" },
      audioConfig: { audioEncoding: "MP3" },
    });
  });

  it("falls back to the Neural2 voice once when the primary fails", async () => {
    const synthesizeSpeech = vi.fn(async (req: { voice: { name: string } }) => {
      if (req.voice.name.includes("Chirp3")) throw Object.assign(new Error("x"), { code: 3 });
      return [{ audioContent: new Uint8Array([0xff, 0xfb, 1]) }] as [object];
    });
    const engine = googleTtsEngine(async () => ({ synthesizeSpeech }) as unknown as TtsClientLike, {});
    const r = await engine.synthesize({ text: "Hello", lang: "en" });
    expect(r).toMatchObject({ contentType: "audio/mpeg", voice: "en-US-Neural2-D" });
    expect(synthesizeSpeech.mock.calls.map((c) => (c[0] as { voice: { name: string } }).voice.name)).toEqual(["en-US-Chirp3-HD-Charon", "en-US-Neural2-D"]);
  });

  it("decodes base64 audio and fails when every voice fails or returns nothing", async () => {
    const b64 = googleTtsEngine(async () => ({ synthesizeSpeech: async () => [{ audioContent: Buffer.from([1, 2]).toString("base64") }] }) as unknown as TtsClientLike, {});
    expect((await b64.synthesize({ text: "a", lang: "vi" })).audio).toEqual(new Uint8Array([1, 2]));
    const empty = googleTtsEngine(async () => ({ synthesizeSpeech: async () => [{ audioContent: new Uint8Array() }] }) as unknown as TtsClientLike, {});
    await expect(empty.synthesize({ text: "a", lang: "vi" })).rejects.toBeInstanceOf(VoiceEngineError);
  });
});

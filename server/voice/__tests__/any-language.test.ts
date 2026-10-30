/**
 * Voice in any language (ADR-057): chirp_3 automatic language identification and the detected language
 * in the STT response; Google TTS voices for every language Google has (voices.ts), text only for the
 * rest. Fake clients and mock engines only: no Google calls.
 */
import { describe, expect, it } from "vitest";
import { MemoryDailyCounterStore } from "@/server/store/daily-counter";
import { isTtsLang, sttLanguageMode, TTS_LANGS, TTS_LOCALES, ttsVoices, voiceLanguageCode } from "../config";
import { googleSttEngine, googleTtsEngine, languageFromResponse, type RecognizeRequest, type SpeechV2ClientLike, type SttEngine, type SynthesizeRequest, type TtsClientLike } from "../google";
import { mockSttEngine, mockTtsEngine, type VoiceServerDeps } from "../server";
import { handleStt } from "../stt";
import { handleTts } from "../tts";
import { GOOGLE_TTS_VOICES, googleTtsVoiceFor, type TtsVoiceChoice } from "../voices";
import { webmClip } from "./containers";

const SESSION = "3b241101-e2bb-4255-8caf-4136c566a962";
const NOW = Date.parse("2026-10-28T10:00:00Z");

function deps(over: Partial<VoiceServerDeps> = {}): VoiceServerDeps {
  return { stt: () => mockSttEngine, tts: () => mockTtsEngine, now: () => NOW, log: () => {}, env: { NODE_ENV: "test" }, counters: new MemoryDailyCounterStore(), ...over };
}

const clip = () => webmClip([{ tc: 0, rels: Array.from({ length: 100 }, (_, i) => i * 20) }]);
const sttReq = (lang = "en") =>
  new Request("https://giftfit.test/api/voice/stt", { method: "POST", body: clip() as BodyInit, headers: { "content-type": "audio/webm;codecs=opus", "x-voice-lang": lang, "x-voice-session": SESSION } });
const ttsReq = (body: unknown) => new Request("https://giftfit.test/api/voice/tts", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "x-voice-session": SESSION } });

function fakeSpeech(resp: object): SpeechV2ClientLike & { seen: RecognizeRequest[] } {
  const seen: RecognizeRequest[] = [];
  return {
    seen,
    async recognize(req) {
      seen.push(req);
      return [resp];
    },
    async getProjectId() {
      return "giftfit-test";
    },
  };
}

describe("speech-to-text: automatic language identification", () => {
  it("is the default; VOICE_STT_LANGUAGE=fixed forces the widget's language", () => {
    expect(sttLanguageMode({})).toBe("auto");
    expect(sttLanguageMode({ VOICE_STT_LANGUAGE: "auto" })).toBe("auto");
    expect(sttLanguageMode({ VOICE_STT_LANGUAGE: " FIXED " })).toBe("fixed");
    expect(sttLanguageMode({ VOICE_STT_LANGUAGE: "nonsense" })).toBe("auto");
  });

  it("reads the language chirp_3 reports, as a base code, from the first result with words", () => {
    const r = (languageCode: string, transcript = "x") => ({ alternatives: [{ transcript }], languageCode });
    expect(languageFromResponse({ results: [r("pt-br")] })).toBe("pt");
    expect(languageFromResponse({ results: [r("cmn-hans-cn")] })).toBe("zh");
    expect(languageFromResponse({ results: [r("iw-il")] })).toBe("he");
    expect(languageFromResponse({ results: [r("en-us", " "), r("vi-vn")] })).toBe("vi");
    expect(languageFromResponse({ results: [{ alternatives: [{ transcript: "hi" }] }] })).toBeUndefined();
    expect(languageFromResponse({})).toBeUndefined();
  });

  it("the Google engine sends ['auto'] and returns the detected language", async () => {
    const client = fakeSpeech({ results: [{ alternatives: [{ transcript: "Quero um colar" }], languageCode: "pt-BR" }] });
    const engine = googleSttEngine(async () => client, { GOOGLE_CLOUD_PROJECT: "giftfit-test" });
    const r = await engine.transcribe({ audio: new Uint8Array([1]), lang: "en" });
    expect(client.seen[0].config.languageCodes).toEqual(["auto"]);
    expect(r).toMatchObject({ text: "Quero um colar", language: "pt" });

    const fixed = fakeSpeech({ results: [{ alternatives: [{ transcript: "Xin chào" }] }] });
    const r2 = await googleSttEngine(async () => fixed, { GOOGLE_CLOUD_PROJECT: "giftfit-test", VOICE_STT_LANGUAGE: "fixed" }).transcribe({ audio: new Uint8Array([1]), lang: "vi" });
    expect(fixed.seen[0].config.languageCodes).toEqual(["vi-VN"]);
    expect(r2).not.toHaveProperty("language");
  });

  it("the route returns detectedLang beside the widget's lang (only a clean base code)", async () => {
    const engine = (language?: string): SttEngine => ({ name: "google", transcribe: async () => ({ text: "Cerco un regalo", billedSeconds: 2, ...(language ? { language } : {}) }) });
    const res = await handleStt(sttReq("en"), deps({ stt: () => engine("it") }));
    expect(await res.json()).toEqual({ text: "Cerco un regalo", lang: "en", detectedLang: "it" });
    expect(await (await handleStt(sttReq("en"), deps({ stt: () => engine("<b>") }))).json()).toEqual({ text: "Cerco un regalo", lang: "en" });
    expect(await (await handleStt(sttReq("ja"), deps({ stt: () => engine() }))).json()).toEqual({ text: "Cerco un regalo", lang: "ja" });
  });
});

describe("text-to-speech voices for any language", () => {
  it("every table entry is one locale: Chirp 3 HD Charon, else Neural2/Standard, fallback in the same locale", () => {
    for (const [lang, v] of Object.entries(GOOGLE_TTS_VOICES) as Array<[string, TtsVoiceChoice]>) {
      expect(voiceLanguageCode(v.primary), lang).toBe(v.locale);
      if (v.fallback) {
        expect(voiceLanguageCode(v.fallback), lang).toBe(v.locale);
        expect(v.fallback).not.toBe(v.primary);
        expect(v.fallback, lang).toMatch(/-(Neural2|Standard)-[A-Z]$/);
      }
      expect(v.primary, lang).toMatch(/-(Chirp3-HD-Charon|Neural2-[A-Z]|Standard-[A-Z])$/);
    }
    // Chirp 3 HD where Google has it; the others are the documented exceptions.
    const noChirp = Object.entries(GOOGLE_TTS_VOICES).filter(([, v]) => !v.primary.endsWith("-Chirp3-HD-Charon")).map(([l]) => l).sort();
    expect(noChirp).toEqual(["af", "ca", "eu", "fil", "gl", "is", "ms"]);
  });

  it("accepts any language with a voice; refuses the rest (→ text only in the widget)", () => {
    for (const l of ["pt", "it", "ru", "ar", "hi", "he", "nb", "ms", "yue", "fil"]) expect(isTtsLang(l), l).toBe(true);
    for (const l of ["fa", "ka", "sw", "km", "am", "xx", "pt-BR", "PT", "", null, undefined, "__proto__", "toString"]) expect(isTtsLang(l), String(l)).toBe(false);
    expect(googleTtsVoiceFor("fa")).toBeNull();
    expect(TTS_LANGS.length).toBe(Object.keys(GOOGLE_TTS_VOICES).length);
  });

  it("picks primary then fallback; single-voice locales have no fallback; env overrides still checked", () => {
    expect(ttsVoices("pt", {})).toEqual(["pt-BR-Chirp3-HD-Charon", "pt-BR-Neural2-B"]);
    expect(ttsVoices("he", {})).toEqual(["he-IL-Chirp3-HD-Charon", "he-IL-Standard-B"]);
    expect(ttsVoices("ms", {})).toEqual(["ms-MY-Standard-B", "ms-MY-Standard-D"]);
    expect(ttsVoices("hr", {})).toEqual(["hr-HR-Chirp3-HD-Charon"]);
    expect(ttsVoices("af", {})).toEqual(["af-ZA-Standard-A"]);
    expect(ttsVoices("pt", { VOICE_TTS_FALLBACK_VOICE_PT: "off" })).toEqual(["pt-BR-Chirp3-HD-Charon"]);
    expect(ttsVoices("pt", { VOICE_TTS_VOICE_PT: "pt-BR-Neural2-A" })).toEqual(["pt-BR-Neural2-A", "pt-BR-Neural2-B"]);
    expect(() => ttsVoices("pt", { VOICE_TTS_VOICE_PT: "pt-PT-Standard-E" })).toThrow(/pt-BR/);
    expect(TTS_LOCALES.yue).toBe("yue-HK");
  });

  it("the Google engine asks for the table's voice in its locale", async () => {
    const seen: SynthesizeRequest[] = [];
    const client: TtsClientLike = {
      async synthesizeSpeech(req) {
        seen.push(req);
        return [{ audioContent: new Uint8Array([1, 2, 3]) }];
      },
    };
    const r = await googleTtsEngine(async () => client, {}).synthesize({ text: "Olá", lang: "pt" });
    expect(r.voice).toBe("pt-BR-Chirp3-HD-Charon");
    expect(seen[0].voice).toEqual({ languageCode: "pt-BR", name: "pt-BR-Chirp3-HD-Charon" });
  });

  it("the route speaks a language with a voice and refuses one without (no audio, no spend)", async () => {
    const ok = await handleTts(ttsReq({ text: "שלום, הנה שלושה רעיונות.", lang: "he" }), deps());
    expect(ok.status).toBe(200);
    expect(ok.headers.get("x-voice-engine")).toBe("mock");
    const no = await handleTts(ttsReq({ text: "سلام", lang: "fa" }), deps());
    expect(no.status).toBe(400);
    expect(await no.json()).toEqual({ error: "bad_lang" });
  });
});

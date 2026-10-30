/**
 * Voice languages (ADR-057 multi-language): chirp_3 codes per widget language, the languages TTS
 * accepts (Google only, ADR-059) and the default Google voices.
 */
import { describe, expect, it } from "vitest";
import { LOCALES } from "@/server/i18n";
import {
  DEFAULT_TTS_FALLBACK_VOICES,
  DEFAULT_TTS_VOICES,
  isTtsLang,
  isVoiceLang,
  STT_LANGUAGE_CODES,
  TTS_LOCALES,
  ttsVoices,
  VOICE_LANGS,
  voiceLanguageCode,
} from "../config";
import { buildRecognizeRequest } from "../google";
import { MOCK_TRANSCRIPTS } from "../mock";

describe("speech-to-text languages", () => {
  it("the mic takes every widget language and nothing else", () => {
    expect(VOICE_LANGS).toEqual(LOCALES);
    for (const l of LOCALES) expect(isVoiceLang(l)).toBe(true);
    for (const l of ["pt", "it", "EN", "en-US", "zh-CN", "", undefined, 1]) expect(isVoiceLang(l)).toBe(false);
  });

  it("maps each widget language to its chirp_3 code", () => {
    expect(STT_LANGUAGE_CODES).toEqual({
      en: "en-US", vi: "vi-VN", ja: "ja-JP", ko: "ko-KR", zh: "cmn-Hans-CN", th: "th-TH", id: "id-ID", es: "es-US", fr: "fr-FR", de: "de-DE",
    });
    expect(buildRecognizeRequest("giftfit-test", "zh", new Uint8Array([1]), "fixed").config).toMatchObject({ model: "chirp_3", languageCodes: ["cmn-Hans-CN"] });
    expect(buildRecognizeRequest("giftfit-test", "th", new Uint8Array([1]), "fixed").config.languageCodes).toEqual(["th-TH"]);
  });

  it("has a mock transcript in every language", () => {
    for (const l of LOCALES) expect(MOCK_TRANSCRIPTS[l].length).toBeGreaterThan(10);
  });
});

describe("text-to-speech languages", () => {
  it("accepts every widget language and the other languages Google has a voice for; refuses the rest", () => {
    for (const l of LOCALES) expect(isTtsLang(l)).toBe(true);
    for (const l of ["it", "pt", "uk", "ar"]) expect(isTtsLang(l)).toBe(true);
    for (const l of ["na", "zh-CN", "ZH", "xx", "", null]) expect(isTtsLang(l)).toBe(false);
  });

  it("each widget language has a Chirp 3 HD voice and a fallback in its Google locale", () => {
    for (const l of LOCALES) {
      expect(DEFAULT_TTS_VOICES[l]).toBe(`${TTS_LOCALES[l]}-Chirp3-HD-Charon`);
      expect(voiceLanguageCode(DEFAULT_TTS_FALLBACK_VOICES[l])).toBe(TTS_LOCALES[l]);
      expect(ttsVoices(l, {})).toEqual([DEFAULT_TTS_VOICES[l], DEFAULT_TTS_FALLBACK_VOICES[l]]);
    }
    expect(ttsVoices("zh", {})).toEqual(["cmn-CN-Chirp3-HD-Charon", "cmn-CN-Standard-B"]);
    expect(ttsVoices("th", {})).toEqual(["th-TH-Chirp3-HD-Charon", "th-TH-Neural2-C"]);
    expect(ttsVoices("ja", { VOICE_TTS_FALLBACK_VOICE_JA: "off" })).toEqual(["ja-JP-Chirp3-HD-Charon"]);
    expect(() => ttsVoices("zh", { VOICE_TTS_VOICE_ZH: "zh-CN-Chirp3-HD-Charon" })).toThrow(/cmn-CN/);
    // Languages outside the widget: Chirp 3 HD Charon plus the table's Neural2/Standard fallback (voices.ts).
    expect(ttsVoices("it", {})).toEqual(["it-IT-Chirp3-HD-Charon", "it-IT-Neural2-F"]);
  });
});

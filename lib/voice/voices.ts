/**
 * Google Cloud Text-to-Speech voices per language (owner: A17, ADR-057 "speak any language Google has a
 * voice for"). Pure data, browser-safe: the widget uses it to skip audio for languages without a voice
 * (text only, no error) and the server (config.ts ttsVoices) to pick the voice.
 *
 * Static table, checked 2026-10-28 against the official voice list
 * (https://docs.cloud.google.com/text-to-speech/docs/list-voices-and-types; every name below appears
 * there, read from the page's table). Selection rule per language:
 *   primary  = <locale>-Chirp3-HD-Charon (male, like the mascot) where Chirp 3 HD has the locale,
 *              else a male Neural2 voice, else a male Standard voice, else any Standard voice;
 *   fallback = a male Neural2 voice, else a male Standard voice, else the locale's only other voice
 *              (female where no male exists); none when the locale has a single voice.
 * One locale per language (the most widely used one with the best voices: en-US, es-US like the mic,
 * pt-BR, fr-FR, cmn-CN for Mandarin, ar-XA, nb-NO …). Languages Google has no voice for (Persian, Georgian,
 * Swahili, Khmer …) are absent: the reply is shown as text only.
 * No paid calls: the free voices.list API is not called at runtime or in tests.
 */

export interface TtsVoiceChoice {
  /** Google language code the voices belong to ("pt-BR"). */
  locale: string;
  primary: string;
  /** Tried once when the primary call fails. */
  fallback?: string;
}

const C3 = (locale: string, fallback?: string): TtsVoiceChoice => ({ locale, primary: `${locale}-Chirp3-HD-Charon`, ...(fallback ? { fallback } : {}) });
const ONLY = (locale: string, primary: string, fallback?: string): TtsVoiceChoice => ({ locale, primary, ...(fallback ? { fallback } : {}) });

/** Keyed by the language code lib/i18n detectLanguage / baseLanguage returns. */
export const GOOGLE_TTS_VOICES = {
  // The ten widget languages (A14's choices, unchanged).
  en: C3("en-US", "en-US-Neural2-D"),
  vi: C3("vi-VN", "vi-VN-Neural2-D"),
  ja: C3("ja-JP", "ja-JP-Neural2-C"),
  ko: C3("ko-KR", "ko-KR-Neural2-C"),
  zh: C3("cmn-CN", "cmn-CN-Standard-B"),
  th: C3("th-TH", "th-TH-Neural2-C"),
  id: C3("id-ID", "id-ID-Standard-B"),
  es: C3("es-US", "es-US-Neural2-B"),
  fr: C3("fr-FR", "fr-FR-Neural2-G"),
  de: C3("de-DE", "de-DE-Neural2-H"),
  // Every other language in the voice list.
  ar: C3("ar-XA", "ar-XA-Standard-B"),
  bg: C3("bg-BG", "bg-BG-Standard-B"),
  bn: C3("bn-IN", "bn-IN-Standard-B"),
  cs: C3("cs-CZ", "cs-CZ-Standard-B"),
  da: C3("da-DK", "da-DK-Standard-G"),
  el: C3("el-GR", "el-GR-Standard-B"),
  et: C3("et-EE", "et-EE-Standard-A"),
  fi: C3("fi-FI", "fi-FI-Standard-B"),
  gu: C3("gu-IN", "gu-IN-Standard-B"),
  he: C3("he-IL", "he-IL-Standard-B"),
  hi: C3("hi-IN", "hi-IN-Neural2-B"),
  hr: C3("hr-HR"),
  hu: C3("hu-HU", "hu-HU-Standard-B"),
  it: C3("it-IT", "it-IT-Neural2-F"),
  kn: C3("kn-IN", "kn-IN-Standard-B"),
  lt: C3("lt-LT", "lt-LT-Standard-B"),
  lv: C3("lv-LV", "lv-LV-Standard-B"),
  ml: C3("ml-IN", "ml-IN-Standard-B"),
  mr: C3("mr-IN", "mr-IN-Standard-B"),
  nb: C3("nb-NO", "nb-NO-Standard-G"),
  nl: C3("nl-NL", "nl-NL-Standard-G"),
  pa: C3("pa-IN", "pa-IN-Standard-B"),
  pl: C3("pl-PL", "pl-PL-Standard-G"),
  pt: C3("pt-BR", "pt-BR-Neural2-B"),
  ro: C3("ro-RO", "ro-RO-Standard-B"),
  ru: C3("ru-RU", "ru-RU-Standard-B"),
  sk: C3("sk-SK", "sk-SK-Standard-B"),
  sl: C3("sl-SI"),
  sr: C3("sr-RS", "sr-RS-Standard-B"),
  sv: C3("sv-SE", "sv-SE-Standard-E"),
  ta: C3("ta-IN", "ta-IN-Standard-B"),
  te: C3("te-IN", "te-IN-Standard-B"),
  tr: C3("tr-TR", "tr-TR-Standard-B"),
  uk: C3("uk-UA", "uk-UA-Standard-B"),
  ur: C3("ur-IN", "ur-IN-Standard-B"),
  yue: C3("yue-HK", "yue-HK-Standard-B"),
  // No Chirp 3 HD voice for these locales: Neural2 or Standard only.
  af: ONLY("af-ZA", "af-ZA-Standard-A"),
  ca: ONLY("ca-ES", "ca-ES-Standard-B"),
  eu: ONLY("eu-ES", "eu-ES-Standard-B"),
  fil: ONLY("fil-PH", "fil-PH-Standard-C", "fil-PH-Standard-D"),
  gl: ONLY("gl-ES", "gl-ES-Standard-B"),
  is: ONLY("is-IS", "is-IS-Standard-B"),
  ms: ONLY("ms-MY", "ms-MY-Standard-B", "ms-MY-Standard-D"),
} as const satisfies Record<string, TtsVoiceChoice>;

export type GoogleTtsLang = keyof typeof GOOGLE_TTS_VOICES;

export function hasGoogleTtsVoice(lang: unknown): lang is GoogleTtsLang {
  return typeof lang === "string" && Object.prototype.hasOwnProperty.call(GOOGLE_TTS_VOICES, lang);
}

/** The voices for a language, or null when Google has none (→ text only). */
export function googleTtsVoiceFor(lang: string): TtsVoiceChoice | null {
  return hasGoogleTtsVoice(lang) ? GOOGLE_TTS_VOICES[lang] : null;
}

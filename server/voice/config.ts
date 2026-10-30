/**
 * Voice server configuration (owner: A13, ADR-052; ADR-059: the server does Speech-to-Text and Google
 * Cloud Text-to-Speech is the only voice; the widget falls back to the browser's own speechSynthesis).
 *
 *   VOICE_ENABLED=0               both routes answer 503 voice_unavailable (kill switch)
 *   VOICE_MOCK=1 | 0              force mock (canned transcript, sine-tone WAV) or live Google calls.
 *                                 Unset: mock under NODE_ENV=test or when no Google credentials are
 *                                 evident (not on Cloud Run and no GOOGLE_APPLICATION_CREDENTIALS);
 *                                 live on Cloud Run (K_SERVICE is set there).
 *   GOOGLE_CLOUD_PROJECT          project for the STT recognizer path (else resolved through ADC)
 *   VOICE_STT_LANGUAGE=auto|fixed default auto: chirp_3 identifies the spoken language itself
 *                                 (languageCodes ["auto"]) and the route returns it; fixed = the
 *                                 widget's UI language only (STT_LANGUAGE_CODES), as before ADR-057's
 *                                 "any language" decision.
 *   VOICE_TTS_VOICE_<LANG>        Google TTS voice per language (EN, VI, PT, …; defaults in server/voice/voices.ts
 *                                 GOOGLE_TTS_VOICES: <locale>-Chirp3-HD-Charon where Chirp 3 HD has the
 *                                 locale, else Neural2, else Standard)
 *   VOICE_TTS_FALLBACK_VOICE_<LANG>  voice tried once when the primary call fails (defaults in the same
 *                                 table: a male Neural2 or Standard voice where the locale has one);
 *                                 "off" disables the fallback. Setting the primary to a Neural2 voice
 *                                 is how to switch tiers once the Chirp 3 HD free tier is used up.
 *   VOICE_STT_DAILY_SECONDS       daily Speech-to-Text cap in billed audio seconds (default 3600 = 60 min)
 *   VOICE_TTS_DAILY_CHARS         daily Google TTS cap in characters (default 150000)
 *   VOICE_SESSION_STT_MAX / _TTS_MAX   per widget session (default 12 each)
 *   VOICE_LOG=0                   silence the one metrics line per request (it never holds text or audio)
 *
 * Languages (ADR-057 multi-language, "any language"): Speech-to-Text runs chirp_3 with automatic
 * language identification (languageCodes ["auto"]; docs.cloud.google.com/speech-to-text/v2/docs/chirp_3-model:
 * "Language-agnostic audio transcription", GA in us and eu) and returns the language it reports; the
 * x-voice-lang header (a widget locale) only picks the code in fixed mode. TTS takes every language with
 * a Google voice (server/voice/voices.ts). Codes and voice names were checked against Google's chirp_3
 * language table and the Text-to-Speech voice list (2026-10-28).
 */
import { LOCALES, type Locale } from "@/server/i18n";
import type { Env } from "@/server/store/config";
import { GOOGLE_TTS_VOICES, hasGoogleTtsVoice, type GoogleTtsLang } from "./voices";

/** Languages the mic accepts: the widget's UI languages. */
export type VoiceLang = Locale;
export const VOICE_LANGS: readonly VoiceLang[] = LOCALES;

export const STT_LOCATION = "us";
export const STT_ENDPOINT = "us-speech.googleapis.com";
export const STT_MODEL = "chirp_3";
/**
 * chirp_3 language codes (docs.cloud.google.com/speech-to-text/v2/docs/chirp_3-model; th-TH and id-ID
 * are Preview there, the rest GA). Spanish uses es-US (the Americas' Spanish; es-ES is also offered).
 */
export const STT_LANGUAGE_CODES: Record<VoiceLang, string> = {
  en: "en-US", vi: "vi-VN", ja: "ja-JP", ko: "ko-KR", zh: "cmn-Hans-CN", th: "th-TH", id: "id-ID", es: "es-US", fr: "fr-FR", de: "de-DE",
};
/** chirp_3's language-agnostic mode: the model identifies the most prevalent spoken language. */
export const STT_AUTO_LANGUAGE = "auto";

export type SttLanguageMode = "auto" | "fixed";

/** VOICE_STT_LANGUAGE: "fixed" forces the widget's UI language; anything else is automatic detection. */
export function sttLanguageMode(env: Env = process.env): SttLanguageMode {
  return env.VOICE_STT_LANGUAGE?.trim().toLowerCase() === "fixed" ? "fixed" : "auto";
}
/** Generous: the first call after a cold start also creates the gRPC channel and fetches an ADC token (smoke test: ~4 s STT, ~9.7 s TTS cold; 0.2–2 s warm). */
export const STT_TIMEOUT_MS = 20_000;
export const TTS_TIMEOUT_MS = 20_000;

/** Longest reply text spoken in one request (characters = Unicode code points). */
export const MAX_TTS_CHARS = 400;
/** Longest transcript returned (a 15 s clip is far shorter). */
export const MAX_TRANSCRIPT_CHARS = 1_000;

/**
 * Languages /api/voice/tts accepts: every language with a Google voice (server/voice/voices.ts). Any other
 * language has no audio: the widget shows the text only.
 */
export type TtsLang = GoogleTtsLang;
export const TTS_LANGS: readonly TtsLang[] = Object.keys(GOOGLE_TTS_VOICES) as TtsLang[];
export function isTtsLang(v: unknown): v is TtsLang {
  return hasGoogleTtsVoice(v);
}

/** Google TTS locale per language (es-US like the mic; cmn-CN is Google's Mandarin TTS locale). */
export const TTS_LOCALES = Object.fromEntries(TTS_LANGS.map((l) => [l, GOOGLE_TTS_VOICES[l].locale])) as Record<TtsLang, string>;

/** The widget languages' default voices (Chirp 3 HD Charon) and fallbacks, from the table in voices.ts. */
export const DEFAULT_TTS_VOICES = Object.fromEntries(VOICE_LANGS.map((l) => [l, GOOGLE_TTS_VOICES[l].primary])) as Record<VoiceLang, string>;
export const DEFAULT_TTS_FALLBACK_VOICES = Object.fromEntries(VOICE_LANGS.map((l) => [l, GOOGLE_TTS_VOICES[l].fallback])) as Record<VoiceLang, string>;

export const DEFAULT_STT_DAILY_SECONDS = 3_600;
export const DEFAULT_TTS_DAILY_CHARS = 150_000;
export const DEFAULT_SESSION_MAX = 12;

export function isVoiceLang(v: unknown): v is VoiceLang {
  return typeof v === "string" && (VOICE_LANGS as readonly string[]).includes(v);
}

export function voiceEnabled(env: Env = process.env): boolean {
  return env.VOICE_ENABLED?.trim() !== "0";
}

export type VoiceMode = "mock" | "live";

export function voiceMode(env: Env = process.env): VoiceMode {
  const m = env.VOICE_MOCK?.trim();
  if (m === "1") return "mock";
  if (m === "0") return "live";
  if (env.NODE_ENV === "test") return "mock";
  return env.K_SERVICE?.trim() || env.GOOGLE_APPLICATION_CREDENTIALS?.trim() ? "live" : "mock";
}

function posInt(raw: string | undefined, d: number): number {
  if (raw === undefined || raw.trim() === "") return d;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : d;
}

export function sttDailySeconds(env: Env = process.env): number {
  return posInt(env.VOICE_STT_DAILY_SECONDS, DEFAULT_STT_DAILY_SECONDS);
}

export function ttsDailyChars(env: Env = process.env): number {
  return posInt(env.VOICE_TTS_DAILY_CHARS, DEFAULT_TTS_DAILY_CHARS);
}

export function sessionMax(kind: "stt" | "tts", env: Env = process.env): number {
  return posInt(kind === "stt" ? env.VOICE_SESSION_STT_MAX : env.VOICE_SESSION_TTS_MAX, DEFAULT_SESSION_MAX);
}

const VOICE_NAME = /^[a-z]{2,3}-[A-Z]{2}-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;

/** The language code a Google voice name starts with ("vi-VN-Chirp3-HD-Charon" → "vi-VN"). */
export function voiceLanguageCode(voice: string): string {
  return voice.split("-").slice(0, 2).join("-");
}

function voiceFor(raw: string | undefined, lang: TtsLang, d: string): string {
  const v = raw?.trim();
  if (!v) return d;
  if (!VOICE_NAME.test(v) || voiceLanguageCode(v) !== TTS_LOCALES[lang]) throw new Error(`voice "${v}" is not a ${TTS_LOCALES[lang]} Google TTS voice name`);
  return v;
}

/** Primary then fallback voice for `lang` (fallback omitted when "off" or when the locale has a single voice). */
export function ttsVoices(lang: TtsLang, env: Env = process.env): string[] {
  const suffix = lang.toUpperCase();
  const table = GOOGLE_TTS_VOICES[lang];
  const primary = voiceFor(env[`VOICE_TTS_VOICE_${suffix}`], lang, table.primary);
  const fbRaw = env[`VOICE_TTS_FALLBACK_VOICE_${suffix}`]?.trim();
  if (fbRaw?.toLowerCase() === "off") return [primary];
  const fb = "fallback" in table ? table.fallback : undefined;
  if (!fbRaw && !fb) return [primary];
  const fallback = voiceFor(fbRaw, lang, fb ?? primary);
  return fallback === primary ? [primary] : [primary, fallback];
}

/** Characters as Google bills them (code points, spaces included). */
export function charCount(text: string): number {
  return [...text].length;
}

export function voiceLogEnabled(env: Env = process.env): boolean {
  return env.VOICE_LOG?.trim() !== "0" && env.NODE_ENV !== "test";
}

/**
 * Voice server configuration (owner: A13, ADR-052 as revised 2026-10-26: Supertonic 3 runs in the
 * shopper's browser; the server does Speech-to-Text for both languages and Google Cloud TTS as the
 * server voice for both languages).
 *
 *   VOICE_ENABLED=0               both routes answer 503 voice_unavailable (kill switch)
 *   VOICE_MOCK=1 | 0              force mock (canned transcript, sine-tone WAV) or live Google calls.
 *                                 Unset: mock under NODE_ENV=test or when no Google credentials are
 *                                 evident (not on Cloud Run and no GOOGLE_APPLICATION_CREDENTIALS);
 *                                 live on Cloud Run (K_SERVICE is set there).
 *   GOOGLE_CLOUD_PROJECT          project for the STT recognizer path (else resolved through ADC)
 *   VOICE_TTS_VOICE_EN / _VI      Google TTS voice (default en-US-Chirp3-HD-Charon / vi-VN-Chirp3-HD-Charon)
 *   VOICE_TTS_FALLBACK_VOICE_EN / _VI  voice tried once when the primary call fails (default Neural2-D,
 *                                 male like the mascot); "off" disables the fallback. Setting the primary
 *                                 to a Neural2 voice is how to switch tiers once the Chirp 3 HD free
 *                                 tier is used up.
 *   VOICE_STT_DAILY_SECONDS       daily Speech-to-Text cap in billed audio seconds (default 3600 = 60 min)
 *   VOICE_TTS_DAILY_CHARS         daily Google TTS cap in characters (default 150000)
 *   VOICE_SESSION_STT_MAX / _TTS_MAX   per widget session (default 12 each)
 *   VOICE_LOG=0                   silence the one metrics line per request (it never holds text or audio)
 *
 * Server-side Supertonic 3 (ADR-057 spike; lib/voice/supertonic/engine.ts):
 *   VOICE_SERVER_SUPERTONIC=on|off      default off: /api/voice/tts uses Google (or mock) as before
 *   VOICE_SUPERTONIC_THREADS            onnxruntime intra-op threads (default 1; set to the vCPU count)
 *   VOICE_SUPERTONIC_QUEUE_MAX          most requests ahead (running + waiting) a newcomer will wait behind
 *                                       (default 2); more → Google. 0 = only when the engine is idle
 *   VOICE_SUPERTONIC_SENTENCE_BUDGET_MS per-sentence budget incl. queue wait (default 4000); beyond → Google
 *   VOICE_SUPERTONIC_STEPS              denoising steps (default 5)
 *   VOICE_SUPERTONIC_DAILY_SYNTHESES    sentences per UTC day on `voice-supertonic-<day>` (default 400)
 *   VOICE_SUPERTONIC_DIR                weights folder (default <cwd>/public/voice/supertonic/aafc6e32)
 *   VOICE_SPIKE=1                       honour `x-voice-engine-force` and skip per-IP/session limits for
 *                                       requests with `Authorization: Bearer $CRON_SECRET` (spike only)
 *   TTS languages: Supertonic's 31 (lib/voice/supertonic/inference.ts); Google voices for languages other
 *   than en/vi are `<locale>-Chirp3-HD-Charon` (VOICE_TTS_VOICE_<LANG> overrides; availability per locale
 *   not verified).
 */
import type { Env } from "@/lib/store/config";
import { isSupertonicLang, SUPERTONIC_LANGS, type SupertonicLang } from "./supertonic/inference";

export type VoiceLang = "en" | "vi";
export const VOICE_LANGS: readonly VoiceLang[] = ["en", "vi"];

export const STT_LOCATION = "us";
export const STT_ENDPOINT = "us-speech.googleapis.com";
export const STT_MODEL = "chirp_3";
export const STT_LANGUAGE_CODES: Record<VoiceLang, string> = { en: "en-US", vi: "vi-VN" };
/** Generous: the first call after a cold start also creates the gRPC channel and fetches an ADC token (smoke test: ~4 s STT, ~9.7 s TTS cold; 0.2–2 s warm). */
export const STT_TIMEOUT_MS = 20_000;
export const TTS_TIMEOUT_MS = 20_000;

/** Longest reply text spoken in one request (characters = Unicode code points). */
export const MAX_TTS_CHARS = 400;
/** Longest transcript returned (a 15 s clip is far shorter). */
export const MAX_TRANSCRIPT_CHARS = 1_000;

/** Languages /api/voice/tts accepts: Supertonic 3's 31 (Google serves them too, as fallback). */
export type TtsLang = SupertonicLang;
export const TTS_LANGS: readonly TtsLang[] = SUPERTONIC_LANGS;
export function isTtsLang(v: unknown): v is TtsLang {
  return isSupertonicLang(v);
}

/** Google TTS locale per language. */
export const TTS_LOCALES: Record<TtsLang, string> = {
  en: "en-US", ko: "ko-KR", ja: "ja-JP", ar: "ar-XA", bg: "bg-BG", cs: "cs-CZ", da: "da-DK", de: "de-DE",
  el: "el-GR", es: "es-ES", et: "et-EE", fi: "fi-FI", fr: "fr-FR", hi: "hi-IN", hr: "hr-HR", hu: "hu-HU",
  id: "id-ID", it: "it-IT", lt: "lt-LT", lv: "lv-LV", nl: "nl-NL", pl: "pl-PL", pt: "pt-BR", ro: "ro-RO",
  ru: "ru-RU", sk: "sk-SK", sl: "sl-SI", sv: "sv-SE", tr: "tr-TR", uk: "uk-UA", vi: "vi-VN",
};

export const DEFAULT_TTS_VOICES: Record<VoiceLang, string> = { en: "en-US-Chirp3-HD-Charon", vi: "vi-VN-Chirp3-HD-Charon" };
export const DEFAULT_TTS_FALLBACK_VOICES: Record<VoiceLang, string> = { en: "en-US-Neural2-D", vi: "vi-VN-Neural2-D" };

export const DEFAULT_STT_DAILY_SECONDS = 3_600;
export const DEFAULT_TTS_DAILY_CHARS = 150_000;
export const DEFAULT_SESSION_MAX = 12;

export function isVoiceLang(v: unknown): v is VoiceLang {
  return v === "en" || v === "vi";
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

/** Primary then fallback voice for `lang` (fallback omitted when "off"; none by default beyond en/vi). */
export function ttsVoices(lang: TtsLang, env: Env = process.env): string[] {
  const suffix = lang.toUpperCase();
  const primary = voiceFor(env[`VOICE_TTS_VOICE_${suffix}`], lang, isVoiceLang(lang) ? DEFAULT_TTS_VOICES[lang] : `${TTS_LOCALES[lang]}-Chirp3-HD-Charon`);
  const fbRaw = env[`VOICE_TTS_FALLBACK_VOICE_${suffix}`]?.trim();
  if (fbRaw?.toLowerCase() === "off") return [primary];
  if (!fbRaw && !isVoiceLang(lang)) return [primary];
  const fallback = voiceFor(fbRaw, lang, isVoiceLang(lang) ? DEFAULT_TTS_FALLBACK_VOICES[lang] : primary);
  return fallback === primary ? [primary] : [primary, fallback];
}

// ---- server-side Supertonic (ADR-057) -------------------------------------------------------------

export const DEFAULT_SUPERTONIC_DAILY = 400;

export function supertonicServerEnabled(env: Env = process.env): boolean {
  return env.VOICE_SERVER_SUPERTONIC?.trim().toLowerCase() === "on";
}

function bounded(raw: string | undefined, d: number, min: number, max: number): number {
  const n = posInt(raw, d);
  return Math.min(max, Math.max(min, n));
}

export function supertonicSettings(env: Env = process.env) {
  return {
    threads: bounded(env.VOICE_SUPERTONIC_THREADS, 1, 1, 8),
    queueMax: bounded(env.VOICE_SUPERTONIC_QUEUE_MAX, 2, 0, 20),
    sentenceBudgetMs: bounded(env.VOICE_SUPERTONIC_SENTENCE_BUDGET_MS, 4000, 250, 60_000),
    steps: bounded(env.VOICE_SUPERTONIC_STEPS, 5, 1, 16),
  };
}

export function supertonicDailySyntheses(env: Env = process.env): number {
  return posInt(env.VOICE_SUPERTONIC_DAILY_SYNTHESES, DEFAULT_SUPERTONIC_DAILY);
}

export function voiceSpikeEnabled(env: Env = process.env): boolean {
  return env.VOICE_SPIKE?.trim() === "1";
}

/** Characters as Google bills them (code points, spaces included). */
export function charCount(text: string): number {
  return [...text].length;
}

export function voiceLogEnabled(env: Env = process.env): boolean {
  return env.VOICE_LOG?.trim() !== "0" && env.NODE_ENV !== "test";
}

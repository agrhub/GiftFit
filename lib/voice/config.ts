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
 */
import type { Env } from "@/lib/store/config";

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

function voiceFor(raw: string | undefined, lang: VoiceLang, d: string): string {
  const v = raw?.trim();
  if (!v) return d;
  if (!VOICE_NAME.test(v) || voiceLanguageCode(v) !== STT_LANGUAGE_CODES[lang]) throw new Error(`voice "${v}" is not a ${STT_LANGUAGE_CODES[lang]} Google TTS voice name`);
  return v;
}

/** Primary then fallback voice for `lang` (fallback omitted when "off"). */
export function ttsVoices(lang: VoiceLang, env: Env = process.env): string[] {
  const suffix = lang.toUpperCase();
  const primary = voiceFor(env[`VOICE_TTS_VOICE_${suffix}`], lang, DEFAULT_TTS_VOICES[lang]);
  const fbRaw = env[`VOICE_TTS_FALLBACK_VOICE_${suffix}`]?.trim();
  if (fbRaw?.toLowerCase() === "off") return [primary];
  const fallback = voiceFor(fbRaw, lang, DEFAULT_TTS_FALLBACK_VOICES[lang]);
  return fallback === primary ? [primary] : [primary, fallback];
}

/** Characters as Google bills them (code points, spaces included). */
export function charCount(text: string): number {
  return [...text].length;
}

export function voiceLogEnabled(env: Env = process.env): boolean {
  return env.VOICE_LOG?.trim() !== "0" && env.NODE_ENV !== "test";
}

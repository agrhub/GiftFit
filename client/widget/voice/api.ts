/**
 * Calls to GiftFit's own voice routes (owner of the routes: A13; client: A4, P8.3). No credentials
 * in the browser: the server talks to Google with its service account.
 *
 *   POST /api/voice/stt   raw MediaRecorder audio, `x-voice-lang: <widget locale>` → { text, lang, detectedLang? }
 *                         | { error }  (detectedLang: the spoken language chirp_3 identified, any language)
 *   POST /api/voice/tts   { text (≤ 400), lang: any language with a Google voice } → audio bytes +
 *                         `x-voice-engine` (google | mock) | JSON error
 *
 * Both carry `x-voice-session` (a random id per page session, see prefs.ts) for the per-session caps.
 */
import { baseLanguage, isLocale, type Locale } from "@/server/i18n";
import { TTS_MAX_CHARS } from "./text";

export const MAX_CLIP_BYTES = 1_000_000;

export class VoiceHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
  ) {
    super(`voice ${status}${code ? ` ${code}` : ""}`);
    this.name = "VoiceHttpError";
  }
}

async function errorFrom(res: Response): Promise<VoiceHttpError> {
  let code: string | undefined;
  try {
    const j = (await res.json()) as { error?: unknown };
    if (typeof j.error === "string") code = j.error.slice(0, 64);
  } catch {
    /* not JSON */
  }
  return new VoiceHttpError(res.status, code);
}

export interface VoiceApiOptions {
  fetchImpl?: typeof fetch;
  sessionId: string;
  signal?: AbortSignal;
}

export async function transcribe(clip: Blob, lang: Locale, o: VoiceApiOptions): Promise<{ text: string; lang: Locale; detected?: string }> {
  if (clip.size > MAX_CLIP_BYTES) throw new VoiceHttpError(413, "too_large");
  const res = await (o.fetchImpl ?? fetch)("/api/voice/stt", {
    method: "POST",
    headers: { "Content-Type": clip.type || "application/octet-stream", "x-voice-lang": lang, "x-voice-session": o.sessionId },
    body: clip,
    cache: "no-store",
    signal: o.signal,
  });
  if (!res.ok) throw await errorFrom(res);
  const j = (await res.json()) as { text?: unknown; lang?: unknown; detectedLang?: unknown; error?: unknown };
  if (typeof j.error === "string") throw new VoiceHttpError(res.status, j.error);
  const detected = baseLanguage(j.detectedLang);
  return { text: typeof j.text === "string" ? j.text.trim() : "", lang: isLocale(j.lang) ? j.lang : lang, ...(detected ? { detected } : {}) };
}

export type ServerEngine = "google" | "mock";

export async function synthesize(text: string, lang: string, o: VoiceApiOptions): Promise<{ bytes: ArrayBuffer; engine: ServerEngine }> {
  const res = await (o.fetchImpl ?? fetch)("/api/voice/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-voice-session": o.sessionId },
    body: JSON.stringify({ text: text.slice(0, TTS_MAX_CHARS), lang }),
    cache: "no-store",
    signal: o.signal,
  });
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok || type.includes("application/json")) throw res.ok ? new VoiceHttpError(503, "no_audio") : await errorFrom(res);
  const e = res.headers.get("x-voice-engine");
  const engine: ServerEngine = e === "mock" ? "mock" : "google";
  return { bytes: await res.arrayBuffer(), engine };
}

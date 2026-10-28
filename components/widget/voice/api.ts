/**
 * Calls to GiftFit's own voice routes (owner of the routes: A13; client: A4, P8.3). No credentials
 * in the browser: the server talks to Google with its service account.
 *
 *   POST /api/voice/stt   raw MediaRecorder audio, `x-voice-lang: en|vi` → { text, lang } | { error }
 *   POST /api/voice/tts   { text (≤ 400), lang } → audio bytes + `x-voice-engine` (supertonic-server |
 *                         google | mock) | JSON error
 *
 * Both carry `x-voice-session` (a random id per page session, see prefs.ts) for the per-session caps.
 */
import type { Locale } from "@/lib/i18n";
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

export async function transcribe(clip: Blob, lang: Locale, o: VoiceApiOptions): Promise<{ text: string; lang: Locale }> {
  if (clip.size > MAX_CLIP_BYTES) throw new VoiceHttpError(413, "too_large");
  const res = await (o.fetchImpl ?? fetch)("/api/voice/stt", {
    method: "POST",
    headers: { "Content-Type": clip.type || "application/octet-stream", "x-voice-lang": lang, "x-voice-session": o.sessionId },
    body: clip,
    cache: "no-store",
    signal: o.signal,
  });
  if (!res.ok) throw await errorFrom(res);
  const j = (await res.json()) as { text?: unknown; lang?: unknown; error?: unknown };
  if (typeof j.error === "string") throw new VoiceHttpError(res.status, j.error);
  return { text: typeof j.text === "string" ? j.text.trim() : "", lang: j.lang === "vi" ? "vi" : j.lang === "en" ? "en" : lang };
}

export type ServerEngine = "supertonic" | "google" | "mock";

export async function synthesize(text: string, lang: Locale, o: VoiceApiOptions): Promise<{ bytes: ArrayBuffer; engine: ServerEngine }> {
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
  // `supertonic-server` = Supertonic 3 on GiftFit's server (A13, ADR-057); labelled like "supertonic".
  const engine: ServerEngine = e === "supertonic" || e === "supertonic-server" ? "supertonic" : e === "mock" ? "mock" : "google";
  return { bytes: await res.arrayBuffer(), engine };
}

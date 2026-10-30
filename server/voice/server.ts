/**
 * Shared parts of the voice handlers (owner: A13, ADR-052): deps, mock engines, error helpers. The
 * handlers are server/voice/stt.ts (JSON only) and server/voice/tts.ts (audio bytes). Contract for the widget (A4):
 *
 *   POST /api/voice/stt   body: the raw clip (Content-Type audio/webm;codecs=opus | audio/ogg | audio/mp4),
 *                         headers x-voice-lang: a widget locale (en vi ja ko zh th id es fr de),
 *                         x-voice-session: <uuid>; ≤ 1 MiB, ≤ 15 s. chirp_3 identifies the spoken
 *                         language itself (VOICE_STT_LANGUAGE=fixed: the header's language only).
 *                         200 {text, lang (the header's), detectedLang? (base code chirp_3 reported, any language)} | 400 {error: bad_audio|too_long|too_large|bad_lang|bad_session}
 *                         | 429 {error: rate_limited|session_cap|daily_cap} | 503 {error: voice_unavailable}
 *   POST /api/voice/tts   JSON {text ≤ 400 chars, lang: any language with a Google voice (server/voice/voices.ts)},
 *                         header x-voice-session: <uuid>.
 *                         200 audio bytes + x-voice-engine: google (audio/mpeg) | mock (audio/wav)
 *                         | 400 {error: bad_request|bad_lang|text_too_long|bad_session} | 429 as above | 503 as above
 *
 * Order: per-IP rate limit → session id → input checks → caps (session slot + daily amount, fail
 * closed) → engine → settle/refund. JSON goes through giverJson (shopper-facing, no recipient data).
 * Privacy: the clip lives in memory for the one call; neither audio nor text is ever logged or stored.
 * The single metrics line carries only route, engine, language, sizes, timings and an outcome code.
 */
import type { DailyCounterStore } from "@/server/store/daily-counter";
import type { Env } from "@/server/store/config";
import type { VoiceCapDecision } from "./caps";
import { voiceLogEnabled, voiceMode } from "./config";
import { googleSttEngine, googleTtsEngine, speechClient, ttsClient, type SttEngine, type TtsEngine } from "./google";
import { MOCK_TRANSCRIPTS, mockToneSeconds, mockToneWav } from "./mock";

export const VOICE_LANG_HEADER = "x-voice-lang";
export const VOICE_ENGINE_HEADER = "x-voice-engine";

export interface VoiceServerDeps {
  env: Env;
  stt: () => SttEngine;
  tts: () => TtsEngine;
  /** Durable counters (undefined = the process default for the environment). */
  counters?: DailyCounterStore;
  now: () => number;
  /** Metrics sink; receives no text or audio. */
  log: (line: string) => void;
}

export const mockSttEngine: SttEngine = {
  name: "mock",
  async transcribe({ lang }) {
    return { text: MOCK_TRANSCRIPTS[lang], billedSeconds: null };
  },
};

export const mockTtsEngine: TtsEngine = {
  name: "mock",
  async synthesize({ text }) {
    return { audio: mockToneWav(mockToneSeconds(text)), contentType: "audio/wav", voice: "mock-tone" };
  },
};

export function defaultVoiceDeps(env: Env = process.env): VoiceServerDeps {
  const live = () => voiceMode(env) === "live";
  return {
    env,
    stt: () => (live() ? googleSttEngine(speechClient, env) : mockSttEngine),
    tts: () => (live() ? googleTtsEngine(ttsClient, env) : mockTtsEngine),
    now: Date.now,
    log: (line) => {
      if (voiceLogEnabled(env)) console.info(line);
    },
  };
}

/** Status and error code for a refused cap decision: fail closed (503) when the counter is unreachable. */
export function capFailure(d: Exclude<VoiceCapDecision, { ok: true }>): { status: 429 | 503; error: string } {
  return d.reason === "counter_unavailable" ? { status: 503, error: "voice_unavailable" } : { status: 429, error: d.reason };
}

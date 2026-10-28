/**
 * Shared parts of the voice handlers (owner: A13, ADR-052): deps, mock engines, error helpers. The
 * handlers are lib/voice/stt.ts (JSON only) and lib/voice/tts.ts (audio bytes). Contract for the widget (A4):
 *
 *   POST /api/voice/stt   body: the raw clip (Content-Type audio/webm;codecs=opus | audio/ogg | audio/mp4),
 *                         headers x-voice-lang: en|vi, x-voice-session: <uuid>; ≤ 1 MiB, ≤ 15 s.
 *                         200 {text, lang} | 400 {error: bad_audio|too_long|too_large|bad_lang|bad_session}
 *                         | 429 {error: rate_limited|session_cap|daily_cap} | 503 {error: voice_unavailable}
 *   POST /api/voice/tts   JSON {text ≤ 400 chars, lang: one of Supertonic's 31}, header x-voice-session: <uuid>.
 *                         200 audio bytes + x-voice-engine: supertonic-server (audio/wav, 22.05 kHz; when
 *                         VOICE_SERVER_SUPERTONIC=on and the engine is ready, not overloaded and in budget)
 *                         | google (audio/mpeg) | mock (audio/wav)
 *                         | 400 {error: bad_request|bad_lang|text_too_long|bad_session} | 429 as above | 503 as above
 *
 * Order: per-IP rate limit → session id → input checks → caps (session slot + daily amount, fail
 * closed) → engine → settle/refund. JSON goes through giverJson (shopper-facing, no recipient data).
 * Privacy: the clip lives in memory for the one call; neither audio nor text is ever logged or stored.
 * The single metrics line carries only route, engine, language, sizes, timings and an outcome code.
 */
import type { DailyCounterStore } from "@/lib/store/daily-counter";
import type { Env } from "@/lib/store/config";
import type { VoiceCapDecision } from "./caps";
import { supertonicServerEnabled, supertonicSettings, voiceLogEnabled, voiceMode, voiceSpikeEnabled } from "./config";
import { googleSttEngine, googleTtsEngine, speechClient, ttsClient, type SttEngine, type TtsEngine } from "./google";
import { MOCK_TRANSCRIPTS, mockToneSeconds, mockToneWav } from "./mock";
import { supertonicServer, type SupertonicServer } from "./supertonic/engine";

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
  /**
   * The server Supertonic engine (ADR-057), or null when it is off. Only created (never loaded) here;
   * it loads on first voice use. Present when VOICE_SERVER_SUPERTONIC=on or VOICE_SPIKE=1.
   */
  supertonic?: () => SupertonicServer | null;
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
    supertonic: () =>
      supertonicServerEnabled(env) || voiceSpikeEnabled(env)
        ? supertonicServer({ ...supertonicSettings(env), log: (line) => voiceLogEnabled(env) && console.info(line) })
        : null,
  };
}

/** Status and error code for a refused cap decision: fail closed (503) when the counter is unreachable. */
export function capFailure(d: Exclude<VoiceCapDecision, { ok: true }>): { status: 429 | 503; error: string } {
  return d.reason === "counter_unavailable" ? { status: 503, error: "voice_unavailable" } : { status: 429, error: d.reason };
}

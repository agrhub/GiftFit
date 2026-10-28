/**
 * POST /api/voice/tts handler (owner: A13, ADR-052/057); contract in lib/voice/server.ts. Reply text →
 * audio. The success response is audio bytes (route manifest flag `audioResponse`); every JSON error
 * goes through giverJson. The text is never logged or stored.
 *
 * Engines, per request (the widget sends one chunk per request, the reply's first sentence first):
 *   1. supertonic-server (VOICE_SERVER_SUPERTONIC=on): the chunk is split into sentences and synthesised
 *      one sentence after another on the server engine, returned as one 22.05 kHz WAV. Skipped (→ Google)
 *      while the model is cold or loading (the request starts the load), when more than
 *      VOICE_SUPERTONIC_QUEUE_MAX requests are ahead (running + waiting), when the day's `voice-supertonic-<day>` cap is reached or its
 *      counter is unreachable, or when a sentence overruns VOICE_SUPERTONIC_SENTENCE_BUDGET_MS (the
 *      synthesis is aborted between model runs and the whole chunk goes to Google).
 *   2. google (or mock): as before, on the `voice-tts-<day>` character cap.
 * One per-session slot per request either way.
 *
 * Spike mode (VOICE_SPIKE=1 on the service AND `Authorization: Bearer $CRON_SECRET`): no per-IP or
 * per-session limits, and `x-voice-engine-force: supertonic|google` pins the engine (forced Supertonic
 * waits for the model and has no budget, so the real latency is measured). Timing headers
 * (x-voice-queue-ms, x-voice-synth-ms, x-voice-audio-ms, x-voice-sentences) carry numbers only.
 */
import { giverJson } from "@/lib/privacy/giver-guard";
import { giverRateLimit } from "@/lib/privacy/rate-limit";
import { safeEqual } from "@/lib/privacy/tokens";
import { reserveDaily, reserveSessionSlot } from "./caps";
import { charCount, isTtsLang, MAX_TTS_CHARS, supertonicServerEnabled, supertonicSettings, voiceEnabled, voiceSpikeEnabled, type TtsLang } from "./config";
import { capFailure, defaultVoiceDeps, VOICE_ENGINE_HEADER, type VoiceServerDeps } from "./server";
import { voiceSessionKey } from "./session";
import { splitSentences, SynthAbortedError } from "./supertonic/inference";
import { speechWav } from "./wav";

const MAX_TTS_BODY_BYTES = 8 * 1024;
export const ENGINE_FORCE_HEADER = "x-voice-engine-force";
/** How long a forced (spike) request waits for the model to load. */
const SPIKE_LOAD_WAIT_MS = 180_000;

async function readTtsBody(req: Request): Promise<{ ok: true; text: string; lang: TtsLang } | { ok: false; error: string }> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_TTS_BODY_BYTES) return { ok: false, error: "text_too_long" };
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return { ok: false, error: "bad_request" };
  }
  if (raw.length > MAX_TTS_BODY_BYTES) return { ok: false, error: "text_too_long" };
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, error: "bad_request" };
  }
  const b = body as { text?: unknown; lang?: unknown };
  if (!b || typeof b !== "object" || typeof b.text !== "string") return { ok: false, error: "bad_request" };
  if (!isTtsLang(b.lang)) return { ok: false, error: "bad_lang" };
  const text = b.text.replace(/\s+/g, " ").trim();
  if (!text) return { ok: false, error: "bad_request" };
  if (charCount(text) > MAX_TTS_CHARS) return { ok: false, error: "text_too_long" };
  return { ok: true, text, lang: b.lang };
}

/** JSON error through the giver guard (shopper-facing route). */
const fail = (status: number, error: string) => giverJson({ error }, { status });

/** Spike requests: VOICE_SPIKE=1 and the cron bearer secret. */
function spikeRequest(req: Request, env: Record<string, string | undefined>): boolean {
  if (!voiceSpikeEnabled(env)) return false;
  const secret = env.CRON_SECRET?.trim();
  return !!secret && safeEqual(req.headers.get("authorization") ?? "", `Bearer ${secret}`);
}

function audioResponse(bytes: Uint8Array, contentType: string, engine: string, extra: Record<string, string> = {}): Response {
  // Audio bytes (manifest flag `audioResponse`): synthesized from the shopper-facing reply text only.
  return new Response(bytes as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      [VOICE_ENGINE_HEADER]: engine,
      ...extra,
    },
  });
}

type SupertonicOutcome = { ok: true; response: Response } | { ok: false; reason: "off" | "cold" | "failed" | "queue" | "cap" | "budget" | "error" };

async function trySupertonic(text: string, lang: TtsLang, deps: VoiceServerDeps, t0: number, forced: boolean): Promise<SupertonicOutcome> {
  const engine = deps.supertonic?.() ?? null;
  if (!engine) return { ok: false, reason: "off" };
  const settings = supertonicSettings(deps.env);
  engine.ensureLoaded();
  if (forced) {
    if (!(await engine.waitReady(SPIKE_LOAD_WAIT_MS))) return { ok: false, reason: "failed" };
  } else if (engine.state !== "ready") {
    return { ok: false, reason: engine.state === "failed" ? "failed" : "cold" };
  } else if (engine.pending() > settings.queueMax) {
    return { ok: false, reason: "queue" };
  }
  const sentences = splitSentences(text, lang);
  if (!sentences.length) return { ok: false, reason: "error" };
  const day = await reserveDaily("supertonic", sentences.length, { env: deps.env, store: deps.counters, now: t0 });
  if (!day.ok) return { ok: false, reason: "cap" };
  try {
    const r = await engine.synthesize(sentences, lang, { budgetMs: forced ? 0 : settings.sentenceBudgetMs });
    await day.settle(sentences.length);
    const { wav, durationMs } = speechWav(r.pcm, r.sampleRate);
    return {
      ok: true,
      response: audioResponse(wav, "audio/wav", "supertonic-server", {
        "x-voice-queue-ms": String(Math.round(r.queueMs)),
        "x-voice-synth-ms": String(Math.round(r.synthMs)),
        "x-voice-audio-ms": String(durationMs),
        "x-voice-sentences": String(r.sentences),
      }),
    };
  } catch (err) {
    // Only finished syntheses count against the day's Supertonic cap.
    await day.refund();
    return { ok: false, reason: err instanceof SynthAbortedError ? "budget" : "error" };
  }
}

export async function handleTts(req: Request, deps: VoiceServerDeps = defaultVoiceDeps()): Promise<Response> {
  const t0 = deps.now();
  const spike = spikeRequest(req, deps.env);
  if (!spike) {
    const limited = await giverRateLimit(req, "voice_tts", t0);
    if (limited) return limited;
  }
  if (!voiceEnabled(deps.env)) return fail(503, "voice_unavailable");
  const session = voiceSessionKey(req, deps.env);
  if (!session) return fail(400, "bad_session");
  const body = await readTtsBody(req);
  if (!body.ok) return fail(400, body.error);
  const chars = charCount(body.text);
  const force = spike ? req.headers.get(ENGINE_FORCE_HEADER)?.trim().toLowerCase() : undefined;

  const slot = spike ? null : await reserveSessionSlot("tts", session, { env: deps.env, store: deps.counters });
  if (slot && !slot.ok) {
    deps.log(`[voice] tts lang=${body.lang} chars=${chars} outcome=${slot.reason}`);
    return fail(capFailure(slot).status, capFailure(slot).error);
  }

  // 1. Server Supertonic (when on, or forced by the spike).
  if (force === "supertonic" || (force !== "google" && supertonicServerEnabled(deps.env))) {
    const st = await trySupertonic(body.text, body.lang, deps, t0, force === "supertonic");
    if (st.ok) {
      deps.log(`[voice] tts engine=supertonic-server lang=${body.lang} chars=${chars} ms=${deps.now() - t0} outcome=ok`);
      return st.response;
    }
    deps.log(`[voice] tts supertonic-server skipped reason=${st.reason} lang=${body.lang} chars=${chars}`);
    if (force === "supertonic") {
      await slot?.release();
      return fail(503, "voice_unavailable");
    }
  }

  // 2. Google (or mock).
  const day = await reserveDaily("tts", chars, { env: deps.env, store: deps.counters, now: t0 });
  if (!day.ok) {
    await slot?.release();
    deps.log(`[voice] tts lang=${body.lang} chars=${chars} outcome=${day.reason}`);
    return fail(capFailure(day).status, capFailure(day).error);
  }
  const engine = deps.tts();
  try {
    const r = await engine.synthesize({ text: body.text, lang: body.lang });
    await day.settle(chars);
    deps.log(`[voice] tts engine=${engine.name} voice=${r.voice} lang=${body.lang} chars=${chars} bytes=${r.audio.byteLength} ms=${deps.now() - t0} outcome=ok`);
    return audioResponse(r.audio, r.contentType, engine.name);
  } catch (e) {
    await day.refund();
    await slot?.release();
    deps.log(`[voice] tts engine=${engine.name} lang=${body.lang} chars=${chars} ms=${deps.now() - t0} outcome=error code=${(e as { code?: string }).code ?? "unknown"}`);
    return fail(503, "voice_unavailable");
  }
}

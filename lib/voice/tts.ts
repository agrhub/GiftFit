/**
 * POST /api/voice/tts handler (owner: A13, ADR-052/059); contract in lib/voice/server.ts. Reply text →
 * audio from Google Cloud Text-to-Speech (or the mock tone), the only server voice (ADR-059). The
 * success response is audio bytes (route manifest flag `audioResponse`); every JSON error goes through
 * giverJson. The text is never logged or stored.
 *
 * Order: per-IP rate limit → session id → input checks → one per-session slot → the day's
 * `voice-tts-<day>` character cap → Google (or mock) → settle, or refund both on failure.
 */
import { giverJson } from "@/lib/privacy/giver-guard";
import { giverRateLimit } from "@/lib/privacy/rate-limit";
import { reserveDaily, reserveSessionSlot } from "./caps";
import { charCount, isTtsLang, MAX_TTS_CHARS, voiceEnabled, type TtsLang } from "./config";
import { capFailure, defaultVoiceDeps, VOICE_ENGINE_HEADER, type VoiceServerDeps } from "./server";
import { voiceSessionKey } from "./session";

const MAX_TTS_BODY_BYTES = 8 * 1024;

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

function audioResponse(bytes: Uint8Array, contentType: string, engine: string): Response {
  // Audio bytes (manifest flag `audioResponse`): synthesized from the shopper-facing reply text only.
  return new Response(bytes as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      [VOICE_ENGINE_HEADER]: engine,
    },
  });
}

export async function handleTts(req: Request, deps: VoiceServerDeps = defaultVoiceDeps()): Promise<Response> {
  const t0 = deps.now();
  const limited = await giverRateLimit(req, "voice_tts", t0);
  if (limited) return limited;
  if (!voiceEnabled(deps.env)) return fail(503, "voice_unavailable");
  const session = voiceSessionKey(req, deps.env);
  if (!session) return fail(400, "bad_session");
  const body = await readTtsBody(req);
  if (!body.ok) return fail(400, body.error);
  const chars = charCount(body.text);

  const slot = await reserveSessionSlot("tts", session, { env: deps.env, store: deps.counters });
  if (!slot.ok) {
    deps.log(`[voice] tts lang=${body.lang} chars=${chars} outcome=${slot.reason}`);
    return fail(capFailure(slot).status, capFailure(slot).error);
  }

  const day = await reserveDaily("tts", chars, { env: deps.env, store: deps.counters, now: t0 });
  if (!day.ok) {
    await slot.release();
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
    await slot.release();
    deps.log(`[voice] tts engine=${engine.name} lang=${body.lang} chars=${chars} ms=${deps.now() - t0} outcome=error code=${(e as { code?: string }).code ?? "unknown"}`);
    return fail(503, "voice_unavailable");
  }
}

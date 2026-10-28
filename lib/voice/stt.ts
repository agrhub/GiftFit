/**
 * POST /api/voice/stt handler (owner: A13, ADR-052); contract in lib/voice/server.ts. Clip → Google
 * Speech-to-Text V2 chirp_3 (us) → {text, lang}. JSON only, through giverJson. The clip is held in
 * memory for the one call and never stored or logged.
 */
import { giverJson } from "@/lib/privacy/giver-guard";
import { giverRateLimit } from "@/lib/privacy/rate-limit";
import { checkClip, MAX_CLIP_SECONDS, readBodyLimited } from "./audio";
import { reserveVoice } from "./caps";
import { charCount, isVoiceLang, supertonicServerEnabled, voiceEnabled } from "./config";
import { capFailure, defaultVoiceDeps, VOICE_ENGINE_HEADER, VOICE_LANG_HEADER, type VoiceServerDeps } from "./server";
import { voiceSessionKey } from "./session";

/** JSON error through the giver guard (shopper-facing route). */
const fail = (status: number, error: string) => giverJson({ error }, { status });

export async function handleStt(req: Request, deps: VoiceServerDeps = defaultVoiceDeps()): Promise<Response> {
  const t0 = deps.now();
  const limited = await giverRateLimit(req, "voice_stt", t0);
  if (limited) return limited;
  if (!voiceEnabled(deps.env)) return fail(503, "voice_unavailable");
  const lang = req.headers.get(VOICE_LANG_HEADER)?.trim().toLowerCase();
  if (!isVoiceLang(lang)) return fail(400, "bad_lang");
  const session = voiceSessionKey(req, deps.env);
  if (!session) return fail(400, "bad_session");
  // First voice use warms the server Supertonic engine (ADR-057) while the shopper is still talking.
  if (supertonicServerEnabled(deps.env)) deps.supertonic?.()?.ensureLoaded();

  const body = await readBodyLimited(req);
  if (!body.ok) return fail(400, body.error);
  const clip = checkClip(req.headers.get("content-type"), body.bytes);
  if (!clip.ok) return fail(clip.status, clip.error);

  // Reserve the clip's own length (rounded up, as Google bills), or the 15 s worst case if unreadable.
  const reserveSeconds = Math.max(1, Math.ceil(clip.seconds ?? MAX_CLIP_SECONDS));
  const cap = await reserveVoice("stt", session, reserveSeconds, { env: deps.env, store: deps.counters, now: t0 });
  if (!cap.ok) {
    deps.log(`[voice] stt lang=${lang} outcome=${cap.reason}`);
    return fail(capFailure(cap).status, capFailure(cap).error);
  }
  const engine = deps.stt();
  try {
    const r = await engine.transcribe({ audio: body.bytes, lang });
    await cap.settle(r.billedSeconds ?? reserveSeconds);
    deps.log(`[voice] stt engine=${engine.name} lang=${lang} container=${clip.container} bytes=${clip.bytes} clip_s=${clip.seconds?.toFixed(1) ?? "?"} billed_s=${r.billedSeconds ?? "?"} chars=${charCount(r.text)} ms=${deps.now() - t0} outcome=ok`);
    return giverJson({ text: r.text, lang }, { headers: { [VOICE_ENGINE_HEADER]: engine.name } });
  } catch (e) {
    await cap.refund();
    deps.log(`[voice] stt engine=${engine.name} lang=${lang} ms=${deps.now() - t0} outcome=error code=${(e as { code?: string }).code ?? "unknown"}`);
    return fail(503, "voice_unavailable");
  }
}

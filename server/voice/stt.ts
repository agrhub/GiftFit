/**
 * POST /api/voice/stt handler (owner: A13, ADR-052); contract in server/voice/server.ts. Clip → Google
 * Speech-to-Text V2 chirp_3 (us, automatic language identification by default) → {text, lang, detectedLang?}. JSON only, through giverJson. The clip is held in
 * memory for the one call and never stored or logged.
 */
import { giverJson } from "@/server/privacy/giver-guard";
import { giverRateLimit } from "@/server/privacy/rate-limit";
import { checkClip, MAX_CLIP_SECONDS, readBodyLimited } from "./audio";
import { reserveVoice } from "./caps";
import { charCount, isVoiceLang, voiceEnabled } from "./config";
import { capFailure, defaultVoiceDeps, VOICE_ENGINE_HEADER, VOICE_LANG_HEADER, type VoiceServerDeps } from "./server";
import { voiceSessionKey } from "./session";

/** Whitespace between two Han, kana or CJK/full-width punctuation characters (scripts written without spaces). */
const SPACE_IN_UNSPACED = /(?<=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー々〆\u3000-\u303F\uFF00-\uFFEF])\s+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー々〆\u3000-\u303F\uFF00-\uFFEF])/gu;

/**
 * chirp_3 returns Japanese and Chinese as space-separated tokens ("母 の 誕生日 を 探し て い ます 。");
 * drop the spaces between two such characters. Spaces next to Latin text or digits ("予算 は $150") stay,
 * and Korean (spaced) and Thai are left alone.
 */
export function joinUnspaced(text: string): string {
  return text.replace(SPACE_IN_UNSPACED, "");
}

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
    deps.log(`[voice] stt engine=${engine.name} lang=${lang} detected=${r.language ?? "-"} container=${clip.container} bytes=${clip.bytes} clip_s=${clip.seconds?.toFixed(1) ?? "?"} billed_s=${r.billedSeconds ?? "?"} chars=${charCount(r.text)} ms=${deps.now() - t0} outcome=ok`);
    // `lang` echoes the widget's language; `detectedLang` is the spoken language chirp_3 reported (any language).
    const detected = r.language && /^[a-z]{2,3}$/.test(r.language) ? { detectedLang: r.language } : {};
    return giverJson({ text: joinUnspaced(r.text), lang, ...detected }, { headers: { [VOICE_ENGINE_HEADER]: engine.name } });
  } catch (e) {
    await cap.refund();
    deps.log(`[voice] stt engine=${engine.name} lang=${lang} ms=${deps.now() - t0} outcome=error code=${(e as { code?: string }).code ?? "unknown"}`);
    return fail(503, "voice_unavailable");
  }
}

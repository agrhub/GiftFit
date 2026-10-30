/**
 * POST /api/voice/tts (owner: A13, ADR-052/059): reply text (≤ 400 chars, any language with a Google voice) → MP3 from Google Cloud
 * Text-to-Speech (stock Chirp 3 HD voice, Neural2 fallback), or a mock tone WAV. The widget's only
 * voice besides the browser's own speechSynthesis. Handler and contract in
 * server/voice/tts.ts (giverJson for errors; per-IP `voice_tts` limit; per-session and daily caps).
 */
import { handleTts } from "@/server/voice/tts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request): Promise<Response> {
  return handleTts(req);
}

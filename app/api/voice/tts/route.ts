/**
 * POST /api/voice/tts (owner: A13, ADR-052): reply text (≤ 400 chars, en|vi) → MP3 from Google Cloud
 * Text-to-Speech (stock Chirp 3 HD voice, Neural2 fallback), or a mock tone WAV. The widget's primary
 * voice is Supertonic 3 in the browser; this is the server voice. Handler and contract in
 * lib/voice/tts.ts (giverJson for errors; per-IP `voice_tts` limit; per-session and daily caps).
 */
import { handleTts } from "@/lib/voice/tts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request): Promise<Response> {
  return handleTts(req);
}

/**
 * GET /api/voice/metrics (owner: A13, ADR-057): process memory and server Supertonic engine numbers for
 * the spike (scripts/voice-spike.mjs). Bearer CRON_SECRET; no text, audio or session data.
 */
import { handleVoiceMetrics } from "@/lib/voice/metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request): Response {
  return handleVoiceMetrics(req);
}

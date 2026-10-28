/**
 * POST /api/voice/stt (owner: A13, ADR-052): push-to-talk clip → transcript via Google Speech-to-Text
 * V2 chirp_3 (us, automatic language identification). Shopper-facing; handler and contract in
 * lib/voice/stt.ts (giverJson; per-IP `voice_stt` limit; per-session and daily caps). The clip is never
 * stored or logged.
 */
import { handleStt } from "@/lib/voice/stt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request): Promise<Response> {
  return handleStt(req);
}

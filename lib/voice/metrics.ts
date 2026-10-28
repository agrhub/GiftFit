/**
 * GET /api/voice/metrics (owner: A13, ADR-057 spike; audience: internal). `Authorization: Bearer
 * $CRON_SECRET` required (503 when the secret is not configured, 401 otherwise). Returns process memory
 * (current and peak RSS), uptime and the server Supertonic engine's numbers (state, load time, queue,
 * synthesis timings, real-time factor). Never any text, audio or session data. Reading it never creates
 * or loads the engine.
 */
import { safeEqual } from "@/lib/privacy/tokens";
import { supertonicServerEnabled, voiceSpikeEnabled } from "./config";
import { existingSupertonicServer } from "./supertonic/engine";

const MB = 1024 * 1024;
const mb = (n: number) => Math.round((n / MB) * 10) / 10;

export function voiceMetricsSnapshot(env: Record<string, string | undefined> = process.env) {
  const m = process.memoryUsage();
  // resourceUsage().maxRSS is in kilobytes (peak resident set size of this process).
  const peakRssMb = Math.round((process.resourceUsage().maxRSS / 1024) * 10) / 10;
  return {
    process: { rssMb: mb(m.rss), peakRssMb, heapUsedMb: mb(m.heapUsed), heapTotalMb: mb(m.heapTotal), externalMb: mb(m.external), arrayBuffersMb: mb(m.arrayBuffers), uptimeS: Math.round(process.uptime()) },
    supertonic: { enabled: supertonicServerEnabled(env), spike: voiceSpikeEnabled(env), engine: existingSupertonicServer()?.metrics() ?? { state: "idle" as const } },
  };
}

export function handleVoiceMetrics(req: Request, env: Record<string, string | undefined> = process.env): Response {
  const headers = { "Cache-Control": "no-store" };
  const secret = env.CRON_SECRET?.trim();
  if (!secret) return Response.json({ error: "not_configured" }, { status: 503, headers });
  if (!safeEqual(req.headers.get("authorization") ?? "", `Bearer ${secret}`)) return Response.json({ error: "unauthorized" }, { status: 401, headers });
  return Response.json(voiceMetricsSnapshot(env), { headers });
}

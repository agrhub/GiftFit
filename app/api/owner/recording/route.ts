/**
 * /api/owner/recording  (audience: internal, GiftFit operator only; A16, lib/youcam/recording.ts)
 *
 *   POST   { token }  → 200 { owner: true, expiresAt, youcamPaid } + Set-Cookie gf_rec (HttpOnly, ≤ 6 h)
 *                      409 { error: "recording_off" } while YOUCAM_RECORDING is off or no token is configured
 *                      403 { error: "forbidden" } for a wrong token (constant-time check)
 *   GET              → { recording: "on"|"off", owner, youcamPaid } (+ blockers for the owner only)
 *   DELETE           → clears the cookie
 * The token is never echoed or logged. The cookie only matters while the switch stays on: turning
 * YOUCAM_RECORDING off (or rotating the token) invalidates it everywhere.
 */
import {
  clearRecordingCookie,
  isOwnerRecording,
  paidReadiness,
  RECORDING_SESSION_MS,
  recordingCookie,
  recordingEnabled,
  recordingToken,
  recordingTokenMatches,
} from "@/lib/youcam/recording";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex", ...headers } });

const isSecure = (req: Request) => new URL(req.url).protocol === "https:" || process.env.NODE_ENV === "production";

export async function GET(req: Request): Promise<Response> {
  const owner = isOwnerRecording(req);
  const paid = paidReadiness();
  return json({ recording: paid.recording, owner, youcamPaid: paid.youcamPaid, ...(owner ? { blockers: paid.blockers } : {}) });
}

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { token?: unknown } | null;
  if (!recordingEnabled()) return json({ error: "recording_off" }, 409);
  if (!recordingTokenMatches(body?.token)) return json({ error: "forbidden" }, 403);
  const now = Date.now();
  const paid = paidReadiness();
  console.info(JSON.stringify({ severity: "NOTICE", message: "youcam owner recording session started", youcamPaid: paid.youcamPaid }));
  return json(
    { owner: true, expiresAt: new Date(now + RECORDING_SESSION_MS).toISOString(), youcamPaid: paid.youcamPaid, blockers: paid.blockers },
    200,
    { "Set-Cookie": recordingCookie(recordingToken()!, { secure: isSecure(req), nowMs: now }) },
  );
}

export async function DELETE(req: Request): Promise<Response> {
  return json({ owner: false }, 200, { "Set-Cookie": clearRecordingCookie({ secure: isSecure(req) }) });
}

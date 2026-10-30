/**
 * POST /api/widget/notify (owner: A6, ADR-046): the giver leaves an e-mail address for one
 * "your Fit Report is ready" note, sent when the recipient taps Done (app/api/recipient/done).
 * Giver-facing; handler in server/widget/server.ts (giverJson; per-IP `widget_notify` limit 10/h).
 * The address is sealed at rest and deleted once the note is sent, or with the request (72 h).
 */
import { handleNotifyMe } from "@/server/widget/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request): Promise<Response> {
  return handleNotifyMe(req);
}

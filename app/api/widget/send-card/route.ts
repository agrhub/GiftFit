/**
 * POST /api/widget/send-card (owner: A6, ADR-046/047): e-mail the gift card for the giver's Fit Request.
 * Giver-facing; handler and contract in server/widget/server.ts (responses through giverJson, no address,
 * token or id in any response). Per-giver and per-IP e-mail limits; the console provider answers
 * unless EMAIL_SEND_ENABLED=1 (server/email). The address is kept sealed for the request lifetime only.
 */
import { handleSendCard } from "@/server/widget/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request): Promise<Response> {
  return handleSendCard(req);
}

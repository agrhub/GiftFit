/**
 * POST /api/youcam/webhook
 * Receives YouCam task-completion notifications (Standard Webhooks, HMAC-SHA256).
 * Bad or missing signatures get 401. A verified event wakes any in-process poller
 * (lib/youcam/webhook.ts) and is audited; polling stays the fallback.
 */
import { createDefaultAuditSink } from "@/lib/youcam/audit";
import { loadYoucamConfig } from "@/lib/youcam/config";
import { WebhookSignatureError, notifyTaskCompleted, verifyYoucamWebhook } from "@/lib/youcam/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const config = loadYoucamConfig();
  if (!config.webhookSecret) {
    return Response.json({ error: "webhook not configured" }, { status: 503 });
  }
  const raw = await req.text();
  let payload;
  try {
    payload = verifyYoucamWebhook(raw, req.headers, config.webhookSecret);
  } catch (err) {
    if (err instanceof WebhookSignatureError) {
      return Response.json({ error: "invalid signature" }, { status: 401 });
    }
    throw err;
  }
  const { task_id: taskId, task_status: status } = payload.data;
  notifyTaskCompleted(taskId, status);
  try {
    await createDefaultAuditSink(config).write({
      ts: new Date().toISOString(),
      event: "youcam.webhook",
      mode: "real",
      taskId,
      status,
      detail: { webhookId: req.headers.get("webhook-id") },
    });
  } catch (err) {
    console.error("[youcam] webhook audit failed:", (err as Error).message);
  }
  return Response.json({ ok: true });
}

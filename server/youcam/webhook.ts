/**
 * YouCam webhooks follow the Standard Webhooks spec (docs.perfectcorp.com/develop/webhook):
 * headers webhook-id / webhook-timestamp / webhook-signature ("v1,<base64 HMAC-SHA256>"),
 * signed content "{id}.{timestamp}.{raw body}", secret "whsec_<base64>" from the API console.
 * The body only says a task finished; the result is still fetched with GET /task/<slug>/<id>.
 */
import { Webhook, WebhookVerificationError } from "standardwebhooks";
import { youcamState } from "./global-state";
import type { TaskStatus } from "./types";

export interface YoucamWebhookPayload {
  created_at: number;
  data: { task_id: string; task_status: Exclude<TaskStatus, "running"> };
}

export class WebhookSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookSignatureError";
  }
}

const HEADER_NAMES = ["webhook-id", "webhook-timestamp", "webhook-signature"] as const;

/** Picks the three Standard Webhooks headers from a Headers object or a plain record. */
export function webhookHeaders(h: Headers | Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of HEADER_NAMES) {
    const v = h instanceof Headers ? h.get(name) : (h[name] ?? h[name.toLowerCase()]);
    if (v) out[name] = v;
  }
  return out;
}

/**
 * Verifies signature and timestamp (5-minute tolerance, enforced by the library) against
 * the raw request body, then validates the payload shape. Throws WebhookSignatureError.
 */
export function verifyYoucamWebhook(
  rawBody: string,
  headers: Headers | Record<string, string | undefined>,
  secret: string,
): YoucamWebhookPayload {
  const picked = webhookHeaders(headers);
  if (Object.keys(picked).length !== HEADER_NAMES.length) {
    throw new WebhookSignatureError("missing webhook-id, webhook-timestamp or webhook-signature header");
  }
  let payload: unknown;
  try {
    payload = new Webhook(secret).verify(rawBody, picked);
  } catch (err) {
    if (err instanceof WebhookVerificationError) throw new WebhookSignatureError(err.message);
    throw new WebhookSignatureError(`webhook verification failed: ${(err as Error).message}`);
  }
  const p = payload as Partial<YoucamWebhookPayload>;
  const status = p?.data?.task_status;
  if (typeof p?.data?.task_id !== "string" || (status !== "success" && status !== "error")) {
    throw new WebhookSignatureError("webhook payload is missing data.task_id or a final data.task_status");
  }
  return payload as YoucamWebhookPayload;
}

/** Signs a payload like YouCam does. Used by tests and local webhook simulation. */
export function signYoucamWebhook(secret: string, msgId: string, timestamp: Date, rawBody: string): Record<string, string> {
  return {
    "webhook-id": msgId,
    "webhook-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
    "webhook-signature": new Webhook(secret).sign(msgId, timestamp, rawBody),
  };
}

// ---------- in-process completion signals (polling stays the fallback) ----------

type Listener = (status: "success" | "error") => void;

// Process-wide (globalThis, ADR-023): the webhook route and the polling route are different bundles.
const completedMap = () => youcamState().completedTasks;
const listenerMap = () => youcamState().taskListeners;
const MAX_REMEMBERED = 1_000;

/** Called by the webhook route. Wakes any poller waiting on this task in this process. */
export function notifyTaskCompleted(taskId: string, status: "success" | "error"): void {
  const completed = completedMap();
  const listeners = listenerMap();
  completed.set(taskId, { status, at: Date.now() });
  if (completed.size > MAX_REMEMBERED) {
    const oldest = completed.keys().next().value as string;
    completed.delete(oldest);
  }
  for (const l of listeners.get(taskId) ?? []) l(status);
  listeners.delete(taskId);
}

export function completedStatus(taskId: string): "success" | "error" | undefined {
  return completedMap().get(taskId)?.status;
}

/**
 * Resolves after `ms`, or earlier when a webhook for `taskId` arrives.
 * `sleep` is injectable for tests.
 */
export function waitForTaskSignal(taskId: string, ms: number, sleep: (ms: number) => Promise<void>): Promise<void> {
  const listeners = listenerMap();
  if (completedMap().has(taskId)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      listeners.get(taskId)?.delete(listener);
      resolve();
    };
    const listener: Listener = () => finish();
    if (!listeners.has(taskId)) listeners.set(taskId, new Set());
    listeners.get(taskId)!.add(listener);
    void sleep(ms).then(finish);
  });
}

export function resetWebhookSignals(): void {
  completedMap().clear();
  listenerMap().clear();
}

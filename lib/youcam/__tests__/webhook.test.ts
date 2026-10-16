import { afterEach, describe, expect, it } from "vitest";
import {
  WebhookSignatureError,
  completedStatus,
  notifyTaskCompleted,
  resetWebhookSignals,
  signYoucamWebhook,
  verifyYoucamWebhook,
  waitForTaskSignal,
  webhookHeaders,
} from "../webhook";

// Test-only secret (base64 of "giftfit-testing-webhook-secret-01").
const SECRET = `whsec_${Buffer.from("giftfit-testing-webhook-secret-01").toString("base64")}`;
const body = JSON.stringify({ created_at: 1761112848, data: { task_id: "task_abc", task_status: "success" } });

afterEach(() => resetWebhookSignals());

describe("verifyYoucamWebhook", () => {
  it("accepts a correctly signed payload (Headers or record)", () => {
    const h = signYoucamWebhook(SECRET, "msg_1", new Date(), body);
    expect(h["webhook-signature"]).toMatch(/^v1,/);
    expect(verifyYoucamWebhook(body, h, SECRET).data).toEqual({ task_id: "task_abc", task_status: "success" });
    expect(verifyYoucamWebhook(body, new Headers(h), SECRET).data.task_id).toBe("task_abc");
  });

  it("rejects tampered bodies, wrong secrets, stale timestamps and missing headers", () => {
    const h = signYoucamWebhook(SECRET, "msg_1", new Date(), body);
    expect(() => verifyYoucamWebhook(body.replace("success", "error"), h, SECRET)).toThrow(WebhookSignatureError);
    const other = `whsec_${Buffer.from("another-secret-another-secret-00").toString("base64")}`;
    expect(() => verifyYoucamWebhook(body, h, other)).toThrow(WebhookSignatureError);
    const stale = signYoucamWebhook(SECRET, "msg_2", new Date(Date.now() - 60 * 60 * 1000), body);
    expect(() => verifyYoucamWebhook(body, stale, SECRET)).toThrow(WebhookSignatureError);
    expect(() => verifyYoucamWebhook(body, { "webhook-id": "x" }, SECRET)).toThrow(/missing/);
    expect(() => verifyYoucamWebhook(body, h, "not-base64-!!")).toThrow(WebhookSignatureError);
  });

  it("rejects signed payloads without a final task status", () => {
    const running = JSON.stringify({ created_at: 1, data: { task_id: "t", task_status: "running" } });
    expect(() => verifyYoucamWebhook(running, signYoucamWebhook(SECRET, "m", new Date(), running), SECRET)).toThrow(/final/);
  });

  it("picks only the three standard headers", () => {
    expect(webhookHeaders({ "webhook-id": "a", other: "b" })).toEqual({ "webhook-id": "a" });
  });
});

describe("task completion signals", () => {
  it("wakes a waiting poller early", async () => {
    let slept = false;
    const never = () => new Promise<void>(() => {});
    const waiting = waitForTaskSignal("t1", 10_000, never).then(() => (slept = true));
    notifyTaskCompleted("t1", "success");
    await waiting;
    expect(slept).toBe(true);
    expect(completedStatus("t1")).toBe("success");
    await waitForTaskSignal("t1", 10_000, never); // already completed: resolves immediately
  });

  it("falls back to the timer and forgets old tasks", async () => {
    await waitForTaskSignal("t2", 5, async () => {});
    for (let i = 0; i < 1001; i++) notifyTaskCompleted(`bulk_${i}`, "error");
    expect(completedStatus("bulk_0")).toBeUndefined();
    expect(completedStatus("bulk_1000")).toBe("error");
  });
});

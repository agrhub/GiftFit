import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { completedStatus, resetWebhookSignals, signYoucamWebhook } from "@/server/youcam/webhook";
import { GET as mockAsset } from "../../mock-asset/[name]/route";
import { POST } from "../route";

const SECRET = `whsec_${Buffer.from("giftfit-routes-test-secret-0001").toString("base64")}`;
const body = JSON.stringify({ created_at: 1761112848, data: { task_id: "task_route", task_status: "success" } });
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "youcam-route-"));
  vi.stubEnv("GIFTFIT_DATA_DIR", dir);
  vi.stubEnv("DATABASE_URL", "");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  resetWebhookSignals();
  await fs.rm(dir, { recursive: true, force: true });
});

const request = (headers: Record<string, string>, payload = body) =>
  new Request("http://localhost/api/youcam/webhook", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: payload });

describe("POST /api/youcam/webhook", () => {
  it("returns 503 when no secret is configured", async () => {
    vi.stubEnv("YOUCAM_WEBHOOK_SECRET", "");
    expect((await POST(request({}))).status).toBe(503);
  });

  it("rejects bad or missing signatures with 401", async () => {
    vi.stubEnv("YOUCAM_WEBHOOK_SECRET", SECRET);
    expect((await POST(request({}))).status).toBe(401);
    const h = signYoucamWebhook(SECRET, "msg_x", new Date(), body);
    expect((await POST(request(h, body.replace("success", "error")))).status).toBe(401);
    expect(completedStatus("task_route")).toBeUndefined();
  });

  it("accepts a valid signature, wakes pollers and audits", async () => {
    vi.stubEnv("YOUCAM_WEBHOOK_SECRET", SECRET);
    const res = await POST(request(signYoucamWebhook(SECRET, "msg_ok", new Date(), body)));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(completedStatus("task_route")).toBe("success");
    const audit = await fs.readFile(path.join(dir, "youcam-audit.jsonl"), "utf8");
    expect(JSON.parse(audit.trim())).toMatchObject({ event: "youcam.webhook", taskId: "task_route", status: "success", detail: { webhookId: "msg_ok" } });
  });

  it("still answers 200 if the audit write fails", async () => {
    vi.stubEnv("YOUCAM_WEBHOOK_SECRET", SECRET);
    const file = path.join(dir, "blocker");
    await fs.writeFile(file, "x");
    vi.stubEnv("GIFTFIT_DATA_DIR", path.join(file, "sub"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await POST(request(signYoucamWebhook(SECRET, "msg_2", new Date(), body)))).status).toBe(200);
    expect(spy).toHaveBeenCalled();
  });
});

describe("GET /api/youcam/mock-asset/[name]", () => {
  const get = (name: string) => mockAsset(new Request(`http://localhost/api/youcam/mock-asset/${name}`), { params: Promise.resolve({ name }) });

  it("serves placeholder PNGs only in mock mode", async () => {
    vi.stubEnv("YOUCAM_MOCK", "1");
    const ok = await get("mock-makeup-vto.png");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect((await get("../secret.png")).status).toBe(404);
    expect((await get("missing.png")).status).toBe(404);
    vi.stubEnv("YOUCAM_MOCK", "0");
    expect((await get("mock-makeup-vto.png")).status).toBe(404);
  });
});

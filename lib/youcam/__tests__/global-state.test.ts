import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeYoucamApi } from "./fake-api";

type Lib = typeof import("../index");
type Http = typeof import("../http");
type Webhook = typeof import("../webhook");

/** Two genuinely distinct module instances, like two Next.js route bundles in one process. */
async function loadTwice(): Promise<[{ lib: Lib; http: Http; webhook: Webhook }, { lib: Lib; http: Http; webhook: Webhook }]> {
  const load = async () => ({ lib: await import("../index"), http: await import("../http"), webhook: await import("../webhook") });
  vi.resetModules();
  const a = await load();
  vi.resetModules();
  const b = await load();
  return [a, b];
}

beforeEach(async () => {
  vi.stubEnv("YOUCAM_MOCK", "1");
  vi.stubEnv("DATABASE_URL", "");
  vi.stubEnv("GIFTFIT_DATA_DIR", path.join(os.tmpdir(), "youcam-global-state"));
  (await import("../global-state")).resetYoucamState();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  (await import("../global-state")).resetYoucamState();
});

describe("process-wide state on globalThis (ADR-023)", () => {
  it("is shared across two module instances", async () => {
    const [a, b] = await loadTwice();
    expect(a.lib.YoucamClient).not.toBe(b.lib.YoucamClient); // really two bundles
    expect(a.lib.YOUCAM_STATE_KEY).toBe(b.lib.YOUCAM_STATE_KEY);
    expect(a.lib.youcamState()).toBe(b.lib.youcamState());

    // shared client, rate limiter, default audit sink and default result cache
    expect(a.lib.getYoucamClient()).toBe(b.lib.getYoucamClient());
    expect(a.http.sharedRateLimiter()).toBe(b.http.sharedRateLimiter());
    const ca = a.lib.createYoucamClient();
    const cb = b.lib.createYoucamClient();
    expect(ca.audit).toBe(cb.audit);
    expect(ca.cache).toBe(cb.cache);
    expect(ca.audit.kind).toBe("jsonl");
    const iso = b.lib.createYoucamClient({ state: "isolated" });
    expect(iso.audit).not.toBe(ca.audit);
    expect(iso.cache).not.toBe(ca.cache);

    // a webhook handled in bundle A is seen by a poller in bundle B
    a.webhook.notifyTaskCompleted("task_x", "success");
    expect(b.webhook.completedStatus("task_x")).toBe("success");

    // fixture memo is shared too
    a.lib.youcamState().fixtureMemo.set("k", { file: "f", synthetic: true, data: { task_status: "success" } });
    expect(b.lib.youcamState().fixtureMemo.has("k")).toBe(true);
  });

  it("shares the cost-guard ledger: units charged in one bundle count against the run cap in another", async () => {
    const [a, b] = await loadTwice();
    const api = new FakeYoucamApi({ runningPolls: 0 });
    const real = { mock: false, allowPaid: true, apiKey: "k", baseUrl: "https://api.test", pollIntervalMs: 1, maxPolls: 2, reserveUnits: 300, maxUnitsPerRun: 40 };
    const opts = { config: real, fetch: api.fetch, sleep: async () => {}, limiter: null, cache: null };
    const clientA = new a.lib.YoucamClient({ ...opts, audit: new a.lib.MemoryAuditSink() });
    const clientB = new b.lib.YoucamClient({ ...opts, audit: new b.lib.MemoryAuditSink() });
    const face = { url: "https://img.test/face.jpg" };

    await clientA.facialColorTones(face); // 20
    expect(clientB.guard.unitsCharged).toBe(20);
    await clientB.faceAttributes(face); // 10 -> 30 committed process-wide
    expect(clientA.guard.unitsCommitted).toBe(30);
    // another 20 would exceed the per-run cap of 40, whichever bundle asks
    await expect(clientA.facialColorTones({ url: "https://img.test/other.jpg" })).rejects.toMatchObject({ reason: "run_cap_exceeded" });

    // the live feature-cost cache is shared: only one feature-cost fetch for both clients
    expect(api.callsTo("GET", /feature-cost/)).toHaveLength(1);
    expect(a.lib.youcamState().ledger).toMatchObject({ committed: 30, inFlight: 0, charged: 30 });

    // an isolated client keeps its own ledger
    const iso = new b.lib.YoucamClient({ ...opts, audit: new b.lib.MemoryAuditSink(), state: "isolated" });
    expect(iso.guard.unitsCommitted).toBe(0);
  });

  it("resetYoucamState() forgets everything", async () => {
    const lib = await import("../index");
    const before = lib.getYoucamClient();
    lib.resetYoucamState();
    expect(lib.youcamState().ledger).toBeUndefined();
    expect(lib.getYoucamClient()).not.toBe(before);
  });
});

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryAuditSink } from "../audit";
import { MemoryResultCache } from "../cache";
import { YoucamClient } from "../client";
import { loadYoucamConfig } from "../config";
import { analyzeRecipient, runTryOns } from "../fit-request";
import { DEFAULT_FIXTURES_ROOT, clearFixtureMemo, fixtureCandidates, fixtureImagePath, loadFixture } from "../mock";
import { FakeYoucamApi, json } from "./fake-api";

const face = { bytes: new Uint8Array([0xff, 0xd8, 0xff, 5]), contentType: "image/jpeg" as const };
const product = { url: "https://shop.test/e.png" };

function real(api: FakeYoucamApi, cache = new MemoryResultCache()) {
  const audit = new MemoryAuditSink();
  const client = new YoucamClient({
    config: { mock: false, allowPaid: true, apiKey: "k", baseUrl: "https://api.test", reserveUnits: 300, maxUnitsPerRun: 40, pollIntervalMs: 1, maxPolls: 3 },
    fetch: api.fetch,
    sleep: async () => {},
    audit,
    cache,
    limiter: null,
    state: "isolated",
    retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1 },
  });
  return { client, audit, cache };
}

afterEach(() => clearFixtureMemo());

describe("cache keys on GiftFit results (A5 purge)", () => {
  it("analyzeRecipient and runTryOns expose the cache keys that were written", async () => {
    const api = new FakeYoucamApi({ runningPolls: 0, results: { "skin-tone-analysis": { color: { skin_color: "#aa8877" } } } });
    const { client, cache } = real(api);
    const r = await analyzeRecipient(client, face);
    expect(r.cacheKeys.tones).toMatch(/^[a-f0-9]{64}$/);
    expect(r.cacheKeys.faceAttributes).not.toBe(r.cacheKeys.tones);
    expect(await cache.get(r.cacheKeys.tones)).toMatchObject({ taskId: r.taskIds.tones });
    const [t] = await runTryOns(client, { face }, [{ id: "e", kind: "earring", product }]);
    expect(t).toMatchObject({ ok: true, cacheKey: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(await cache.get((t as { cacheKey: string }).cacheKey)).toBeDefined();
  });

  it("failed try-ons carry the task id when a YouCam task exists", async () => {
    const api = new FakeYoucamApi({ runningPolls: 0, taskStatus: "error" });
    const [t] = await runTryOns(real(api).client, { face }, [{ id: "e", kind: "earring", product }]);
    expect(t).toMatchObject({ ok: false, code: "error_no_face", taskId: "task_1" });
    const slow = new FakeYoucamApi({ runningPolls: 99 });
    const [s] = await runTryOns(real(slow).client, { face }, [{ id: "e", kind: "earring", product }]);
    expect(s).toMatchObject({ ok: false, code: "timeout", taskId: "task_1" });
  });

  it("mock results expose cache keys too (nothing is cached in mock mode)", async () => {
    const mock = new YoucamClient({ config: { mock: true }, audit: new MemoryAuditSink(), cache: new MemoryResultCache() });
    const r = await analyzeRecipient(mock, face);
    expect(r.cacheKeys.tones).toMatch(/^[a-f0-9]{64}$/);
    expect(await mock.cache!.get(r.cacheKeys.tones)).toBeUndefined();
  });
});

describe("client.purge / purgeCacheKeys / deleteTasks", () => {
  it("drops cache entries, deletes tasks and audits counts only", async () => {
    const api = new FakeYoucamApi({ runningPolls: 0 });
    const { client, audit, cache } = real(api);
    const r = await analyzeRecipient(client, face);
    api.override = (c) => (c.url.endsWith("/task/delete") ? json({ status: 200 }) : undefined);
    const res = await client.purge({
      cacheKeys: [r.cacheKeys.tones, r.cacheKeys.faceAttributes, r.cacheKeys.tones, "not-a-key"],
      taskIds: [r.taskIds.tones, r.taskIds.faceAttributes, "mock_x"],
    });
    expect(res).toEqual({
      cacheKeysPurged: 2,
      ok: true,
      tasks: [
        { taskId: r.taskIds.tones, ok: true },
        { taskId: r.taskIds.faceAttributes, ok: true },
        { taskId: "mock_x", ok: true },
      ],
    });
    expect(await cache.get(r.cacheKeys.tones)).toBeUndefined();
    expect(api.callsTo("POST", /task\/delete$/).map((c) => c.body)).toEqual([{ task_id: "task_1" }, { task_id: "task_2" }]);
    expect(audit.events.at(-1)).toEqual(
      expect.objectContaining({ event: "youcam.purge", mode: "real", detail: { cacheKeys: 2, tasks: 3, tasksFailed: 0 } }),
    );
    expect(JSON.stringify(audit.events.at(-1))).not.toContain(r.cacheKeys.tones);
  });

  it("treats unknown tasks as gone and reports other failures without throwing", async () => {
    const api = new FakeYoucamApi();
    api.override = (c) => {
      const id = (c.body as { task_id?: string })?.task_id;
      if (id === "gone") return json({ error: "Invalid task ID", error_code: "InvalidTaskId" }, 400);
      if (id === "missing") return json({ error: "not found" }, 404);
      if (id === "running") return json({ error: "still running", error_code: "OperationInvalid" }, 400);
      if (id === "boom") return json({ error: "boom" }, 500);
      return undefined;
    };
    const { client } = real(api);
    const res = await client.purge({ taskIds: ["gone", "missing", "running", "boom"] });
    expect(res.ok).toBe(false);
    expect(res.tasks).toEqual([
      { taskId: "gone", ok: true, alreadyGone: true },
      { taskId: "missing", ok: true, alreadyGone: true },
      { taskId: "running", ok: false, code: "OperationInvalid" },
      { taskId: "boom", ok: false, code: "500" },
    ]);
    const noKey = new YoucamClient({ config: { mock: false, apiKey: undefined }, fetch: api.fetch, audit: new MemoryAuditSink(), cache: null, limiter: null });
    expect(await noKey.deleteTasks(["t"])).toEqual([{ taskId: "t", ok: false, code: "YoucamValidationError" }]);
    expect(await noKey.purgeCacheKeys(["a".repeat(64)])).toBe(0);
  });

  it("is a network-free no-op for tasks in mock mode", async () => {
    const audit = new MemoryAuditSink();
    const cache = new MemoryResultCache();
    const key = "b".repeat(64);
    await cache.set(key, { feature: "f", taskId: "t", result: {}, unitsCharged: 0, createdAt: "x" });
    const mock = new YoucamClient({ config: { mock: true }, audit, cache });
    const res = await mock.purge({ cacheKeys: [key], taskIds: ["task_real_looking"] });
    expect(res).toEqual({ cacheKeysPurged: 1, ok: true, tasks: [{ taskId: "task_real_looking", ok: true }] });
    expect(await cache.get(key)).toBeUndefined();
    expect(audit.events.at(-1)).toMatchObject({ event: "youcam.purge", mode: "mock" });
    expect(await mock.purge({})).toEqual({ cacheKeysPurged: 0, ok: true, tasks: [] });
  });
});

describe("static fixture root (ADR-019)", () => {
  it("defaults to <cwd>/fixtures/youcam and builds static candidate paths", async () => {
    expect(DEFAULT_FIXTURES_ROOT).toBe(path.join(process.cwd(), "fixtures", "youcam"));
    expect(loadYoucamConfig({}).fixturesDir).toBe(DEFAULT_FIXTURES_ROOT);
    expect(loadYoucamConfig({ YOUCAM_FIXTURES_DIR: "fx" }).fixturesDir).toBe(path.resolve("fx"));
    expect(fixtureCandidates(DEFAULT_FIXTURES_ROOT, "a.json")).toEqual([
      path.join(DEFAULT_FIXTURES_ROOT, "real", "a.json"),
      path.join(DEFAULT_FIXTURES_ROOT, "a.json"),
    ]);
    expect(fixtureImagePath(DEFAULT_FIXTURES_ROOT, "x.png")).toBe(path.join(DEFAULT_FIXTURES_ROOT, "images", "x.png"));
    await expect(loadFixture(DEFAULT_FIXTURES_ROOT, "makeup-vto")).resolves.toMatchObject({ synthetic: expect.any(Boolean) });
  });

  it("keeps the override working, with or without a trailing separator", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "youcam-fx-"));
    try {
      expect(fixtureCandidates(dir, "a.json")).toEqual([path.join(dir, "real", "a.json"), path.join(dir, "a.json")]);
      expect(fixtureCandidates(dir + path.sep, "a.json")[1]).toBe(path.join(dir, "a.json"));
      expect(fixtureImagePath(dir, "x.png")).toBe(path.join(dir, "images", "x.png"));
      expect(fixtureImagePath(dir + path.sep, "x.png")).toBe(path.join(dir, "images", "x.png"));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

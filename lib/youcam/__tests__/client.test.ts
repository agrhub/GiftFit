import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryAuditSink } from "../audit";
import { MemoryResultCache } from "../cache";
import { YoucamClient, createYoucamClient, getYoucamClient, resetYoucamClient, type YoucamClientOptions } from "../client";
import type { YoucamConfig } from "../config";
import { CostGuardError, YoucamApiError, YoucamTaskError, YoucamTimeoutError, YoucamValidationError } from "../errors";
import { clearFixtureMemo } from "../mock";
import { notifyTaskCompleted, resetWebhookSignals } from "../webhook";
import { FakeYoucamApi, json } from "./fake-api";

const FIXTURES = path.join(process.cwd(), "fixtures", "youcam");
const selfie = { bytes: new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]), contentType: "image/jpeg" as const };

const REAL: Partial<YoucamConfig> = {
  mock: false,
  allowPaid: true,
  apiKey: "test-key",
  baseUrl: "https://api.test",
  reserveUnits: 280,
  maxUnitsPerRun: 60,
  pollIntervalMs: 1,
  maxPolls: 5,
  fixturesDir: FIXTURES,
};

function realClient(api: FakeYoucamApi, over: Partial<YoucamClientOptions> = {}, cfg: Partial<YoucamConfig> = {}) {
  const audit = new MemoryAuditSink();
  const cache = new MemoryResultCache();
  const client = new YoucamClient({
    config: { ...REAL, ...cfg },
    fetch: api.fetch,
    sleep: async () => {},
    audit,
    cache,
    retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 },
    limiter: null,
    state: "isolated",
    ...over,
  });
  return { client, audit, cache };
}

function mockClient(cfg: Partial<YoucamConfig> = {}, over: Partial<YoucamClientOptions> = {}) {
  const audit = new MemoryAuditSink();
  const fetch = vi.fn();
  const client = new YoucamClient({ config: { mock: true, fixturesDir: FIXTURES, ...cfg }, audit, fetch, cache: null, ...over });
  return { client, audit, fetch };
}

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "youcam-client-"));
});
afterEach(async () => {
  resetWebhookSignals();
  clearFixtureMemo();
  resetYoucamClient();
  vi.unstubAllEnvs();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("mock mode", () => {
  it("serves fixtures with zero network and audits the would-be cost", async () => {
    const { client, audit, fetch } = mockClient();
    expect(client.mode).toBe("mock");
    const r = await client.skinAnalysis(selfie);
    expect(r).toMatchObject({ mock: true, synthetic: true, cached: false, unitsCharged: 0, unitsExpected: 22 });
    expect(r.result.output.find((o) => o.type === "skin_age")?.score).toBe(29);
    expect(r.taskId).toMatch(/^mock_skin-analysis_/);
    expect(fetch).not.toHaveBeenCalled();
    expect(audit.events[0]).toMatchObject({ mode: "mock", decision: "mock", feature: "skin-analysis", unitsExpected: 22, unitsCharged: 0 });
    expect(JSON.stringify(audit.events)).not.toContain("255,216");
  });

  it("covers every typed wrapper", async () => {
    const { client } = mockClient();
    const img = { url: "https://img.test/p.jpg" };
    expect((await client.fitzpatrick(selfie)).result.fitzpatrick_scale).toBe("III");
    expect((await client.facialColorTones(selfie)).result.color.skin_color).toMatch(/^#/);
    expect((await client.faceAttributes(selfie, { features: ["faceShape"] })).result.faceshape).toBe("Oval");
    expect((await client.skinSimulation(selfie, { concerns: { acne: 0.6 } })).unitsExpected).toBe(4);
    expect((await client.makeupVto(selfie, { effects: [{ category: "lip_color" }] })).result.url).toContain("mock-makeup-vto");
    expect((await client.hairColorVto(selfie, { preset: "Copper Red" })).unitsExpected).toBe(1);
    expect((await client.clothVto(selfie, { garment: img, garmentCategory: "upper_body" })).unitsExpected).toBe(2);
    for (const kind of ["earring", "necklace"] as const) {
      expect((await client.jewelryVto(kind, selfie, { products: [img] })).result.url).toContain("mock-jewelry-vto");
    }
    for (const kind of ["ring", "bracelet", "watch"] as const) {
      expect((await client.jewelryVto(kind, selfie, { products: [img] })).result.url).toContain("mock-hand-vto");
    }
    expect((await client.faceAttributes(selfie)).unitsExpected).toBe(10);
  });

  it("validates params before touching fixtures, simulates latency, and refuses network", async () => {
    const sleep = vi.fn(async () => {});
    const { client, fetch } = mockClient({ mockLatencyMs: 50 }, { sleep });
    await expect(client.skinAnalysis(selfie, { dstActions: ["hd_acne", "acne"] })).rejects.toThrow(YoucamValidationError);
    await client.makeupVto(selfie, { effects: [{ category: "blush" }] });
    expect(sleep).toHaveBeenCalledWith(50);
    await expect(client.getBalance()).rejects.toThrow(/mock mode/);
    await expect(client.getFeatureCosts()).rejects.toThrow(/mock mode/);
    await expect(client.uploadFile(selfie)).resolves.toMatch(/^mock_file_[a-f0-9]{16}$/);
    await expect(client.uploadFiles([])).resolves.toEqual([]);
    await expect(client.deleteTask("t")).resolves.toBeUndefined();
    await expect(client.getCreditHistory()).rejects.toThrow(/mock mode/);
    expect(fetch).not.toHaveBeenCalled();
    await expect(client.getTask("makeup-vto", "t")).rejects.toThrow(/mock mode/);
    await expect(client.preflight([{ feature: "makeup-vto", params: { effects: [{ category: "x" }] } }])).resolves.toMatchObject({
      allowed: false,
      reason: "paid_calls_disabled",
      unitsExpected: 1,
    });
  });

  it("raises a task error for error fixtures and keeps going if audit fails", async () => {
    const dir = path.join(tmp, "fx");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "makeup-vto.json"),
      JSON.stringify({ _synthetic: true, feature: "makeup-vto", response: { status: 200, data: { task_status: "error", error: "error_no_face" } } }),
    );
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = mockClient(
      { fixturesDir: dir },
      { audit: { kind: "x", write: async () => Promise.reject(new Error("audit down")) } },
    );
    const err = await client.makeupVto(selfie, { effects: [{ category: "x" }] }).catch((e) => e);
    expect(err).toBeInstanceOf(YoucamTaskError);
    expect(err.engineError).toBe("error_no_face");
    expect(spy).toHaveBeenCalled();
  });

  it("estimates units offline", () => {
    const { client } = mockClient();
    expect(client.estimateUnits("skin-analysis", {})).toBe(22);
    expect(client.estimateUnits("2d-vto/ring", { products: [{ url: "a" }, { url: "b" }] })).toBe(2);
  });
});

describe("real mode (fake API)", () => {
  it("uploads, PUTs, creates the task, polls, charges and caches", async () => {
    const api = new FakeYoucamApi({ runningPolls: 2, results: { "skin-tone-analysis": { color: { skin_color: "#aa8877" } } } });
    const { client, audit, cache } = realClient(api);
    const r = await client.facialColorTones(selfie, { faceAngleStrictness: "medium" });
    expect(r).toMatchObject({ mock: false, cached: false, unitsCharged: 20, unitsExpected: 20, taskId: "task_1" });
    expect(r.result.color.skin_color).toBe("#aa8877");

    const upload = api.callsTo("POST", /\/s2s\/v2\.0\/file$/)[0];
    expect(upload.headers.Authorization).toBe("Bearer test-key");
    expect(upload.body).toEqual({ files: [{ content_type: "image/jpeg", file_name: "image.jpg", file_size: 6 }] });
    expect(api.callsTo("PUT", /upload\.example/)[0].headers).toEqual({ "Content-Type": "image/jpeg" });
    expect(api.callsTo("PUT", /upload\.example/)[0].body).toBe("<bytes>");
    expect(api.callsTo("POST", /task\/skin-tone-analysis$/)[0].body).toEqual({ src_file_id: "file_1", face_angle_strictness_level: "medium" });
    expect(api.callsTo("GET", /task\/skin-tone-analysis\/task_1$/)).toHaveLength(3);
    expect(client.guard.unitsCharged).toBe(20);
    expect(audit.events.map((e) => e.decision ?? e.status)).toEqual(["allowed", "success"]);
    expect(JSON.stringify(audit.events)).not.toContain("test-key");
    expect(JSON.stringify(audit.events)).not.toContain("sig=secret");
    expect(await cache.get(r.cacheKey)).toMatchObject({ taskId: "task_1", unitsCharged: 20 });

    const again = await client.facialColorTones(selfie, { faceAngleStrictness: "medium" });
    expect(again).toMatchObject({ cached: true, unitsCharged: 0, taskId: "task_1" });
    expect(api.callsTo("POST", /task\//)).toHaveLength(1);
    expect(audit.events.at(-1)).toMatchObject({ decision: "cache_hit", unitsCharged: 0 });

    await client.facialColorTones(selfie, { faceAngleStrictness: "medium" }, { cache: false });
    expect(api.callsTo("POST", /task\//)).toHaveLength(2);
  });

  it("uses public URLs without uploading and posts the HD skin body to v2.1", async () => {
    const api = new FakeYoucamApi({ runningPolls: 0, results: { "skin-analysis": { output: [] } } });
    const { client } = realClient(api, { cache: null });
    await client.skinAnalysis({ url: "https://img.test/me.jpg" }, { dstActions: ["hd_acne"] });
    expect(api.callsTo("POST", /\/file/)).toHaveLength(0);
    const create = api.callsTo("POST", /\/s2s\/v2\.1\/task\/skin-analysis$/)[0];
    expect(create.body).toEqual({
      src_file_url: "https://img.test/me.jpg",
      dst_actions: ["hd_acne"],
      format: "json",
      miniserver_args: { enable_mask_overlay: false },
    });
  });

  it("attaches the garment for cloth-v4 and object_infos for jewelry", async () => {
    const api = new FakeYoucamApi({ runningPolls: 0 });
    const { client } = realClient(api, { cache: null });
    await client.clothVto(selfie, { garment: { url: "https://shop.test/shirt.jpg" }, garmentCategory: "upper_body" });
    expect(api.callsTo("POST", /task\/cloth-v4$/)[0].body).toEqual({
      src_file_id: "file_1",
      ref_file_url: "https://shop.test/shirt.jpg",
      garment_category: "upper_body",
    });
    const ring = { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), contentType: "image/png" as const, fileName: "ring.png" };
    await client.jewelryVto("ring", selfie, { products: [ring, ring], parameter: { ring_wearing_finger: 2 } });
    const ringParams = { ring_need_remove_background: true, ring_shadow_intensity: 0.15, ring_ambient_light_intensity: 1, ring_wearing_finger: 2 };
    const uploads = api.callsTo("POST", /\/s2s\/v2\.0\/file$/);
    expect(uploads).toHaveLength(4);
    expect(uploads[1].body).toEqual({ files: [{ content_type: "image/jpeg", file_name: "image.jpg", file_size: 6 }] });
    uploads.shift();
    expect(uploads[1].body).toEqual({ files: [{ content_type: "image/png", file_name: "ring.png", file_size: 4 }] });
    expect(api.callsTo("POST", /task\/2d-vto\/ring$/)[0].body).toEqual({
      src_file_id: "file_2",
      ref_file_ids: ["file_3", "file_4"],
      source_info: { name: "file_2" },
      object_infos: [
        { name: "file_3", parameter: ringParams },
        { name: "file_4", parameter: ringParams },
      ],
    });
    expect(client.guard.unitsCharged).toBe(4);
  });

  it("refuses paid tasks via the cost guard before any upload", async () => {
    const api = new FakeYoucamApi();
    const { client, audit } = realClient(api, {}, { allowPaid: false });
    const err = await client.skinAnalysis(selfie).catch((e) => e);
    expect(err).toBeInstanceOf(CostGuardError);
    expect(err.reason).toBe("paid_calls_disabled");
    expect(api.calls).toHaveLength(0);
    expect(audit.events[0]).toMatchObject({ decision: "refused", reason: "paid_calls_disabled" });

    const poor = new FakeYoucamApi({ balance: 40 });
    const r2 = realClient(poor);
    await expect(r2.client.fitzpatrick(selfie)).rejects.toMatchObject({ reason: "reserve_floor" });
    expect(poor.callsTo("POST", /./)).toHaveLength(0);
  });

  it("releases units when the task errors", async () => {
    const api = new FakeYoucamApi({ runningPolls: 0, taskStatus: "error" });
    const { client, audit } = realClient(api);
    const err = await client.fitzpatrick(selfie).catch((e) => e);
    expect(err).toBeInstanceOf(YoucamTaskError);
    expect(err.message).toMatch(/error_no_face \(No face\)/);
    expect(client.guard.unitsCommitted).toBe(0);
    expect(audit.events.at(-1)).toMatchObject({ status: "error", unitsCharged: 0, detail: { error: "error_no_face" } });
  });

  it("times out after maxPolls and keeps the units committed", async () => {
    const api = new FakeYoucamApi({ runningPolls: 99 });
    const { client, audit } = realClient(api, {}, { maxPolls: 3 });
    const err = await client.fitzpatrick(selfie).catch((e) => e);
    expect(err).toBeInstanceOf(YoucamTimeoutError);
    expect(err.taskId).toBe("task_1");
    expect(client.guard.unitsCommitted).toBe(10);
    expect(audit.events.at(-1)).toMatchObject({ status: "timeout" });
  });

  it("wakes from polling when the webhook reports completion", async () => {
    const api = new FakeYoucamApi({ runningPolls: 1 });
    const never = () => new Promise<void>(() => {});
    const { client } = realClient(api, { sleep: never });
    api.override = (call) => {
      if (call.method === "GET" && call.url.endsWith("/task_1") && !api.calls.some((c, i) => i < api.calls.length - 1 && c.url === call.url)) {
        setTimeout(() => notifyTaskCompleted("task_1", "success"), 0);
      }
      return undefined;
    };
    await expect(client.makeupVto(selfie, { effects: [{ category: "lip_color" }] })).resolves.toMatchObject({ unitsCharged: 1 });
  });

  it("settles as error when upload or task creation fails, and reports malformed responses", async () => {
    const api = new FakeYoucamApi();
    const { client, audit } = realClient(api);
    api.override = (c) => (c.method === "POST" && c.url.endsWith("/file") ? json({ data: { files: [{}] } }) : undefined);
    await expect(client.fitzpatrick(selfie)).rejects.toThrow(/no file_id/);
    expect(audit.events.at(-1)).toMatchObject({ status: "error", detail: { error: "YoucamApiError" } });
    api.override = (c) => (c.method === "POST" && c.url.includes("/task/") ? json({ data: {} }) : undefined);
    await expect(client.fitzpatrick({ url: "https://x/y.jpg" })).rejects.toThrow(/no task_id/);
    api.override = (c) => (c.method === "GET" && c.url.includes("/task/") ? json({ data: {} }) : undefined);
    await expect(client.fitzpatrick({ url: "https://x/z.jpg" })).rejects.toThrow(/no task_status/);
    api.override = (c) => (c.method === "POST" && c.url.includes("/task/") ? json({ error: "Insufficient", error_code: "CreditInsufficiency" }, 400) : undefined);
    await expect(client.fitzpatrick({ url: "https://x/w.jpg" })).rejects.toMatchObject({ status: 400, code: "CreditInsufficiency" });
    expect(client.guard.unitsCommitted).toBe(0);
  });

  it("does not fail a paid result when the cache write fails", async () => {
    const api = new FakeYoucamApi({ runningPolls: 0 });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const cache = new MemoryResultCache();
    cache.set = async () => Promise.reject(new Error("cache down"));
    const { client } = realClient(api, { cache });
    await expect(client.makeupVto(selfie, { effects: [{ category: "x" }] })).resolves.toMatchObject({ unitsCharged: 1 });
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("cache"), "cache down");
  });

  it("reads balance and paginated feature costs", async () => {
    const api = new FakeYoucamApi({ balance: 40 });
    const { client } = realClient(api);
    await expect(client.getBalance()).resolves.toEqual({ units: 40, byType: { ApiPaygToken: 40, WebToken: 5 } });
    api.override = (c) => {
      if (!c.url.includes("feature-cost")) return undefined;
      const token = new URL(c.url).searchParams.get("starting_token");
      return token
        ? json({ result: { skus: [{ amount: 2, run_task_url: "https://h/s2s/v2.0/task/cloth-v4" }] } })
        : json({ result: { skus: [{ amount: 1, run_task_url: "https://h/s2s/v2.0/task/makeup-vto" }], next_token: "p2" } });
    };
    const skus = await client.getFeatureCosts();
    expect(skus.map((s) => s.feature)).toEqual(["makeup-vto", "cloth-v4"]);
    api.override = (c) => (c.url.includes("/credit") ? json({ results: [{ amount_dec: 1.5 }] }) : undefined);
    await expect(client.getBalance()).resolves.toEqual({ units: 0, byType: { "?": 1.5 } });
    api.override = (c) => (c.url.includes("/credit") ? json({}) : undefined);
    await expect(client.getBalance()).resolves.toEqual({ units: 0, byType: {} });
  });

  it("preflights a plan with live prices and never creates a task", async () => {
    const api = new FakeYoucamApi({ balance: 40 });
    const { client } = realClient(api);
    const d = await client.preflight([
      { feature: "skin-analysis", params: {} },
      { feature: "fitzpatrick-scale-analyzer", params: {} },
      { feature: "skin-tone-analysis", params: {} },
    ]);
    expect(d).toMatchObject({ allowed: false, reason: "reserve_floor", unitsExpected: 52, balance: 40 });
    expect(api.callsTo("POST", /./)).toHaveLength(0);
  });

  it("strips Content-Length from presigned headers and deletes tasks", async () => {
    const api = new FakeYoucamApi();
    api.override = (c) =>
      c.method === "POST" && c.url.endsWith("/file")
        ? json({ data: { files: [{ file_id: "f", requests: [{ url: "https://upload.example/x", headers: { "Content-Length": "6", "Content-Type": "image/jpeg" } }] }] } })
        : c.url.endsWith("/task/delete")
          ? json({ status: 200 })
          : undefined;
    const { client } = realClient(api);
    await expect(client.uploadFile(selfie)).resolves.toBe("f");
    expect(api.callsTo("PUT", /upload/)[0].headers).toEqual({ "Content-Type": "image/jpeg" });
    await client.deleteTask("task_9");
    expect(api.callsTo("POST", /task\/delete$/)[0].body).toEqual({ task_id: "task_9" });
  });

  it("uploads several files in one request, reuses file ids and sends body variants", async () => {
    const api = new FakeYoucamApi({ runningPolls: 0 });
    api.override = (c) =>
      c.method === "POST" && c.url.endsWith("/file")
        ? json({
            data: {
              files: (c.body as { files: unknown[] }).files.map((_, i) => ({
                file_id: `batch_${i}`,
                requests: [{ url: `https://upload.example/b${i}` }],
              })),
            },
          })
        : undefined;
    const { client } = realClient(api);
    const product = { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), contentType: "image/png" as const };
    const url = { url: "https://shop.test/n.png" };
    const [face, prod, same] = await client.uploadImages([selfie, product, url]);
    expect(api.callsTo("POST", /\/file$/)).toHaveLength(1);
    expect(api.callsTo("POST", /\/file$/)[0].body).toEqual({
      files: [
        { content_type: "image/jpeg", file_name: "image-1.jpg", file_size: 6 },
        { content_type: "image/png", file_name: "image-2.png", file_size: 4 },
      ],
    });
    expect(api.callsTo("PUT", /upload/).map((c) => c.headers)).toEqual([{ "Content-Type": "image/jpeg" }, { "Content-Type": "image/png" }]);
    expect(face).toMatchObject({ fileId: "batch_0" });
    expect(same).toBe(url);
    expect(await client.uploadImages([face])).toEqual([face]);
    await client.jewelryVto("necklace", face, { products: [prod] }, { jewelryBodyVariant: "C" });
    expect(api.callsTo("POST", /\/file$/)).toHaveLength(1);
    expect(api.callsTo("POST", /task\/2d-vto\/necklace$/)[0].body).toEqual({
      src_file_id: "batch_0",
      ref_file_ids: ["batch_1"],
      object_infos: [{ parameter: { necklace_need_remove_background: true, necklace_shadow_intensity: 0.2, necklace_ambient_light_intensity: 1 } }],
    });
    api.override = (c) => (c.method === "POST" && c.url.endsWith("/file") ? json({ data: { files: [] } }) : undefined);
    await expect(client.uploadFiles([selfie])).rejects.toThrow(/no file_id/);
  });

  it("reads credit history", async () => {
    const api = new FakeYoucamApi();
    api.override = (c) =>
      c.url.includes("/credit/history") ? json({ status: 200, result: { history: [{ id: 1, action: "api", target_id: "task_1" }] } }) : undefined;
    const { client } = realClient(api);
    await expect(client.getCreditHistory(500)).resolves.toEqual([{ id: 1, action: "api", target_id: "task_1" }]);
    expect(api.calls.at(-1)!.url).toBe("https://api.test/s2s/v1.0/client/credit/history?page_size=100");
    api.override = (c) => (c.url.includes("/credit/history") ? json({}) : undefined);
    await expect(client.getCreditHistory()).resolves.toEqual([]);
  });

  it("caches results with a TTL and expires them", async () => {
    // Anchor to the real clock: cache.get() checks expiry against Date.now(), so a fixed
    // date made this test fail after 01:30 UTC (found at the P2 merge).
    let now = Date.now();
    const api = new FakeYoucamApi({ runningPolls: 0 });
    const { client, cache } = realClient(api, { now: () => now });
    const r = await client.makeupVto(selfie, { effects: [{ category: "x" }] });
    const hit = await cache.get(r.cacheKey);
    expect(hit?.expiresAt).toBe(new Date(now + 90 * 60 * 1000).toISOString());
    await cache.set(r.cacheKey, { ...hit!, expiresAt: new Date(Date.now() - 1000).toISOString() });
    now += 1;
    expect((await client.makeupVto(selfie, { effects: [{ category: "x" }] })).cached).toBe(false);
  });

  it("rate-limits API calls through the shared bucket by default", async () => {
    const { sharedRateLimiter } = await import("../http");
    const spy = vi.spyOn(sharedRateLimiter(), "acquire");
    const api = new FakeYoucamApi({ balance: 40 });
    const c = new YoucamClient({ config: { ...REAL }, fetch: api.fetch, audit: new MemoryAuditSink(), cache: null, state: "isolated" });
    await c.getBalance();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("needs an API key for network calls", async () => {
    const { client } = realClient(new FakeYoucamApi(), {}, { apiKey: undefined });
    await expect(client.getBalance()).rejects.toThrow(/YOUCAM_API_KEY/);
  });
});

describe("factories", () => {
  it("builds from the environment and shares one client", () => {
    vi.stubEnv("YOUCAM_MOCK", "1");
    vi.stubEnv("GIFTFIT_DATA_DIR", tmp);
    const a = getYoucamClient();
    expect(getYoucamClient()).toBe(a);
    expect(a.mode).toBe("mock");
    expect(a.audit.kind).toBe("jsonl");
    expect(a.cache?.kind).toBe("file");
    resetYoucamClient();
    expect(getYoucamClient()).not.toBe(a);
    const c = createYoucamClient({ config: { mock: true, allowPaid: true } });
    expect(c.config.allowPaid).toBe(false);
  });

  it("uses global fetch by default", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ results: [{ type: "ApiPaygToken", amount: 7 }] }));
    const c = new YoucamClient({ config: { ...REAL }, audit: new MemoryAuditSink(), cache: null, state: "isolated" });
    await expect(c.getBalance()).resolves.toMatchObject({ units: 7 });
    expect(spy).toHaveBeenCalledWith("https://api.test/s2s/v1.0/client/credit", expect.objectContaining({ method: "GET" }));
  });

  it("wraps API errors with the endpoint, never the key", async () => {
    const api = new FakeYoucamApi();
    api.override = () => json({ error: "Invalid API key" }, 401);
    const { client } = realClient(api);
    const err = await client.getBalance().catch((e) => e);
    expect(err).toBeInstanceOf(YoucamApiError);
    expect(err.message).not.toContain("test-key");
    expect(err.endpoint).toBe("GET /s2s/v1.0/client/credit");
  });
});

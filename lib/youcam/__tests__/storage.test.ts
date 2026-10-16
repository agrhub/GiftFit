import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DbAuditSink, JsonlAuditSink, MemoryAuditSink, createDefaultAuditSink, ensureDataDir, jsonlAuditPath } from "../audit";
import {
  FileResultCache,
  MemoryResultCache,
  isExpired,
  cacheKey,
  canonicalJson,
  createDefaultResultCache,
  imageFingerprint,
  sha256Hex,
} from "../cache";
import { clearFixtureMemo, loadFixture, mockTaskId } from "../mock";

const { insertAuditEvent, getCachedResult, setCachedResult, deleteCachedResult } = vi.hoisted(() => ({
  insertAuditEvent: vi.fn<(e: unknown) => Promise<void>>(async () => {}),
  getCachedResult: vi.fn<(k: string) => Promise<unknown>>(async () => ({ feature: "f", taskId: "t", result: 1, unitsCharged: 0, createdAt: "x" })),
  setCachedResult: vi.fn<(k: string, v: unknown) => Promise<void>>(async () => {}),
  deleteCachedResult: vi.fn<(k: string) => Promise<void>>(async () => {}),
}));
vi.mock("../../../db/audit", () => ({ insertAuditEvent }));
vi.mock("../../../db/results", () => ({ getCachedResult, setCachedResult, deleteCachedResult }));

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "youcam-test-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
  clearFixtureMemo();
});

const event = { ts: "2026-10-15T00:00:00.000Z", event: "youcam.attempt" as const, mode: "mock" as const, feature: "x" };

describe("audit sinks", () => {
  it("appends JSONL and makes the data dir self-ignoring", async () => {
    const sink = new JsonlAuditSink(jsonlAuditPath(path.join(dir, "data")));
    await sink.write(event);
    await sink.write({ ...event, feature: "y" });
    const lines = (await fs.readFile(sink.filePath, "utf8")).trim().split("\n");
    expect(lines.map((l) => JSON.parse(l).feature)).toEqual(["x", "y"]);
    expect(await fs.readFile(path.join(dir, "data", ".gitignore"), "utf8")).toBe("*\n");
    await ensureDataDir(path.join(dir, "data")); // idempotent
  });

  it("surfaces unexpected filesystem errors", async () => {
    const file = path.join(dir, "file");
    await fs.writeFile(file, "x");
    await expect(ensureDataDir(path.join(file, "sub"))).rejects.toThrow();
  });

  it("picks the DB sink when DATABASE_URL is set", async () => {
    expect(createDefaultAuditSink({ dataDir: dir }).kind).toBe("jsonl");
    const db = createDefaultAuditSink({ dataDir: dir, databaseUrl: "postgres://x" });
    expect(db).toBeInstanceOf(DbAuditSink);
    await db.write(event);
    expect(insertAuditEvent).toHaveBeenCalledWith(event);
    const mem = new MemoryAuditSink();
    await mem.write(event);
    expect(mem.events).toHaveLength(1);
  });
});

describe("cache keys", () => {
  it("are stable under key order and change with bytes or params", () => {
    expect(canonicalJson({ b: 1, a: [1, { d: undefined, c: null }] })).toBe('{"a":[1,{"c":null}],"b":1}');
    expect(canonicalJson(undefined)).toBe("null");
    expect(canonicalJson(new Uint8Array([1]))).toBe(JSON.stringify(`sha256:${sha256Hex(new Uint8Array([1]))}`));
    const src = { bytes: new Uint8Array([1, 2, 3]), contentType: "image/png" as const };
    const k = cacheKey({ feature: "f", version: "v2.0", src, refs: [], body: { a: 1, b: 2 } });
    expect(k).toMatch(/^[a-f0-9]{64}$/);
    expect(cacheKey({ feature: "f", version: "v2.0", src, refs: [], body: { b: 2, a: 1 } })).toBe(k);
    expect(cacheKey({ feature: "f", version: "v2.0", src: { ...src, bytes: new Uint8Array([9]) }, refs: [], body: { a: 1, b: 2 } })).not.toBe(k);
    expect(cacheKey({ feature: "f", version: "v2.0", src, refs: [], body: { a: 2, b: 2 } })).not.toBe(k);
    expect(imageFingerprint({ url: "https://a" })).toMatch(/^url:/);
    expect(imageFingerprint(src)).not.toContain("1,2,3");
  });
});

describe("result caches", () => {
  const value = { feature: "f", taskId: "t", result: { x: 1 }, unitsCharged: 3, createdAt: "now" };
  const key = "a".repeat(64);

  it("memory cache round-trips", async () => {
    const c = new MemoryResultCache();
    await c.set(key, value);
    expect(await c.get(key)).toEqual(value);
    await c.delete(key);
    expect(await c.get(key)).toBeUndefined();
    await c.set(key, { ...value, expiresAt: "2000-01-01T00:00:00.000Z" });
    expect(await c.get(key)).toBeUndefined();
    expect(isExpired({})).toBe(false);
  });

  it("file cache round-trips and validates keys", async () => {
    const c = new FileResultCache(path.join(dir, "cache"));
    expect(await c.get(key)).toBeUndefined();
    await c.set(key, value);
    expect(await c.get(key)).toEqual(value);
    await c.delete(key);
    expect(await c.get(key)).toBeUndefined();
    await expect(c.get("../../etc/passwd")).rejects.toThrow(/invalid cache key/);
    await c.set(key, { ...value, expiresAt: "2000-01-01T00:00:00.000Z" });
    expect(await c.get(key)).toBeUndefined();
    await c.set(key, { ...value, expiresAt: "2999-01-01T00:00:00.000Z" });
    expect(await c.get(key)).toMatchObject({ taskId: "t" });
    await fs.writeFile(path.join(dir, "cache", `${key}.json`), "{bad");
    await expect(c.get(key)).rejects.toThrow();
  });

  it("uses the DB cache when DATABASE_URL is set", async () => {
    expect(createDefaultResultCache({ dataDir: dir }).kind).toBe("file");
    const c = createDefaultResultCache({ dataDir: dir, databaseUrl: "postgres://x" });
    expect(c.kind).toBe("db");
    expect(await c.get(key)).toMatchObject({ taskId: "t" });
    await c.set(key, value);
    await c.delete(key);
    expect(setCachedResult).toHaveBeenCalledWith(key, value);
    expect(deleteCachedResult).toHaveBeenCalledWith(key);
  });
});

describe("fixtures", () => {
  const write = async (rel: string, body: unknown) => {
    const file = path.join(dir, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, typeof body === "string" ? body : JSON.stringify(body));
  };
  const fixture = (synthetic: boolean, results: unknown) => ({
    _synthetic: synthetic,
    feature: "makeup-vto",
    response: { status: 200, data: { task_status: "success", results } },
  });

  it("prefers a recorded real fixture over the synthetic one, and memoizes", async () => {
    await write("makeup-vto.json", fixture(true, { url: "synthetic" }));
    expect(await loadFixture(dir, "makeup-vto")).toMatchObject({ synthetic: true, data: { results: { url: "synthetic" } } });
    clearFixtureMemo();
    await write("real/makeup-vto.json", fixture(false, { url: "real" }));
    const real = await loadFixture(dir, "makeup-vto");
    expect(real).toMatchObject({ synthetic: false, data: { results: { url: "real" } } });
    await fs.rm(path.join(dir, "real"), { recursive: true });
    expect(await loadFixture(dir, "makeup-vto")).toBe(real);
  });

  it("reports missing or malformed fixtures", async () => {
    await expect(loadFixture(dir, "2d-vto/ring")).rejects.toThrow(/2d-vto-ring\.json/);
    await write("cloth-v4.json", "{nope");
    await expect(loadFixture(dir, "cloth-v4")).rejects.toThrow(/cannot read fixture/);
    await write("hair-color.json", { _synthetic: true, response: { data: {} } });
    await expect(loadFixture(dir, "hair-color")).rejects.toThrow(/task_status/);
    expect(mockTaskId("2d-vto/ring", "abcdef0123456789ffff")).toBe("mock_2d-vto-ring_abcdef0123456789");
  });

  it("ships a valid synthetic fixture for every feature", async () => {
    const { FEATURES } = await import("../features");
    const fxDir = path.join(process.cwd(), "fixtures", "youcam");
    for (const slug of Object.keys(FEATURES)) {
      const raw = JSON.parse(await fs.readFile(path.join(fxDir, `${slug.replace("/", "-")}.json`), "utf8"));
      expect(raw._synthetic, slug).toBe(true);
      expect(raw._source, slug).toMatch(/^https:\/\/docs\.perfectcorp\.com\//);
      expect(raw.feature).toBe(slug);
      expect(raw.response.data.task_status).toBe("success");
    }
  });
});

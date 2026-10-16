/**
 * Result cache keyed by SHA-256(feature + version + image bytes + params).
 * Stores task results only (scores, colors, result URLs), never image bytes.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ensureDataDir } from "./audit";
import { youcamState } from "./global-state";
import type { ImageInput } from "./types";

export interface CachedResult<R = unknown> {
  feature: string;
  taskId: string;
  result: R;
  unitsCharged: number;
  createdAt: string;
  /** ISO time after which the entry is ignored (and removed). */
  expiresAt?: string;
}

export function isExpired(v: { expiresAt?: string }, now = Date.now()): boolean {
  return v.expiresAt !== undefined && Date.parse(v.expiresAt) <= now;
}

export interface ResultCache {
  readonly kind: string;
  get<R>(key: string): Promise<CachedResult<R> | undefined>;
  set<R>(key: string, value: CachedResult<R>): Promise<void>;
  delete(key: string): Promise<void>;
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** JSON with sorted object keys so equal params always hash equally. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (value instanceof Uint8Array) return JSON.stringify(`sha256:${sha256Hex(value)}`);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** Fingerprint of an image input: hash of its bytes, or of its URL. */
export function imageFingerprint(img: ImageInput): string {
  return "bytes" in img ? `sha256:${sha256Hex(img.bytes)}` : `url:${sha256Hex(img.url)}`;
}

export function cacheKey(parts: {
  feature: string;
  version: string;
  src: ImageInput;
  refs: readonly ImageInput[];
  body: unknown;
}): string {
  return sha256Hex(
    canonicalJson({
      feature: parts.feature,
      version: parts.version,
      src: imageFingerprint(parts.src),
      refs: parts.refs.map(imageFingerprint),
      body: parts.body,
    }),
  );
}

export class MemoryResultCache implements ResultCache {
  readonly kind = "memory";
  private readonly map = new Map<string, CachedResult>();
  async get<R>(key: string) {
    const v = this.map.get(key);
    if (v && isExpired(v)) {
      this.map.delete(key);
      return undefined;
    }
    return v as CachedResult<R> | undefined;
  }
  async set<R>(key: string, value: CachedResult<R>) {
    this.map.set(key, value as CachedResult);
  }
  async delete(key: string) {
    this.map.delete(key);
  }
}

export class FileResultCache implements ResultCache {
  readonly kind = "file";
  constructor(readonly dir: string) {}
  private file(key: string) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("invalid cache key");
    return path.join(this.dir, `${key}.json`);
  }
  async get<R>(key: string) {
    try {
      const v = JSON.parse(await fs.readFile(this.file(key), "utf8")) as CachedResult<R>;
      if (isExpired(v)) {
        await this.delete(key);
        return undefined;
      }
      return v;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }
  async set<R>(key: string, value: CachedResult<R>) {
    await ensureDataDir(this.dir);
    await fs.writeFile(this.file(key), JSON.stringify(value), "utf8");
  }
  async delete(key: string) {
    await fs.rm(this.file(key), { force: true });
  }
}

/**
 * The process-wide default cache for this configuration (one instance per process on
 * globalThis, ADR-023). The file and DB backends are persistent anyway; sharing the instance
 * keeps every route bundle on the same object.
 */
export function defaultResultCache(opts: { databaseUrl?: string; dataDir: string }): ResultCache {
  const key = opts.databaseUrl ? "db" : `file:${opts.dataDir}`;
  const caches = youcamState().resultCaches;
  let cache = caches.get(key);
  if (!cache) caches.set(key, (cache = createDefaultResultCache(opts)));
  return cache;
}

/** Postgres cache (`youcam_results`) when DATABASE_URL is set, else files under dataDir. */
export function createDefaultResultCache(opts: { databaseUrl?: string; dataDir: string }): ResultCache {
  if (opts.databaseUrl) {
    return {
      kind: "db",
      async get<R>(key: string) {
        const { getCachedResult } = await import("../../db/results");
        return (await getCachedResult(key)) as CachedResult<R> | undefined;
      },
      async set<R>(key: string, value: CachedResult<R>) {
        const { setCachedResult } = await import("../../db/results");
        await setCachedResult(key, value);
      },
      async delete(key: string) {
        const { deleteCachedResult } = await import("../../db/results");
        await deleteCachedResult(key);
      },
    };
  }
  return new FileResultCache(path.join(opts.dataDir, "youcam-cache"));
}

/**
 * Audit trail for every YouCam attempt (allowed, refused, mock, cache hit) and outcome.
 * With DATABASE_URL set, rows go to the `audit_log` table; otherwise they are appended
 * to <dataDir>/youcam-audit.jsonl (dataDir is gitignored; see config.ts).
 * Entries never contain image bytes, URLs of user images, or the API key.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { youcamState } from "./global-state";

export type AuditDecision = "allowed" | "refused" | "mock" | "cache_hit" | "preflight";

export interface AuditEvent {
  ts: string;
  event: "youcam.attempt" | "youcam.outcome" | "youcam.webhook" | "youcam.purge";
  mode: "mock" | "real";
  feature?: string;
  decision?: AuditDecision;
  reason?: string;
  unitsExpected?: number;
  unitsCharged?: number;
  balanceBefore?: number;
  /** Units committed by this client run (charged + in flight) after this event. */
  runUnits?: number;
  taskId?: string;
  /** SHA-256 cache key of image bytes + params (never the image itself). */
  cacheKey?: string;
  status?: "success" | "error" | "timeout";
  detail?: Record<string, unknown>;
}

export interface AuditSink {
  readonly kind: string;
  write(event: AuditEvent): Promise<void>;
}

export class MemoryAuditSink implements AuditSink {
  readonly kind = "memory";
  readonly events: AuditEvent[] = [];
  async write(event: AuditEvent) {
    this.events.push(event);
  }
}

/** Creates the local data dir with a self-ignoring .gitignore so nothing in it is ever committed. */
export async function ensureDataDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const ignore = path.join(dir, ".gitignore");
  try {
    await fs.writeFile(ignore, "*\n", { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
}

export class JsonlAuditSink implements AuditSink {
  readonly kind = "jsonl";
  constructor(readonly filePath: string) {}
  async write(event: AuditEvent) {
    await ensureDataDir(path.dirname(this.filePath));
    await fs.appendFile(this.filePath, JSON.stringify(event) + "\n", "utf8");
  }
}

export type AuditRowInsert = (event: AuditEvent) => Promise<void>;

/** Writes to Postgres through an injected insert function (see db/audit.ts). */
export class DbAuditSink implements AuditSink {
  readonly kind = "db";
  constructor(private readonly insert: AuditRowInsert) {}
  async write(event: AuditEvent) {
    await this.insert(event);
  }
}

export function jsonlAuditPath(dataDir: string): string {
  return path.join(dataDir, "youcam-audit.jsonl");
}

/**
 * The process-wide default sink for this configuration (one instance per process on globalThis,
 * ADR-023), so every route bundle writes through the same sink.
 */
export function defaultAuditSink(opts: { databaseUrl?: string; dataDir: string }): AuditSink {
  const key = opts.databaseUrl ? "db" : `jsonl:${opts.dataDir}`;
  const sinks = youcamState().auditSinks;
  let sink = sinks.get(key);
  if (!sink) sinks.set(key, (sink = createDefaultAuditSink(opts)));
  return sink;
}

/** DB sink when DATABASE_URL is configured, else the JSONL fallback. The DB module loads lazily. */
export function createDefaultAuditSink(opts: { databaseUrl?: string; dataDir: string }): AuditSink {
  if (opts.databaseUrl) {
    return new DbAuditSink(async (event) => {
      const { insertAuditEvent } = await import("../../db/audit");
      await insertAuditEvent(event);
    });
  }
  return new JsonlAuditSink(jsonlAuditPath(opts.dataDir));
}

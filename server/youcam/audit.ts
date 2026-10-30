/**
 * Audit trail for every YouCam attempt (allowed, refused, mock, cache hit) and outcome.
 * With STORE=firestore, rows go to the Firestore `audit_log` collection (kept 30 days, counts only);
 * else with DATABASE_URL set, to the Postgres `audit_log` table; otherwise they are appended
 * to <dataDir>/youcam-audit.jsonl (dataDir is gitignored; see config.ts).
 * Entries never contain image bytes, URLs of user images, or the API key.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { isFirestoreStore } from "../store/config";
import { COLLECTIONS, defined, type FsDb } from "../store/firestore-types";
import { getFirestoreDb } from "../store/gcp-clients";
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

/** Writes to Postgres through an injected insert function (see server/db/audit.ts). */
export class DbAuditSink implements AuditSink {
  readonly kind = "db";
  constructor(private readonly insert: AuditRowInsert) {}
  async write(event: AuditEvent) {
    await this.insert(event);
  }
}

/** How long Firestore keeps an audit row (TTL policy on `expiresAt`). */
export const AUDIT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const DETAIL_MAX_CHARS = 2000;

/** Primitive detail values only, bounded in size (no nested payloads). */
function auditDetail(detail: Record<string, unknown> | undefined): Record<string, string | number | boolean | null> | undefined {
  if (!detail) return undefined;
  const out: Record<string, string | number | boolean | null> = {};
  let size = 0;
  for (const [k, v] of Object.entries(detail)) {
    const val = v === null || typeof v === "number" || typeof v === "boolean" ? v : typeof v === "string" ? v.slice(0, 500) : undefined;
    if (val === undefined) continue;
    size += k.length + String(val).length;
    if (size > DETAIL_MAX_CHARS) break;
    out[k] = val;
  }
  return out;
}

/** The Firestore audit_log document for an event: decision, counts and ids only. */
export function firestoreAuditDoc(e: AuditEvent): Record<string, unknown> {
  const ts = new Date(e.ts);
  const at = Number.isFinite(ts.getTime()) ? ts : new Date();
  return defined({
    ts: at,
    expiresAt: new Date(at.getTime() + AUDIT_RETENTION_MS),
    event: e.event,
    mode: e.mode,
    feature: e.feature,
    decision: e.decision,
    reason: e.reason,
    unitsExpected: e.unitsExpected,
    unitsCharged: e.unitsCharged,
    balanceBefore: e.balanceBefore,
    runUnits: e.runUnits,
    taskId: e.taskId,
    status: e.status,
    // No cacheKey: the SHA-256 of a recipient's photo is a stable fingerprint, not needed for 30 days.
    detail: auditDetail(e.detail),
  });
}

/** Writes to Firestore `audit_log` (auto ids). */
export class FirestoreAuditSink implements AuditSink {
  readonly kind = "firestore";
  private seq = 0;
  constructor(private readonly db: () => Promise<FsDb>) {}
  async write(event: AuditEvent) {
    const db = await this.db();
    const id = `${event.ts.replace(/[^0-9]/g, "").slice(0, 17)}-${process.pid}-${this.seq++}-${Math.random().toString(36).slice(2, 10)}`;
    await db.collection(COLLECTIONS.audit).doc(id).set(firestoreAuditDoc(event));
  }
}

export function jsonlAuditPath(dataDir: string): string {
  return path.join(dataDir, "youcam-audit.jsonl");
}

/**
 * The process-wide default sink for this configuration (one instance per process on globalThis,
 * ADR-023), so every route bundle writes through the same sink.
 */
export function defaultAuditSink(opts: { databaseUrl?: string; dataDir: string; firestore?: boolean }): AuditSink {
  const firestore = opts.firestore ?? isFirestoreStore();
  const key = firestore ? "firestore" : opts.databaseUrl ? "db" : `jsonl:${opts.dataDir}`;
  const sinks = youcamState().auditSinks;
  let sink = sinks.get(key);
  if (!sink) sinks.set(key, (sink = createDefaultAuditSink({ ...opts, firestore })));
  return sink;
}

/**
 * Firestore sink with STORE=firestore, else the DB sink when DATABASE_URL is configured, else the JSONL
 * fallback. The DB and Firestore modules load lazily.
 */
export function createDefaultAuditSink(opts: { databaseUrl?: string; dataDir: string; firestore?: boolean }): AuditSink {
  if (opts.firestore ?? isFirestoreStore()) return new FirestoreAuditSink(() => getFirestoreDb());
  if (opts.databaseUrl) {
    return new DbAuditSink(async (event) => {
      const { insertAuditEvent } = await import("../db/audit");
      await insertAuditEvent(event);
    });
  }
  return new JsonlAuditSink(jsonlAuditPath(opts.dataDir));
}

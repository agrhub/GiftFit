/**
 * The small slice of the Firestore Node SDK that GiftFit's adapters use (owner: A11). The real
 * `Firestore` instance is cast to it in firestore-client.ts; unit tests use the in-process fake in
 * server/store/__tests__/fake-firestore.ts, so CI never needs a key, an emulator or the network.
 *
 * Only equality / single-field range / `in` filters are used, which Firestore indexes automatically:
 * no composite index is needed.
 */
export type FsData = Record<string, unknown>;

export type FsOp = "==" | "<" | "<=" | ">" | ">=" | "in";

export interface FsDocSnap {
  readonly id: string;
  readonly exists: boolean;
  data(): FsData | undefined;
}

export interface FsQuerySnap {
  readonly docs: FsDocSnap[];
  readonly size: number;
  readonly empty: boolean;
}

export interface FsQuery {
  where(field: string, op: FsOp, value: unknown): FsQuery;
  limit(n: number): FsQuery;
  get(): Promise<FsQuerySnap>;
}

export interface FsDocRef {
  readonly id: string;
  get(): Promise<FsDocSnap>;
  set(data: FsData, opts?: { merge?: boolean }): Promise<unknown>;
  update(data: FsData): Promise<unknown>;
  delete(): Promise<unknown>;
}

export interface FsCollection extends FsQuery {
  doc(id: string): FsDocRef;
}

/** Firestore rule: every read in a transaction happens before its first write. */
export interface FsTransaction {
  get(ref: FsDocRef): Promise<FsDocSnap>;
  set(ref: FsDocRef, data: FsData, opts?: { merge?: boolean }): unknown;
  update(ref: FsDocRef, data: FsData): unknown;
  delete(ref: FsDocRef): unknown;
}

export interface FsBatch {
  set(ref: FsDocRef, data: FsData, opts?: { merge?: boolean }): unknown;
  delete(ref: FsDocRef): unknown;
  commit(): Promise<unknown>;
}

export interface FsDb {
  collection(name: string): FsCollection;
  runTransaction<T>(fn: (tx: FsTransaction) => Promise<T>): Promise<T>;
  batch(): FsBatch;
}

/** Collection names (fixed; R0 enabled a TTL policy on field `expiresAt` for each). */
export const COLLECTIONS = {
  fitRequests: "fit_requests",
  profiles: "recipient_profiles",
  tryons: "tryons",
  hearts: "hearts",
  wishes: "metal_wishes",
  reports: "fit_reports",
  audit: "audit_log",
  rateLimits: "rate_limits",
  dailyCounters: "daily_counters",
  photoIndex: "photo_index",
} as const;

/** Firestore batches hold at most 500 writes. */
export const MAX_BATCH_WRITES = 450;

/** A Firestore Timestamp, a Date, or an ISO string/ms number back to a Date. */
export function toDate(v: unknown): Date {
  if (v instanceof Date) return new Date(v.getTime());
  if (v && typeof (v as { toDate?: unknown }).toDate === "function") return (v as { toDate(): Date }).toDate();
  if (typeof v === "string" || typeof v === "number") return new Date(v);
  throw new Error("not a timestamp");
}

export function toDateOrNull(v: unknown): Date | null {
  return v === null || v === undefined ? null : toDate(v);
}

/** Drops undefined values (Firestore rejects them unless ignoreUndefinedProperties is on). */
export function defined(data: FsData): FsData {
  const out: FsData = {};
  for (const [k, v] of Object.entries(data)) if (v !== undefined) out[k] = v;
  return out;
}

/** gRPC NOT_FOUND from update()/delete() on a missing document. */
export function isNotFound(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  return e?.code === 5 || e?.code === "not-found" || (typeof e?.message === "string" && /NOT_FOUND/.test(e.message));
}

export function chunks<T>(xs: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/** Deletes refs in batches of MAX_BATCH_WRITES. */
export async function deleteRefs(db: FsDb, refs: readonly FsDocRef[]): Promise<void> {
  for (const part of chunks(refs, MAX_BATCH_WRITES)) {
    const b = db.batch();
    for (const r of part) b.delete(r);
    await b.commit();
  }
}

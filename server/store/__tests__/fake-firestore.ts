/**
 * In-process fake of the Firestore surface in server/store/firestore-types.ts (no network, no emulator).
 * It mimics the behaviours the adapters depend on:
 *   - Dates are stored as Timestamp-like objects (toDate()/toMillis()), as the real SDK returns them;
 *   - undefined fields are dropped (ignoreUndefinedProperties) and nested arrays are rejected;
 *   - update()/delete-in-update on a missing document throws NOT_FOUND (code 5);
 *   - transactions are serialized, writes apply at commit, and a read after a write throws;
 *   - batches apply atomically at commit, <= 500 writes;
 *   - queries support ==, <, <=, >, >=, in (<= 30 values) and limit.
 * `db.docs(collection)` exposes raw stored data for assertions.
 */
import type { FsBatch, FsCollection, FsData, FsDb, FsDocRef, FsDocSnap, FsOp, FsQuery, FsQuerySnap, FsTransaction } from "../firestore-types";

export class FakeTimestamp {
  constructor(readonly ms: number) {}
  toDate(): Date {
    return new Date(this.ms);
  }
  toMillis(): number {
    return this.ms;
  }
}

function encode(v: unknown, depth = 0, inArray = false): unknown {
  if (v instanceof Date) return new FakeTimestamp(v.getTime());
  if (v instanceof FakeTimestamp) return v;
  if (Array.isArray(v)) {
    if (inArray) throw new Error("Firestore: nested arrays are not supported");
    return v.filter((x) => x !== undefined).map((x) => encode(x, depth + 1, true));
  }
  if (v && typeof v === "object") {
    if (depth > 18) throw new Error("Firestore: too deep");
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = encode(x, depth + 1, false);
    return out;
  }
  if (typeof v === "function" || typeof v === "symbol" || typeof v === "bigint") throw new Error("Firestore: unsupported value");
  return v;
}

function clone(v: unknown): unknown {
  if (v instanceof FakeTimestamp) return new FakeTimestamp(v.ms);
  if (Array.isArray(v)) return v.map(clone);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]));
  return v;
}

const cmp = (v: unknown): unknown => (v instanceof FakeTimestamp ? v.ms : v instanceof Date ? v.getTime() : v);

function matches(data: FsData, field: string, op: FsOp, value: unknown): boolean {
  if (!(field in data)) return false;
  const a = cmp(data[field]);
  if (op === "in") return (value as unknown[]).map(cmp).includes(a);
  const b = cmp(value);
  if (op === "==") return a === b;
  if (typeof a !== typeof b || a === null) return false;
  const x = a as number | string;
  const y = b as number | string;
  return op === "<" ? x < y : op === "<=" ? x <= y : op === ">" ? x > y : x >= y;
}

class NotFound extends Error {
  code = 5;
  constructor(path: string) {
    super(`5 NOT_FOUND: No document to update: ${path}`);
  }
}

type Write = { kind: "set"; path: [string, string]; data: FsData; merge: boolean } | { kind: "update"; path: [string, string]; data: FsData } | { kind: "delete"; path: [string, string] };

export class FakeFirestore implements FsDb {
  readonly store = new Map<string, Map<string, FsData>>();
  readonly stats = { reads: 0, writes: 0, transactions: 0, queries: 0 };
  /** Filter fields of every query run (a query on 2+ different fields would need a composite index). */
  readonly queryLog: Array<{ collection: string; fields: string[] }> = [];
  private chain: Promise<unknown> = Promise.resolve();
  /** Tests: throw from every operation (store outage). */
  failing = false;

  private col(name: string): Map<string, FsData> {
    let m = this.store.get(name);
    if (!m) this.store.set(name, (m = new Map()));
    return m;
  }

  check(): void {
    if (this.failing) throw Object.assign(new Error("14 UNAVAILABLE: fake outage"), { code: 14 });
  }

  /** Raw documents of a collection (Timestamps as FakeTimestamp). */
  docs(name: string): Array<{ id: string; data: FsData }> {
    return [...this.col(name).entries()].map(([id, data]) => ({ id, data: clone(data) as FsData }));
  }

  snap(name: string, id: string): FsDocSnap {
    this.check();
    this.stats.reads++;
    const d = this.col(name).get(id);
    return { id, exists: d !== undefined, data: () => (d ? (clone(d) as FsData) : undefined) };
  }

  apply(w: Write): void {
    this.check();
    this.stats.writes++;
    const [c, id] = w.path;
    const m = this.col(c);
    if (w.kind === "delete") {
      m.delete(id);
      return;
    }
    if (w.kind === "update") {
      const cur = m.get(id);
      if (!cur) throw new NotFound(`${c}/${id}`);
      m.set(id, { ...cur, ...(encode(w.data) as FsData) });
      return;
    }
    const data = encode(w.data) as FsData;
    m.set(id, w.merge ? { ...(m.get(id) ?? {}), ...data } : data);
  }

  collection(name: string): FsCollection {
    if (!name || name.includes("/")) throw new Error("bad collection");
    return new FakeCollection(this, name, []);
  }

  batch(): FsBatch {
    const writes: Write[] = [];
    const b: FsBatch = {
      set: (ref, data, opts) => {
        writes.push({ kind: "set", path: pathOf(ref), data, merge: Boolean(opts?.merge) });
        return b;
      },
      delete: (ref) => {
        writes.push({ kind: "delete", path: pathOf(ref) });
        return b;
      },
      commit: async () => {
        this.check();
        if (writes.length > 500) throw new Error("Firestore: a batch holds at most 500 writes");
        // Validate everything first so the batch is all-or-nothing.
        for (const w of writes) if (w.kind === "set") encode(w.data);
        for (const w of writes) this.apply(w);
        return [];
      },
    };
    return b;
  }

  runTransaction<T>(fn: (tx: FsTransaction) => Promise<T>): Promise<T> {
    const run = async () => {
      this.check();
      this.stats.transactions++;
      const writes: Write[] = [];
      const tx: FsTransaction = {
        get: async (ref) => {
          if (writes.length) throw new Error("Firestore transactions require all reads to be executed before all writes.");
          const [c, id] = pathOf(ref);
          return this.snap(c, id);
        },
        set: (ref, data, opts) => {
          writes.push({ kind: "set", path: pathOf(ref), data, merge: Boolean(opts?.merge) });
          return tx;
        },
        update: (ref, data) => {
          writes.push({ kind: "update", path: pathOf(ref), data });
          return tx;
        },
        delete: (ref) => {
          writes.push({ kind: "delete", path: pathOf(ref) });
          return tx;
        },
      };
      const out = await fn(tx);
      for (const w of writes) if (w.kind === "set" || w.kind === "update") encode(w.data);
      for (const w of writes) this.apply(w);
      return out;
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }
}

const PATH = Symbol("path");
function pathOf(ref: FsDocRef): [string, string] {
  const p = (ref as unknown as { [PATH]?: [string, string] })[PATH];
  if (!p) throw new Error("not a fake document reference");
  return p;
}

class FakeQuery implements FsQuery {
  constructor(
    protected readonly db: FakeFirestore,
    protected readonly name: string,
    protected readonly filters: ReadonlyArray<{ field: string; op: FsOp; value: unknown }>,
    protected readonly max?: number,
  ) {}

  where(field: string, op: FsOp, value: unknown): FsQuery {
    if (op === "in" && (!Array.isArray(value) || value.length === 0 || value.length > 30)) throw new Error("Firestore: 'in' needs 1..30 values");
    if (value === undefined) throw new Error("Firestore: undefined in a filter");
    return new FakeQuery(this.db, this.name, [...this.filters, { field, op, value }], this.max);
  }

  limit(n: number): FsQuery {
    return new FakeQuery(this.db, this.name, this.filters, n);
  }

  async get(): Promise<FsQuerySnap> {
    this.db.check();
    this.db.stats.queries++;
    this.db.queryLog.push({ collection: this.name, fields: this.filters.map((f) => f.field) });
    const all = this.db.docs(this.name).filter((d) => this.filters.every((f) => matches(d.data, f.field, f.op, f.value)));
    // Firestore orders by document id when no orderBy is given.
    all.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const docs = (this.max === undefined ? all : all.slice(0, this.max)).map((d) => this.db.snap(this.name, d.id));
    return { docs, size: docs.length, empty: docs.length === 0 };
  }
}

class FakeCollection extends FakeQuery implements FsCollection {
  doc(id: string): FsDocRef {
    if (!id || id.includes("/")) throw new Error("Firestore: invalid document id");
    const db = this.db;
    const name = this.name;
    const ref = {
      id,
      [PATH]: [name, id] as [string, string],
      get: async () => db.snap(name, id),
      set: async (data: FsData, opts?: { merge?: boolean }) => db.apply({ kind: "set", path: [name, id], data, merge: Boolean(opts?.merge) }),
      update: async (data: FsData) => db.apply({ kind: "update", path: [name, id], data }),
      delete: async () => db.apply({ kind: "delete", path: [name, id] }),
    };
    return ref as unknown as FsDocRef;
  }
}

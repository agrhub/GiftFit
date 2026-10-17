/**
 * Durable per-day counters with a cap (owner: A11). Used by the YouCam cost guard for
 * YOUCAM_DAILY_UNIT_CAP (`youcam-<YYYY-MM-DD>`), and meant for the daily Anthropic spend cap
 * (`anthropic-<YYYY-MM-DD>`, ADR-040; not wired yet).
 *
 * Pattern: tryReserve() BEFORE the paid call (atomic check-and-add: a Firestore transaction), refund()
 * when the call did not cost anything. Counts survive cold starts; with STORE=memory they do not.
 * Documents: daily_counters/{key} = { key, used, cap, updatedAt, expiresAt } with expiresAt three days
 * after the counted UTC day (TTL backstop; only today's document is ever read).
 */
import { isFirestoreStore, type Env } from "./config";
import { COLLECTIONS, type FsDb } from "./firestore-types";
import { getFirestoreDb } from "./gcp-clients";

export interface CounterDecision {
  ok: boolean;
  /** Units counted on the key after this call (unchanged when refused). */
  used: number;
  cap: number;
}

export interface DailyCounterStore {
  readonly kind: string;
  /** Current count (0 if none). */
  get(key: string): Promise<number>;
  /**
   * Adds `amount` iff used + amount <= cap (cap <= 0 = no cap). Atomic: two concurrent reservations
   * can never both pass the cap.
   */
  tryReserve(key: string, amount: number, cap: number): Promise<CounterDecision>;
  /** Gives `amount` back (never below 0). Returns the new count. */
  refund(key: string, amount: number): Promise<number>;
}

const KEY = /^[a-z][a-z0-9-]{0,62}$/;

export function assertCounterKey(key: string): void {
  if (!KEY.test(key)) throw new Error("invalid counter key");
}

function assertAmount(amount: number): void {
  if (!Number.isFinite(amount) || amount < 0) throw new Error("counter amount must be a non-negative number");
}

/** `<prefix>-<YYYY-MM-DD>` for the UTC day of `nowMs`. */
export function dailyCounterKey(prefix: string, nowMs: number = Date.now()): string {
  const key = `${prefix}-${new Date(nowMs).toISOString().slice(0, 10)}`;
  assertCounterKey(key);
  return key;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** TTL for a counter document: 3 days after the end of the day in its key (or after now). */
export function counterExpiresAt(key: string, nowMs: number = Date.now()): Date {
  const m = /(\d{4}-\d{2}-\d{2})$/.exec(key);
  const dayStart = m ? Date.parse(`${m[1]}T00:00:00.000Z`) : NaN;
  return new Date((Number.isFinite(dayStart) ? dayStart + DAY_MS : nowMs) + 3 * DAY_MS);
}

export class MemoryDailyCounterStore implements DailyCounterStore {
  readonly kind = "memory";
  readonly counts = new Map<string, number>();

  async get(key: string): Promise<number> {
    assertCounterKey(key);
    return this.counts.get(key) ?? 0;
  }

  async tryReserve(key: string, amount: number, cap: number): Promise<CounterDecision> {
    assertCounterKey(key);
    assertAmount(amount);
    const used = this.counts.get(key) ?? 0;
    if (cap > 0 && used + amount > cap) return { ok: false, used, cap };
    this.counts.set(key, used + amount);
    return { ok: true, used: used + amount, cap };
  }

  async refund(key: string, amount: number): Promise<number> {
    assertCounterKey(key);
    assertAmount(amount);
    const next = Math.max(0, (this.counts.get(key) ?? 0) - amount);
    this.counts.set(key, next);
    return next;
  }
}

export class FirestoreDailyCounterStore implements DailyCounterStore {
  readonly kind = "firestore";

  constructor(
    private readonly db: () => Promise<FsDb>,
    private readonly now: () => number = Date.now,
  ) {}

  private async ref(key: string) {
    assertCounterKey(key);
    return (await this.db()).collection(COLLECTIONS.dailyCounters).doc(key);
  }

  async get(key: string): Promise<number> {
    const s = await (await this.ref(key)).get();
    return s.exists ? Number(s.data()?.used ?? 0) : 0;
  }

  async tryReserve(key: string, amount: number, cap: number): Promise<CounterDecision> {
    assertAmount(amount);
    const ref = await this.ref(key);
    return (await this.db()).runTransaction(async (tx) => {
      const s = await tx.get(ref);
      const used = s.exists ? Number(s.data()?.used ?? 0) : 0;
      if (cap > 0 && used + amount > cap) return { ok: false, used, cap };
      const now = this.now();
      tx.set(ref, { key, used: used + amount, cap, updatedAt: new Date(now), expiresAt: counterExpiresAt(key, now) });
      return { ok: true, used: used + amount, cap };
    });
  }

  async refund(key: string, amount: number): Promise<number> {
    assertAmount(amount);
    const ref = await this.ref(key);
    return (await this.db()).runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (!s.exists) return 0;
      const next = Math.max(0, Number(s.data()?.used ?? 0) - amount);
      tx.update(ref, { used: next, updatedAt: new Date(this.now()) });
      return next;
    });
  }
}

const COUNTER_STATE_KEY = Symbol.for("giftfit.store.daily-counter.v1");

/**
 * The process-wide durable counter store: Firestore with STORE=firestore, else undefined (callers keep
 * their in-memory counting, as before A11).
 */
export function defaultDailyCounterStore(env: Env = process.env): DailyCounterStore | undefined {
  if (!isFirestoreStore(env)) return undefined;
  const g = globalThis as typeof globalThis & { [COUNTER_STATE_KEY]?: DailyCounterStore };
  return (g[COUNTER_STATE_KEY] ??= new FirestoreDailyCounterStore(() => getFirestoreDb(env)));
}

/**
 * YOUCAM_DAILY_UNIT_CAP against a durable counter (A11): the cap holds across process restarts
 * (a new CostGuard with a fresh ledger = a Cloud Run cold start), reservations are atomic in the
 * store, errors refund, and a store outage refuses the paid call (fail closed).
 */
import { describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/store/__tests__/fake-firestore";
import { FirestoreDailyCounterStore, MemoryDailyCounterStore, type DailyCounterStore } from "@/lib/store/daily-counter";
import { MemoryAuditSink } from "../audit";
import { YoucamClient } from "../client";
import { FEATURE_COST_SNAPSHOT } from "../costs";
import { CostGuard, type CostGuardOptions } from "../cost-guard";
import { CostGuardError, DailyCapError } from "../errors";

const DAY1 = Date.parse("2026-10-16T22:00:00Z");
const DAY2 = Date.parse("2026-10-17T00:00:05Z");
/** Shared fake database for the parameterised suite below (reset in each test). */
let db = new FakeFirestore();
const TONES = { feature: "skin-tone-analysis" as const, tier: {} }; // 20 units

function guard(counter: DailyCounterStore | undefined, over: Partial<CostGuardOptions> = {}, clock = { t: DAY1 }) {
  const audit = new MemoryAuditSink();
  const fetchBalance = vi.fn(async () => ({ units: 10_000, byType: {} }));
  const g = new CostGuard({
    allowPaid: true,
    hasApiKey: true,
    reserveUnits: 300,
    maxUnitsPerRun: 1_000,
    dailyUnitCap: 50,
    audit,
    fetchBalance,
    fetchFeatureCosts: async () => [...FEATURE_COST_SNAPSHOT],
    dailyCounter: counter,
    now: () => clock.t,
    ...over,
  });
  return { g, audit, fetchBalance, clock };
}

describe.each([
  { name: "memory counter", make: () => new MemoryDailyCounterStore() as DailyCounterStore },
  { name: "Firestore counter (fake)", make: () => new FirestoreDailyCounterStore(async () => db, () => DAY1) as DailyCounterStore },
])("CostGuard + durable daily counter: $name", ({ make }) => {
  it("holds the cap across a restart and refuses before the balance lookup", async () => {
    db = new FakeFirestore();
    const counter = make();
    const first = guard(counter);
    const a = await first.g.authorize(TONES.feature, TONES.tier);
    await first.g.settle(a, { status: "success", taskId: "t1" });
    const b = await first.g.authorize(TONES.feature, TONES.tier);
    await first.g.settle(b, { status: "success", taskId: "t2" });
    expect(await counter.get("youcam-2026-10-16")).toBe(40);

    // Cold start: new guard, fresh ledger (dayCommitted 0), same durable counter.
    const second = guard(counter);
    expect(second.g.unitsToday).toBe(0);
    const err = await second.g.authorize(TONES.feature, TONES.tier).catch((e) => e);
    expect(err).toBeInstanceOf(DailyCapError);
    expect(err).toMatchObject({ reason: "daily_cap", dayUnits: 40, dailyUnitCap: 50, unitsExpected: 20 });
    expect(second.fetchBalance).not.toHaveBeenCalled();
    expect(second.audit.events.at(-1)).toMatchObject({ decision: "refused", reason: "daily_cap" });
    expect(await counter.get("youcam-2026-10-16")).toBe(40);

    // A new UTC day starts from zero.
    const third = guard(counter, {}, { t: DAY2 });
    await expect(third.g.authorize(TONES.feature, TONES.tier)).resolves.toMatchObject({ units: 20, day: "2026-10-17" });
    expect(await counter.get("youcam-2026-10-17")).toBe(20);
  });

  it("refunds the store when a task errors, keeps timeouts counted", async () => {
    db = new FakeFirestore();
    const counter = make();
    const { g } = guard(counter);
    const r = await g.authorize(TONES.feature, TONES.tier);
    expect(await counter.get("youcam-2026-10-16")).toBe(20);
    await g.settle(r, { status: "error", taskId: "t" });
    expect(await counter.get("youcam-2026-10-16")).toBe(0);
    const t = await g.authorize(TONES.feature, TONES.tier);
    await g.settle(t, { status: "timeout", taskId: "t2" });
    expect(await counter.get("youcam-2026-10-16")).toBe(20);
  });

  it("is authoritative when another process consumed the day meanwhile (atomic reserve)", async () => {
    db = new FakeFirestore();
    const counter = make();
    const { g } = guard(counter);
    // Another instance reserves between this guard's read and its reserve.
    const orig = counter.get.bind(counter);
    counter.get = async (key: string) => {
      const v = await orig(key);
      await counter.tryReserve(key, 40, 50);
      return v;
    };
    const err = await g.authorize(TONES.feature, TONES.tier).catch((e) => e);
    expect(err).toBeInstanceOf(DailyCapError);
    expect(err.dayUnits).toBe(40);
    expect(g.unitsCommitted).toBe(0); // local reservation rolled back
    expect(await orig("youcam-2026-10-16")).toBe(40);
  });
});

describe("CostGuard durable counter failures", () => {
  it("refuses (fail closed) when the counter cannot be read or written, and releases the local reservation", async () => {
    const store = new FakeFirestore();
    const counter = new FirestoreDailyCounterStore(async () => store, () => DAY1);
    store.failing = true;
    const { g, audit, fetchBalance } = guard(counter);
    const err = await g.authorize(TONES.feature, TONES.tier).catch((e) => e);
    expect(err).toBeInstanceOf(CostGuardError);
    expect(err).not.toBeInstanceOf(DailyCapError);
    expect(err.reason).toBe("daily_counter_unavailable");
    expect(fetchBalance).not.toHaveBeenCalled();
    expect(audit.events.at(-1)).toMatchObject({ decision: "refused", reason: "daily_counter_unavailable" });
    expect(g.unitsCommitted).toBe(0);

    // Readable but not writable: refused after the balance check, nothing left reserved.
    store.failing = false;
    counter.tryReserve = async () => Promise.reject(new Error("write failed"));
    const err2 = await g.authorize(TONES.feature, TONES.tier).catch((e) => e);
    expect(err2.reason).toBe("daily_counter_unavailable");
    expect(g.unitsCommitted).toBe(0);
    expect(g.unitsToday).toBe(0);
  });

  it("refunds the store when the 'allowed' audit row cannot be written", async () => {
    const counter = new MemoryDailyCounterStore();
    const audit = { kind: "broken", write: vi.fn(async (e: { decision?: string }) => (e.decision === "allowed" ? Promise.reject(new Error("audit down")) : undefined)) };
    const { g } = guard(counter, { audit });
    await expect(g.authorize(TONES.feature, TONES.tier)).rejects.toThrow(/audit down/);
    expect(await counter.get("youcam-2026-10-16")).toBe(0);
    expect(g.unitsCommitted).toBe(0);
  });

  it("does not use the counter when the daily cap is disabled", async () => {
    const counter = new MemoryDailyCounterStore();
    const spy = vi.spyOn(counter, "tryReserve");
    const { g } = guard(counter, { dailyUnitCap: 0 });
    await g.authorize(TONES.feature, TONES.tier);
    expect(spy).not.toHaveBeenCalled();
  });

  it("preflight reports the durable count without reserving", async () => {
    const counter = new MemoryDailyCounterStore();
    await counter.tryReserve("youcam-2026-10-16", 45, 50);
    const { g } = guard(counter);
    const d = await g.preflight([TONES]);
    expect(d).toMatchObject({ allowed: false, reason: "daily_cap", dayUnits: 45 });
    expect(await counter.get("youcam-2026-10-16")).toBe(45);
  });
});

describe("YoucamClient wiring", () => {
  it("passes an injected durable counter to its guard; isolated clients default to none", async () => {
    const counter = new MemoryDailyCounterStore();
    const c = new YoucamClient({ state: "isolated", config: { mock: true }, dailyCounter: counter, cache: null, audit: new MemoryAuditSink(), limiter: null });
    expect((c.guard as unknown as { opts: CostGuardOptions }).opts.dailyCounter).toBe(counter);
    const iso = new YoucamClient({ state: "isolated", config: { mock: true }, cache: null, audit: new MemoryAuditSink(), limiter: null });
    expect((iso.guard as unknown as { opts: CostGuardOptions }).opts.dailyCounter).toBeUndefined();
  });
});

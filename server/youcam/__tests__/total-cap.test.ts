/**
 * YOUCAM_TOTAL_UNIT_CAP (A16): a durable cap across days on top of the daily one. Reserved atomically after the
 * daily reservation, refunded on task errors, and a store failure refuses (fail closed). 0 units: the guard only.
 */
import { describe, expect, it, vi } from "vitest";
import { MemoryDailyCounterStore, type DailyCounterStore } from "@/server/store/daily-counter";
import { MemoryAuditSink } from "../audit";
import { FEATURE_COST_SNAPSHOT } from "../costs";
import { CostGuard, TOTAL_COUNTER_KEY } from "../cost-guard";
import { CostGuardError } from "../errors";

const DAY1 = Date.parse("2026-11-01T10:00:00Z");
const DAY2 = Date.parse("2026-11-02T10:00:00Z");

function guard(counter: DailyCounterStore, clock = { t: DAY1 }, totalUnitCap = 50) {
  return new CostGuard({
    allowPaid: true,
    hasApiKey: true,
    reserveUnits: 0,
    maxUnitsPerRun: 1_000,
    dailyUnitCap: 150,
    totalUnitCap,
    audit: new MemoryAuditSink(),
    fetchBalance: async () => ({ units: 10_000, byType: {} }),
    fetchFeatureCosts: async () => [...FEATURE_COST_SNAPSHOT],
    dailyCounter: counter,
    now: () => clock.t,
  });
}

describe("total unit cap", () => {
  it("holds across days and restarts; refusal gives the daily reservation back", async () => {
    const counter = new MemoryDailyCounterStore();
    const g1 = guard(counter);
    for (let i = 0; i < 2; i++) await g1.settle(await g1.authorize("skin-tone-analysis", {}), { status: "success", taskId: `t${i}` });
    expect(await counter.get(TOTAL_COUNTER_KEY)).toBe(40);
    // Next day, new process: the daily count is fresh, the total is not.
    const g2 = guard(counter, { t: DAY2 });
    const err = await g2.authorize("skin-tone-analysis", {}).catch((e) => e);
    expect(err).toBeInstanceOf(CostGuardError);
    expect(err).toMatchObject({ reason: "total_cap" });
    expect(await counter.get("youcam-2026-11-02")).toBe(0); // refunded
    expect(g2.unitsCommitted).toBe(0);
    // A 1-unit try-on still fits under 50.
    await expect(g2.authorize("2d-vto/earring", { variant: "Single" })).resolves.toMatchObject({ units: 1 });
    expect(await counter.get(TOTAL_COUNTER_KEY)).toBe(41);
  });

  it("an errored task refunds the total too; 0 disables the cap", async () => {
    const counter = new MemoryDailyCounterStore();
    const g = guard(counter);
    const r = await g.authorize("skin-tone-analysis", {});
    expect(await counter.get(TOTAL_COUNTER_KEY)).toBe(20);
    await g.settle(r, { status: "error", taskId: "t" });
    expect(await counter.get(TOTAL_COUNTER_KEY)).toBe(0);
    const off = guard(new MemoryDailyCounterStore(), { t: DAY1 }, 0);
    for (let i = 0; i < 4; i++) await off.authorize("skin-tone-analysis", {});
  });

  it("fails closed when the total counter can't be written", async () => {
    const counter = new MemoryDailyCounterStore();
    const broken: DailyCounterStore = {
      kind: "broken",
      get: (k) => counter.get(k),
      refund: (k, n) => counter.refund(k, n),
      tryReserve: vi.fn(async (k, n, cap) => {
        if (k === TOTAL_COUNTER_KEY) throw new Error("firestore down");
        return counter.tryReserve(k, n, cap);
      }),
    };
    const err = await guard(broken).authorize("skin-tone-analysis", {}).catch((e) => e);
    expect(err).toMatchObject({ reason: "daily_counter_unavailable" });
    expect(await counter.get("youcam-2026-11-01")).toBe(0); // the daily reservation was given back
  });
});

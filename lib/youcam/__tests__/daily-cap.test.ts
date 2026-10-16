import { describe, expect, it, vi } from "vitest";
import { MemoryAuditSink } from "../audit";
import { YoucamClient } from "../client";
import { loadYoucamConfig, type YoucamConfig } from "../config";
import { FEATURE_COST_SNAPSHOT } from "../costs";
import { CostGuard, type CostGuardOptions } from "../cost-guard";
import { CostGuardError, DailyCapError } from "../errors";
import { runTryOns } from "../fit-request";
import { newLedger } from "../global-state";
import { FakeYoucamApi } from "./fake-api";

const DAY1 = Date.parse("2026-10-16T22:00:00Z");
const DAY2 = Date.parse("2026-10-17T00:00:05Z");

function guard(over: Partial<CostGuardOptions> = {}, clock = { t: DAY1 }) {
  const audit = new MemoryAuditSink();
  const fetchBalance = vi.fn(async () => ({ units: 10_000, byType: {} }));
  const fetchFeatureCosts = vi.fn(async () => [...FEATURE_COST_SNAPSHOT]);
  const g = new CostGuard({
    allowPaid: true,
    hasApiKey: true,
    reserveUnits: 300,
    maxUnitsPerRun: 1_000,
    dailyUnitCap: 50,
    audit,
    fetchBalance,
    fetchFeatureCosts,
    now: () => clock.t,
    ...over,
  });
  return { g, audit, fetchBalance, fetchFeatureCosts, clock };
}

const TONES = { feature: "skin-tone-analysis" as const, tier: {} }; // 20
const ATTRS = { feature: "face-attr-analysis" as const, tier: { count: 5 } }; // 10

describe("YOUCAM_DAILY_UNIT_CAP config", () => {
  it("defaults to 150 in real mode, disabled in mock mode, 0 disables", () => {
    expect(loadYoucamConfig({ YOUCAM_MOCK: "0" }).dailyUnitCap).toBe(150);
    expect(loadYoucamConfig({}).dailyUnitCap).toBe(0);
    expect(loadYoucamConfig({ YOUCAM_MOCK: "0", YOUCAM_DAILY_UNIT_CAP: "0" }).dailyUnitCap).toBe(0);
    expect(loadYoucamConfig({ YOUCAM_MOCK: "1", YOUCAM_DAILY_UNIT_CAP: "20" }).dailyUnitCap).toBe(20);
    expect(() => loadYoucamConfig({ YOUCAM_DAILY_UNIT_CAP: "-5" })).toThrow(/YOUCAM_DAILY_UNIT_CAP/);
    // unchanged neighbours
    expect(loadYoucamConfig({ YOUCAM_MOCK: "0" })).toMatchObject({ reserveUnits: 300, maxUnitsPerRun: 40 });
  });
});

describe("CostGuard daily cap", () => {
  it("refuses once today's committed + cost > cap, audits it like the reserve floor, and throws DailyCapError", async () => {
    const { g, audit } = guard();
    const a = await g.authorize(TONES.feature, TONES.tier); // 20
    await g.settle(a, { status: "success", taskId: "t1" });
    const b = await g.authorize(TONES.feature, TONES.tier); // 40
    await g.settle(b, { status: "success", taskId: "t2" });
    expect(g.unitsToday).toBe(40);
    await expect(g.authorize(ATTRS.feature, ATTRS.tier)).resolves.toMatchObject({ units: 10, day: "2026-10-16" }); // exactly 50 is allowed
    const err = await g.authorize(ATTRS.feature, ATTRS.tier).catch((e) => e);
    expect(err).toBeInstanceOf(DailyCapError);
    expect(err).toBeInstanceOf(CostGuardError);
    expect(err).toMatchObject({ reason: "daily_cap", feature: "face-attr-analysis", unitsExpected: 10, dayUnits: 50, dailyUnitCap: 50 });
    expect(audit.events.at(-1)).toMatchObject({
      event: "youcam.attempt",
      decision: "refused",
      reason: "daily_cap",
      unitsExpected: 10,
      detail: { message: expect.stringContaining("YOUCAM_DAILY_UNIT_CAP 50") },
    });
  });

  it("counts in-flight units and releases them only for errors on the same day", async () => {
    const { g, clock } = guard({ dailyUnitCap: 30 });
    const inFlight = await g.authorize(TONES.feature, TONES.tier); // 20 in flight, not settled
    expect(g.unitsToday).toBe(20);
    await expect(g.authorize(TONES.feature, TONES.tier)).rejects.toBeInstanceOf(DailyCapError);
    await g.settle(inFlight, { status: "error", taskId: "t" });
    expect(g.unitsToday).toBe(0);
    const timedOut = await g.authorize(TONES.feature, TONES.tier);
    await g.settle(timedOut, { status: "timeout", taskId: "t2" });
    expect(g.unitsToday).toBe(20); // a timeout may still be charged: stays counted

    // a reservation from yesterday that fails today does not reduce today's count
    const late = await g.authorize(ATTRS.feature, ATTRS.tier); // 30 today
    clock.t = DAY2;
    const today = await g.authorize(TONES.feature, TONES.tier); // new day: 20
    await g.settle(late, { status: "error", taskId: "t3" });
    expect(g.unitsToday).toBe(20);
    expect(today.day).toBe("2026-10-17");
  });

  it("resets at the UTC day boundary", async () => {
    const { g, clock } = guard({ dailyUnitCap: 20 });
    await g.authorize(TONES.feature, TONES.tier);
    await expect(g.authorize(TONES.feature, TONES.tier)).rejects.toMatchObject({ reason: "daily_cap" });
    clock.t = Date.parse("2026-10-16T23:59:59Z");
    await expect(g.authorize(TONES.feature, TONES.tier)).rejects.toMatchObject({ reason: "daily_cap" });
    clock.t = DAY2;
    expect(g.unitsToday).toBe(0);
    await expect(g.authorize(TONES.feature, TONES.tier)).resolves.toMatchObject({ day: "2026-10-17" });
  });

  it("lets only one of two racing tasks past the cap", async () => {
    const { g } = guard({ dailyUnitCap: 30 });
    const results = await Promise.allSettled([g.authorize(TONES.feature, TONES.tier), g.authorize(TONES.feature, TONES.tier)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toBeInstanceOf(DailyCapError);
    expect(g.unitsToday).toBe(20);
  });

  it("refuses without a balance lookup once prices are cached, and is shared through the ledger", async () => {
    const ledger = newLedger();
    const one = guard({ ledger, dailyUnitCap: 20 });
    await one.g.authorize(TONES.feature, TONES.tier);
    const two = guard({ ledger, dailyUnitCap: 20 });
    await two.g.quote(TONES.feature, TONES.tier); // warm the shared price cache
    two.fetchBalance.mockClear();
    await expect(two.g.authorize(ATTRS.feature, ATTRS.tier)).rejects.toBeInstanceOf(DailyCapError);
    expect(two.fetchBalance).not.toHaveBeenCalled();
  });

  it("is reported by preflight, and disabled when the cap is 0", async () => {
    const { g } = guard({ dailyUnitCap: 25 });
    await expect(g.preflight([TONES, ATTRS])).resolves.toMatchObject({ allowed: false, reason: "daily_cap", dayUnits: 0, dailyUnitCap: 25 });
    const off = guard({ allowPaid: false, dailyUnitCap: 25 });
    const d = await off.g.preflight([TONES, ATTRS]);
    expect(d).toMatchObject({ allowed: false, reason: "paid_calls_disabled" });
    expect(d.message).toMatch(/daily cap/);
    const none = guard({ dailyUnitCap: 0 });
    for (let i = 0; i < 5; i++) await none.g.authorize(TONES.feature, TONES.tier);
    expect(none.g.unitsToday).toBe(100);
    const undef = guard({ dailyUnitCap: undefined });
    await expect(undef.g.authorize(TONES.feature, TONES.tier)).resolves.toBeDefined();
  });

  it("releases today's count when the allowed audit write fails", async () => {
    const { g } = guard({ audit: { kind: "x", write: async () => Promise.reject(new Error("down")) } });
    await expect(g.authorize(TONES.feature, TONES.tier)).rejects.toThrow("down");
    expect(g.unitsToday).toBe(0);
  });
});

describe("client: refused by the daily cap means no YouCam call", () => {
  const REAL: Partial<YoucamConfig> = {
    mock: false,
    allowPaid: true,
    apiKey: "k",
    baseUrl: "https://api.test",
    reserveUnits: 300,
    maxUnitsPerRun: 40,
    dailyUnitCap: 21,
    pollIntervalMs: 1,
    maxPolls: 2,
  };
  const face = { bytes: new Uint8Array([0xff, 0xd8, 0xff, 1]), contentType: "image/jpeg" as const };

  it("uploads nothing and creates no task; try-ons report code daily_cap", async () => {
    const api = new FakeYoucamApi({ runningPolls: 0 });
    const client = new YoucamClient({
      config: REAL,
      fetch: api.fetch,
      sleep: async () => {},
      audit: new MemoryAuditSink(),
      cache: null,
      limiter: null,
      state: "isolated",
    });
    await client.facialColorTones(face); // 20 of 21
    const before = api.calls.length;
    const err = await client.faceAttributes(face).catch((e) => e);
    expect(err).toBeInstanceOf(DailyCapError);
    expect(api.calls.slice(before).filter((c) => c.method !== "GET")).toEqual([]);
    expect(api.calls.slice(before)).toEqual([]); // prices cached: no request at all
    const [t] = await runTryOns(client, { face }, [{ id: "e", kind: "earring", product: { url: "https://shop.test/e.png" } }]);
    expect(t).toMatchObject({ ok: true }); // 1 unit fits exactly (21)
    const [u] = await runTryOns(client, { face }, [{ id: "n", kind: "necklace", product: { url: "https://shop.test/n.png" } }]);
    expect(u).toMatchObject({ ok: false, code: "daily_cap" });
    expect(api.callsTo("POST", /task\/2d-vto\/necklace/)).toHaveLength(0);
  });
});

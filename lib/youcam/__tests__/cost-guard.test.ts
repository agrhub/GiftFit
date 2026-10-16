import { describe, expect, it, vi } from "vitest";
import { MemoryAuditSink, type AuditSink } from "../audit";
import { FEATURE_COST_SNAPSHOT } from "../costs";
import { CostGuard, type CostGuardOptions } from "../cost-guard";
import { CostGuardError } from "../errors";

const FULL = { versionLabel: "V2.1", quality: "HD" as const, count: 16 };

function guard(over: Partial<CostGuardOptions> = {}) {
  const audit = new MemoryAuditSink();
  const fetchBalance = vi.fn(async () => ({ units: 1000, byType: {} }));
  const fetchFeatureCosts = vi.fn(async () => [...FEATURE_COST_SNAPSHOT]);
  const g = new CostGuard({
    allowPaid: true,
    hasApiKey: true,
    reserveUnits: 280,
    maxUnitsPerRun: 60,
    audit,
    fetchBalance,
    fetchFeatureCosts,
    ...over,
  });
  return { g, audit, fetchBalance, fetchFeatureCosts };
}

async function refusal(p: Promise<unknown>): Promise<CostGuardError> {
  const err = await p.catch((e) => e);
  expect(err).toBeInstanceOf(CostGuardError);
  return err as CostGuardError;
}

describe("CostGuard.authorize", () => {
  it("refuses without network when paid calls are disabled, and audits it", async () => {
    const { g, audit, fetchBalance, fetchFeatureCosts } = guard({ allowPaid: false });
    const err = await refusal(g.authorize("skin-analysis", FULL, "k1"));
    expect(err).toMatchObject({ reason: "paid_calls_disabled", unitsExpected: 22, feature: "skin-analysis" });
    expect(fetchBalance).not.toHaveBeenCalled();
    expect(fetchFeatureCosts).not.toHaveBeenCalled();
    expect(audit.events).toEqual([
      expect.objectContaining({ event: "youcam.attempt", decision: "refused", reason: "paid_calls_disabled", unitsExpected: 22, cacheKey: "k1", mode: "real" }),
    ]);
  });

  it("refuses without an API key or a known price", async () => {
    expect((await refusal(guard({ hasApiKey: false }).g.authorize("makeup-vto", {}))).reason).toBe("missing_api_key");
    expect((await refusal(guard().g.authorize("face-attr-analysis", { count: 40 }))).reason).toBe("unknown_cost");
    const failing = guard({ fetchFeatureCosts: async () => Promise.reject(new Error("down")) });
    expect((await refusal(failing.g.authorize("makeup-vto", {}))).message).toMatch(/feature-cost lookup failed: down/);
    const noBalance = guard({ fetchBalance: async () => Promise.reject(new Error("503")) });
    expect((await refusal(noBalance.g.authorize("makeup-vto", {}))).reason).toBe("balance_unavailable");
  });

  it("enforces the reserve floor (balance < cost + reserve)", async () => {
    const { g, audit } = guard({ fetchBalance: async () => ({ units: 40, byType: {} }) });
    const err = await refusal(g.authorize("skin-analysis", FULL));
    expect(err.reason).toBe("reserve_floor");
    expect(audit.events[0]).toMatchObject({ decision: "refused", balanceBefore: 40, unitsExpected: 22 });
    const edge = guard({ fetchBalance: async () => ({ units: 302, byType: {} }) });
    await expect(edge.g.authorize("skin-analysis", FULL)).resolves.toMatchObject({ units: 22, balanceBefore: 302 });
  });

  it("enforces the per-run cap across calls and charges on success", async () => {
    const { g, audit } = guard();
    const r1 = await g.authorize("skin-analysis", FULL, "a");
    await g.settle(r1, { status: "success", taskId: "t1" });
    const r2 = await g.authorize("skin-tone-analysis", {});
    await g.settle(r2, { status: "success", taskId: "t2" });
    expect(g.unitsCharged).toBe(42);
    const err = await refusal(g.authorize("skin-tone-analysis", {}));
    expect(err.reason).toBe("run_cap_exceeded");
    await expect(g.authorize("fitzpatrick-scale-analyzer", {})).resolves.toMatchObject({ units: 10 });
    expect(g.unitsCommitted).toBe(52);
    expect(audit.events.map((e) => e.decision ?? e.status)).toEqual(["allowed", "success", "allowed", "success", "refused", "allowed"]);
    expect(audit.events[1]).toMatchObject({ event: "youcam.outcome", unitsCharged: 22, taskId: "t1", cacheKey: "a" });
  });

  it("releases units on error and keeps them on timeout", async () => {
    const { g, audit } = guard();
    const r = await g.authorize("skin-analysis", FULL);
    await g.settle(r, { status: "error", taskId: "t", detail: { error: "error_no_face" } });
    expect(g.unitsCommitted).toBe(0);
    expect(audit.events.at(-1)).toMatchObject({ status: "error", unitsCharged: 0, detail: { error: "error_no_face" } });
    const r2 = await g.authorize("skin-analysis", FULL);
    await g.settle(r2, { status: "timeout", taskId: "t2" });
    expect(g.unitsCommitted).toBe(22);
    expect(g.unitsCharged).toBe(0);
    expect(audit.events.at(-1)).toMatchObject({ status: "timeout", unitsCharged: undefined });
  });

  it("counts in-flight units against the balance for concurrent calls", async () => {
    const { g } = guard({ fetchBalance: async () => ({ units: 330, byType: {} }), maxUnitsPerRun: 1000 });
    const results = await Promise.allSettled([g.authorize("skin-analysis", FULL), g.authorize("skin-analysis", FULL), g.authorize("skin-analysis", FULL)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.reason).toBe("reserve_floor");
  });

  it("caches live prices for the TTL", async () => {
    let now = 0;
    const { g, fetchFeatureCosts } = guard({ now: () => now, costTtlMs: 1000 });
    await g.quote("makeup-vto", {});
    await g.quote("cloth-v4", {});
    expect(fetchFeatureCosts).toHaveBeenCalledTimes(1);
    now = 5000;
    await expect(g.quote("cloth-v4", {})).resolves.toBe(2);
    expect(fetchFeatureCosts).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the allowed-attempt audit cannot be written", async () => {
    const broken: AuditSink = { kind: "broken", write: async () => Promise.reject(new Error("disk full")) };
    const { g } = guard({ audit: broken });
    await expect(g.authorize("makeup-vto", {})).rejects.toThrow("disk full");
    expect(g.unitsCommitted).toBe(0);
  });

  it("never hides a finished task because the outcome audit failed", async () => {
    const audit = new MemoryAuditSink();
    const { g } = guard({ audit });
    const r = await g.authorize("makeup-vto", {});
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    audit.write = async () => Promise.reject(new Error("db down"));
    await expect(g.settle(r, { status: "success", taskId: "t" })).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    expect(g.unitsCharged).toBe(1);
  });
});

describe("CostGuard.preflight", () => {
  const plan = [
    { feature: "skin-analysis" as const, tier: FULL },
    { feature: "fitzpatrick-scale-analyzer" as const, tier: {} },
    { feature: "skin-tone-analysis" as const, tier: {} },
  ];

  it("reports live balance and price even when paid calls are disabled", async () => {
    const { g, audit } = guard({ allowPaid: false, fetchBalance: async () => ({ units: 40, byType: {} }) });
    const d = await g.preflight(plan);
    expect(d).toMatchObject({ allowed: false, reason: "paid_calls_disabled", unitsExpected: 52, balance: 40 });
    expect(d.message).toMatch(/reserve floor/);
    expect(audit.events[0]).toMatchObject({ decision: "preflight", feature: "skin-analysis+fitzpatrick-scale-analyzer+skin-tone-analysis" });
    const ok = await guard({ allowPaid: false }).g.preflight(plan);
    expect(ok.message).toMatch(/within cap and reserve/);
  });

  it("falls back to the snapshot estimate without a key and allows a funded plan", async () => {
    const noKey = await guard({ allowPaid: false, hasApiKey: false }).g.preflight(plan);
    expect(noKey).toMatchObject({ reason: "paid_calls_disabled", unitsExpected: 52 });
    expect(noKey.balance).toBeUndefined();
    const unknown = await guard({ allowPaid: false, hasApiKey: false }).g.preflight([{ feature: "face-attr-analysis", tier: { count: 99 } }]);
    expect(unknown.unitsExpected).toBeUndefined();
    const { g } = guard();
    await expect(g.preflight(plan)).resolves.toMatchObject({ allowed: true, unitsExpected: 52, balance: 1000 });
    expect(g.unitsCommitted).toBe(0);
    await expect(guard({ maxUnitsPerRun: 50 }).g.preflight(plan)).resolves.toMatchObject({ allowed: false, reason: "run_cap_exceeded" });
  });
});

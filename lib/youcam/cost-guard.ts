/**
 * Cost guard: every paid YouCam task passes through authorize() first.
 *
 * Refuses unless ALL of the following hold, and audits every decision:
 *   1. paid calls are enabled (YOUCAM_MOCK unset/0 AND YOUCAM_ALLOW_PAID=1) and a key exists;
 *   2. the task's price is known from the live feature-cost endpoint (cached);
 *   3. units committed by this run + price <= YOUCAM_MAX_UNITS_PER_RUN (default 40);
 *   4. live balance - units in flight - price >= YOUCAM_RESERVE_UNITS (default 280).
 * Checks 3-4 and the reservation run synchronously after the awaits, so concurrent
 * calls in one process cannot both slip under a limit.
 */
import type { AuditEvent, AuditSink } from "./audit";
import { FEATURE_COST_SNAPSHOT, priceFor } from "./costs";
import { CostGuardError, DailyCapError, type CostGuardReason } from "./errors";
import type { FeatureSlug, TierSelector } from "./features";
import { newLedger, type GuardLedger } from "./global-state";
import type { Balance, FeatureCostSku } from "./types";

export interface CostGuardOptions {
  allowPaid: boolean;
  hasApiKey: boolean;
  reserveUnits: number;
  maxUnitsPerRun: number;
  /** Units per UTC day for the whole ledger (process); 0 or unset disables. */
  dailyUnitCap?: number;
  audit: AuditSink;
  fetchBalance: () => Promise<Balance>;
  fetchFeatureCosts: () => Promise<FeatureCostSku[]>;
  /**
   * Counters and price cache. The default client passes the process-wide ledger
   * (global-state.ts, ADR-023); without one the guard keeps its own.
   */
  ledger?: GuardLedger;
  /** How long live prices are reused. Default 10 minutes. */
  costTtlMs?: number;
  now?: () => number;
}

export interface Reservation {
  feature: FeatureSlug;
  units: number;
  /** UTC day the units were counted against (daily cap). */
  day?: string;
  balanceBefore: number;
  cacheKey?: string;
}

export interface GuardDecision {
  allowed: boolean;
  reason?: CostGuardReason;
  message: string;
  unitsExpected?: number;
  balance?: number;
  runUnits: number;
  maxUnitsPerRun: number;
  reserveUnits: number;
  /** Units committed today (UTC) across the process, and the cap (0 = disabled). */
  dayUnits: number;
  dailyUnitCap: number;
}

export interface PlannedTask {
  feature: FeatureSlug;
  tier: TierSelector;
}

export type Outcome = { status: "success"; taskId: string } | { status: "error" | "timeout"; taskId?: string; detail?: Record<string, unknown> };

export class CostGuard {
  private readonly l: GuardLedger;
  private readonly now: () => number;

  constructor(private readonly opts: CostGuardOptions) {
    this.now = opts.now ?? Date.now;
    this.l = opts.ledger ?? newLedger();
  }

  /** Units charged by successful tasks in this run. */
  get unitsCharged(): number {
    return this.l.charged;
  }

  /** Units charged plus units reserved by tasks still in flight. */
  get unitsCommitted(): number {
    return this.l.committed;
  }

  /** Price from the 2026-10-15 snapshot; for estimates only (mock mode, planning). */
  estimate(feature: FeatureSlug, tier: TierSelector): number | undefined {
    return priceFor(FEATURE_COST_SNAPSHOT, feature, tier);
  }

  /** Live price (feature-cost endpoint, cached for costTtlMs). */
  async quote(feature: FeatureSlug, tier: TierSelector): Promise<number | undefined> {
    const ttl = this.opts.costTtlMs ?? 10 * 60_000;
    if (!this.l.costs || this.now() - this.l.costs.at > ttl) {
      this.l.costs = { at: this.now(), skus: await this.opts.fetchFeatureCosts() };
    }
    return priceFor(this.l.costs.skus, feature, tier);
  }

  /**
   * Decision for running all `items` (one task each). A single paid call is the
   * one-item case; the smoke script checks a whole Skin Passport at once.
   */
  /** Today's UTC day; resets the daily counter when the day changed. */
  private today(): string {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (this.l.day !== day) {
      this.l.day = day;
      this.l.dayCommitted = 0;
    }
    return day;
  }

  /** Units committed today (UTC) across the process, after any rollover. */
  get unitsToday(): number {
    this.today();
    return this.l.dayCommitted;
  }

  private dailyRefusal(total: number): Pick<GuardDecision, "reason" | "message"> | undefined {
    const cap = this.opts.dailyUnitCap ?? 0;
    this.today();
    if (cap <= 0 || this.l.dayCommitted + total <= cap) return undefined;
    return {
      reason: "daily_cap",
      message: `daily cap: ${this.l.dayCommitted} committed today (UTC ${this.l.day}) + ${total} > YOUCAM_DAILY_UNIT_CAP ${cap}`,
    };
  }

  private async evaluate(items: ReadonlyArray<PlannedTask>, mode: "authorize" | "preflight"): Promise<GuardDecision> {
    const gather = mode === "preflight";
    this.today();
    const base = {
      runUnits: this.l.committed,
      maxUnitsPerRun: this.opts.maxUnitsPerRun,
      reserveUnits: this.opts.reserveUnits,
      dayUnits: this.l.dayCommitted,
      dailyUnitCap: this.opts.dailyUnitCap ?? 0,
    };
    const label = items.map((i) => i.feature).join(" + ");
    const disabled = "paid YouCam calls are disabled (need YOUCAM_MOCK unset/0 and YOUCAM_ALLOW_PAID=1)";
    // A paid call with paid calls disabled never touches the network. A preflight
    // (gather = true) still reads the free balance/price endpoints to report them.
    if (!this.opts.allowPaid && !(gather && this.opts.hasApiKey)) {
      const estimates = items.map((i) => this.estimate(i.feature, i.tier));
      return {
        ...base,
        allowed: false,
        reason: "paid_calls_disabled",
        unitsExpected: estimates.every((e) => e !== undefined) ? sum(estimates as number[]) : undefined,
        message: disabled,
      };
    }
    if (!this.opts.hasApiKey) {
      return { ...base, allowed: false, reason: "missing_api_key", message: "YOUCAM_API_KEY is not set" };
    }
    const prices: number[] = [];
    for (const item of items) {
      let price: number | undefined;
      try {
        price = await this.quote(item.feature, item.tier);
      } catch (err) {
        return { ...base, allowed: false, reason: "unknown_cost", message: `feature-cost lookup failed: ${(err as Error).message}` };
      }
      if (price === undefined) {
        return {
          ...base,
          allowed: false,
          reason: "unknown_cost",
          message: `no feature-cost SKU matches ${item.feature} ${JSON.stringify(item.tier)}`,
        };
      }
      prices.push(price);
    }
    const total = sum(prices);
    // Daily cap before the balance lookup, so a refused call makes no further request
    // (re-checked below in the synchronous block, where it is authoritative).
    const early = this.opts.allowPaid ? this.dailyRefusal(total) : undefined;
    if (early) return { ...base, allowed: false, unitsExpected: total, ...early };
    let balance: number;
    try {
      balance = (await this.opts.fetchBalance()).units;
    } catch (err) {
      return { ...base, allowed: false, reason: "balance_unavailable", unitsExpected: total, message: `balance lookup failed: ${(err as Error).message}` };
    }
    // Synchronous from here on: no await between the checks and the reservation below.
    const runUnits = this.l.committed;
    let refusal: Pick<GuardDecision, "reason" | "message"> | undefined;
    const daily = this.dailyRefusal(total);
    const known = { ...base, runUnits, dayUnits: this.l.dayCommitted, unitsExpected: total, balance };
    if (runUnits + total > this.opts.maxUnitsPerRun) {
      refusal = {
        reason: "run_cap_exceeded",
        message: `run cap: ${runUnits} committed + ${total} (${label}) > YOUCAM_MAX_UNITS_PER_RUN ${this.opts.maxUnitsPerRun}`,
      };
    } else if (daily) {
      refusal = daily;
    } else if (balance - this.l.inFlight - total < this.opts.reserveUnits) {
      refusal = {
        reason: "reserve_floor",
        message: `reserve floor: balance ${balance} - in flight ${this.l.inFlight} - cost ${total} < YOUCAM_RESERVE_UNITS ${this.opts.reserveUnits}`,
      };
    }
    if (!this.opts.allowPaid) {
      return {
        ...known,
        allowed: false,
        reason: "paid_calls_disabled",
        message: `${disabled}; otherwise: ${refusal ? refusal.message : "within cap and reserve"}`,
      };
    }
    if (refusal) return { ...known, allowed: false, ...refusal };
    if (mode === "authorize") {
      // Reserve in the same synchronous block as the checks (atomic within this process).
      this.l.committed += total;
      this.l.inFlight += total;
      this.l.dayCommitted += total;
    }
    return { ...known, allowed: true, message: "allowed" };
  }

  private event(partial: Omit<AuditEvent, "ts" | "mode">): AuditEvent {
    return { ts: new Date(this.now()).toISOString(), mode: "real", ...partial };
  }

  /** Reserves units for one paid task, or throws CostGuardError. Both outcomes are audited. */
  async authorize(feature: FeatureSlug, tier: TierSelector, cacheKey?: string): Promise<Reservation> {
    const d = await this.evaluate([{ feature, tier }], "authorize");
    if (!d.allowed) {
      await this.opts.audit.write(
        this.event({
          event: "youcam.attempt",
          feature,
          decision: "refused",
          reason: d.reason,
          unitsExpected: d.unitsExpected,
          balanceBefore: d.balance,
          runUnits: this.l.committed,
          cacheKey,
          detail: { message: d.message },
        }),
      );
      if (d.reason === "daily_cap") {
        throw new DailyCapError(`YouCam call refused: ${d.message}`, feature, d.unitsExpected, d.dayUnits, d.dailyUnitCap);
      }
      throw new CostGuardError(`YouCam call refused: ${d.message}`, d.reason!, feature, d.unitsExpected);
    }
    const units = d.unitsExpected!; // already reserved by evaluate()
    const day = this.l.day;
    const reservation: Reservation = { feature, units, day, balanceBefore: d.balance!, cacheKey };
    try {
      await this.opts.audit.write(
        this.event({
          event: "youcam.attempt",
          feature,
          decision: "allowed",
          unitsExpected: units,
          balanceBefore: d.balance,
          runUnits: this.l.committed,
          cacheKey,
        }),
      );
    } catch (err) {
      // Fail closed: no audit row, no paid call.
      this.l.committed -= units;
      this.l.inFlight -= units;
      this.l.dayCommitted -= units;
      throw err;
    }
    return reservation;
  }

  /** Records the outcome. Success charges the reserved units; error releases them; timeout keeps them committed. */
  async settle(r: Reservation, outcome: Outcome): Promise<void> {
    let unitsCharged: number | undefined;
    if (outcome.status === "success") {
      this.l.inFlight -= r.units;
      this.l.charged += r.units;
      unitsCharged = r.units;
    } else if (outcome.status === "error") {
      this.l.inFlight -= r.units;
      this.l.committed -= r.units;
      // Release today's count only if the reservation was made today (a rollover already reset it).
      if (r.day !== undefined && r.day === this.today()) this.l.dayCommitted -= r.units;
      unitsCharged = 0;
    }
    try {
      await this.opts.audit.write(
        this.event({
          event: "youcam.outcome",
          feature: r.feature,
          status: outcome.status,
          unitsExpected: r.units,
          unitsCharged,
          balanceBefore: r.balanceBefore,
          runUnits: this.l.committed,
          taskId: outcome.taskId,
          cacheKey: r.cacheKey,
          detail: "detail" in outcome ? outcome.detail : undefined,
        }),
      );
    } catch (err) {
      // The task already ran; never hide its result because the audit sink is down.
      console.error("[youcam] audit write failed for outcome:", (err as Error).message);
    }
  }

  /**
   * What authorize() would decide for these tasks together, without reserving units.
   * Uses only free GET endpoints. Audited as decision "preflight".
   */
  async preflight(items: ReadonlyArray<PlannedTask>): Promise<GuardDecision> {
    const d = await this.evaluate(items, "preflight");
    await this.opts.audit.write(
      this.event({
        event: "youcam.attempt",
        feature: items.map((i) => i.feature).join("+"),
        decision: "preflight",
        reason: d.reason,
        unitsExpected: d.unitsExpected,
        balanceBefore: d.balance,
        runUnits: this.l.committed,
        detail: { allowed: d.allowed, message: d.message },
      }),
    );
    return d;
  }
}

function sum(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

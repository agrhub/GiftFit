/**
 * Cost guard: every paid YouCam task passes through authorize() first.
 *
 * Refuses unless ALL of the following hold, and audits every decision:
 *   1. paid calls are enabled (YOUCAM_MOCK unset/0 AND YOUCAM_ALLOW_PAID=1) and a key exists;
 *   2. the task's price is known from the live feature-cost endpoint (cached);
 *   3. units committed by this run + price <= YOUCAM_MAX_UNITS_PER_RUN (default 40);
 *   4. live balance - units in flight - price >= YOUCAM_RESERVE_UNITS (default 0 since A16; was the judges' 300).
 * With a durable counter, YOUCAM_TOTAL_UNIT_CAP (A16) is reserved after the daily cap on the key
 * `youcam-total` (across days; refunded like the daily count; a store failure is a refusal).
 * Checks 3-4 and the reservation run synchronously after the awaits, so concurrent
 * calls in one process cannot both slip under a limit.
 *
 * Daily cap (YOUCAM_DAILY_UNIT_CAP): counted in the ledger (`day`/`dayCommitted`) and, when a durable
 * `dailyCounter` is given (STORE=firestore: Firestore `daily_counters/youcam-<YYYY-MM-DD>`), also there,
 * so the cap holds across cold starts: evaluate() first refreshes dayCommitted from the durable count,
 * authorize() then reserves atomically in the store (a transaction) and rolls back if it refuses, and
 * settle() refunds the store when a task errored. A store failure refuses the call (fail closed).
 */
import type { AuditEvent, AuditSink } from "./audit";
import { FEATURE_COST_SNAPSHOT, priceFor } from "./costs";
import { CostGuardError, DailyCapError, type CostGuardReason } from "./errors";
import type { FeatureSlug, TierSelector } from "./features";
import { newLedger, type GuardLedger } from "./global-state";
import type { DailyCounterStore } from "../store/daily-counter";
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
  /**
   * Durable per-day count for dailyUnitCap (survives restarts). Without one, the ledger alone counts
   * (process memory). Key: `youcam-<YYYY-MM-DD>`.
   */
  dailyCounter?: DailyCounterStore;
  /** Units across days on `dailyCounter` under TOTAL_COUNTER_KEY (A16). 0 or unset disables; needs dailyCounter. */
  totalUnitCap?: number;
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

  /** The durable counter, when there is one and a daily cap is set. */
  private durableCounter(): DailyCounterStore | undefined {
    return (this.opts.dailyUnitCap ?? 0) > 0 ? this.opts.dailyCounter : undefined;
  }

  /** The durable counter for the total cap, when there is one and a total cap is set. */
  private totalCounter(): DailyCounterStore | undefined {
    return (this.opts.totalUnitCap ?? 0) > 0 ? this.opts.dailyCounter : undefined;
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
    const counter = this.durableCounter();
    if (counter && this.opts.allowPaid) {
      // Cold start: the ledger starts at 0, the durable count does not. Max, because this process's
      // own reservations are in both.
      const day = this.today();
      try {
        const used = await counter.get(dailyKey(day));
        if (this.l.day === day) this.l.dayCommitted = Math.max(this.l.dayCommitted, used);
      } catch (err) {
        if (!gather) return { ...base, allowed: false, reason: "daily_counter_unavailable", unitsExpected: total, message: `daily counter unavailable: ${(err as Error).message}` };
      }
      base.dayUnits = this.l.dayCommitted;
    }
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
    let d = await this.evaluate([{ feature, tier }], "authorize");
    if (d.allowed) d = await this.reserveDurable(d);
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
      this.releaseLocal(units, day);
      await this.refundDurable(day, units);
      throw err;
    }
    return reservation;
  }

  /** Undoes evaluate()'s in-process reservation. */
  private releaseLocal(units: number, day: string | undefined): void {
    this.l.committed -= units;
    this.l.inFlight -= units;
    if (day !== undefined && this.l.day === day) this.l.dayCommitted -= units;
  }

  /**
   * The authoritative daily-cap check with a durable counter: an atomic reserve in the store. On a
   * refusal or a store error the in-process reservation is released and the decision becomes a refusal.
   */
  private async reserveDurable(d: GuardDecision): Promise<GuardDecision> {
    const counter = this.durableCounter();
    if (!counter) return this.reserveTotal(d, undefined);
    const units = d.unitsExpected!;
    const day = this.l.day!;
    const cap = this.opts.dailyUnitCap ?? 0;
    try {
      const r = await counter.tryReserve(dailyKey(day), units, cap);
      if (r.ok) {
        if (this.l.day === day) this.l.dayCommitted = Math.max(this.l.dayCommitted, r.used);
        return this.reserveTotal({ ...d, dayUnits: this.l.dayCommitted }, day);
      }
      this.releaseLocal(units, day);
      if (this.l.day === day) this.l.dayCommitted = Math.max(this.l.dayCommitted, r.used);
      return {
        ...d,
        allowed: false,
        reason: "daily_cap",
        dayUnits: r.used,
        message: `daily cap: ${r.used} committed today (UTC ${day}) + ${units} > YOUCAM_DAILY_UNIT_CAP ${cap}`,
      };
    } catch (err) {
      this.releaseLocal(units, day);
      return { ...d, allowed: false, reason: "daily_counter_unavailable", message: `daily counter unavailable: ${(err as Error).message}` };
    }
  }

  /**
   * The total cap (A16): an atomic reserve on TOTAL_COUNTER_KEY after the daily one. A refusal or a store error
   * gives the daily reservation back and refuses (fail closed).
   */
  private async reserveTotal(d: GuardDecision, dailyDay: string | undefined): Promise<GuardDecision> {
    const counter = this.totalCounter();
    if (!counter) return d;
    const units = d.unitsExpected!;
    const day = this.l.day;
    const cap = this.opts.totalUnitCap ?? 0;
    let refusal: Pick<GuardDecision, "reason" | "message">;
    try {
      const r = await counter.tryReserve(TOTAL_COUNTER_KEY, units, cap);
      if (r.ok) return d;
      refusal = { reason: "total_cap", message: `total cap: ${r.used} committed + ${units} > YOUCAM_TOTAL_UNIT_CAP ${cap}` };
    } catch (err) {
      refusal = { reason: "daily_counter_unavailable", message: `total counter unavailable: ${(err as Error).message}` };
    }
    this.releaseLocal(units, day);
    if (dailyDay !== undefined) await this.refundDurable(dailyDay, units);
    return { ...d, allowed: false, ...refusal };
  }

  /** Gives total-cap units back; never throws (logged). */
  private async refundTotal(units: number): Promise<void> {
    const counter = this.totalCounter();
    if (!counter || units <= 0) return;
    try {
      await counter.refund(TOTAL_COUNTER_KEY, units);
    } catch (err) {
      console.error("[youcam] total counter refund failed:", (err as Error).message);
    }
  }

  /** Gives units back to the durable day counter; never throws (logged). */
  private async refundDurable(day: string | undefined, units: number): Promise<void> {
    const counter = this.durableCounter();
    if (!counter || day === undefined || units <= 0) return;
    try {
      await counter.refund(dailyKey(day), units);
    } catch (err) {
      console.error("[youcam] daily counter refund failed:", (err as Error).message);
    }
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
      await this.refundDurable(r.day, r.units);
      await this.refundTotal(r.units);
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

/** Durable counter key of the total cap (A16; no date in it, so its TTL runs 3 days after the last paid call). */
export const TOTAL_COUNTER_KEY = "youcam-total";

/** Durable counter key for one UTC day (lib/store/daily-counter.ts). */
export const dailyKey = (day: string) => `youcam-${day}`;

function sum(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

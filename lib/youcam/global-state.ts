/**
 * Process-wide state for lib/youcam, kept on `globalThis` under a namespaced symbol (ADR-023).
 *
 * Next.js compiles each route into its own bundle, so a module-level `const`/`let` exists once
 * PER ROUTE. Everything that must be shared by every route in one process lives here instead:
 * - the rate limiter (YouCam's 250 req / 300 s limit is per API key and per IP, not per route);
 * - the cost-guard ledger (units committed/in flight/charged this run, live feature-cost cache);
 * - the default audit sink and result cache instances;
 * - the shared client returned by getYoucamClient();
 * - webhook completion signals (the webhook route must wake pollers running in other routes);
 * - the fixture memo.
 *
 * This module has no runtime imports, so any lib/youcam module can use it without import cycles.
 */
import type { AuditSink } from "./audit";
import type { ResultCache } from "./cache";
import type { YoucamClient } from "./client";
import type { RateLimiter } from "./http";
import type { LoadedFixture } from "./mock";
import type { FeatureCostSku } from "./types";

export const YOUCAM_STATE_KEY = Symbol.for("giftfit.youcam.state.v1");

/** Mutable counters behind CostGuard. One per process by default (the "run" is the process). */
export interface GuardLedger {
  committed: number;
  inFlight: number;
  charged: number;
  /** UTC day (YYYY-MM-DD) that dayCommitted counts. */
  day?: string;
  /** Units committed (charged + in flight + timed out) on `day`, for YOUCAM_DAILY_UNIT_CAP. */
  dayCommitted: number;
  /** Live feature-cost SKUs and when they were fetched. The balance is never cached. */
  costs?: { at: number; skus: FeatureCostSku[] };
}

export function newLedger(): GuardLedger {
  return { committed: 0, inFlight: 0, charged: 0, dayCommitted: 0 };
}

export interface YoucamGlobalState {
  rateLimiter?: RateLimiter;
  ledger?: GuardLedger;
  /** Default sinks/caches by "<kind>:<location>". */
  auditSinks: Map<string, AuditSink>;
  resultCaches: Map<string, ResultCache>;
  client?: YoucamClient;
  completedTasks: Map<string, { status: "success" | "error"; at: number }>;
  taskListeners: Map<string, Set<(status: "success" | "error") => void>>;
  fixtureMemo: Map<string, LoadedFixture>;
  /** Owner-recording paid grants minted this process (recording.ts, A16). */
  paidGrants?: WeakSet<object>;
}

type WithState = typeof globalThis & { [YOUCAM_STATE_KEY]?: YoucamGlobalState };

export function youcamState(): YoucamGlobalState {
  const g = globalThis as WithState;
  return (g[YOUCAM_STATE_KEY] ??= {
    auditSinks: new Map(),
    resultCaches: new Map(),
    completedTasks: new Map(),
    taskListeners: new Map(),
    fixtureMemo: new Map(),
  });
}

/** The process-wide cost-guard ledger. */
export function globalLedger(): GuardLedger {
  return (youcamState().ledger ??= newLedger());
}

/** Test helper: forget all process-wide lib/youcam state (the next use rebuilds it). */
export function resetYoucamState(): void {
  delete (globalThis as WithState)[YOUCAM_STATE_KEY];
}

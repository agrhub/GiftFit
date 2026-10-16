/** Error types thrown by lib/youcam. None of them ever carries the API key or image bytes. */

export class YoucamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Bad parameters caught locally, before any network call. */
export class YoucamValidationError extends YoucamError {}

/** Non-2xx HTTP response from the YouCam API (after retries). */
export class YoucamApiError extends YoucamError {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly endpoint?: string,
  ) {
    super(message);
  }
}

/** The task finished with task_status = "error" (no units are charged in this case). */
export class YoucamTaskError extends YoucamError {
  constructor(
    message: string,
    readonly feature: string,
    readonly taskId: string,
    readonly engineError?: string | null,
  ) {
    super(message);
  }
}

/** Polling ran out while the task was still running. Units may still be charged later. */
export class YoucamTimeoutError extends YoucamError {
  constructor(
    message: string,
    readonly feature: string,
    readonly taskId: string,
  ) {
    super(message);
  }
}

export type CostGuardReason =
  | "paid_calls_disabled"
  | "missing_api_key"
  | "unknown_cost"
  | "run_cap_exceeded"
  | "reserve_floor"
  | "daily_cap"
  | "balance_unavailable";

/** The cost guard refused a paid call. The refusal is always written to the audit log. */
export class CostGuardError extends YoucamError {
  constructor(
    message: string,
    readonly reason: CostGuardReason,
    readonly feature: string,
    readonly unitsExpected?: number,
  ) {
    super(message);
  }
}

/**
 * The process-wide daily unit cap (YOUCAM_DAILY_UNIT_CAP) is reached for today (UTC).
 * Routes map it to `503 {"error":"daily_cap_reached"}`. Always has reason "daily_cap".
 */
export class DailyCapError extends CostGuardError {
  constructor(
    message: string,
    feature: string,
    unitsExpected: number | undefined,
    readonly dayUnits: number,
    readonly dailyUnitCap: number,
  ) {
    super(message, "daily_cap", feature, unitsExpected);
  }
}

/** Mock mode was asked for a fixture that does not exist. */
export class YoucamFixtureError extends YoucamError {}

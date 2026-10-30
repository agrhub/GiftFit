import type { AuditEvent } from "../youcam/audit";
import { getDb } from "./index";
import { auditLog } from "./schema";

/** Maps an AuditEvent to an audit_log row. */
export function auditRow(e: AuditEvent): typeof auditLog.$inferInsert {
  return {
    ts: new Date(e.ts),
    event: e.event,
    mode: e.mode,
    feature: e.feature,
    decision: e.decision,
    reason: e.reason,
    unitsExpected: e.unitsExpected,
    unitsCharged: e.unitsCharged,
    balanceBefore: e.balanceBefore === undefined ? undefined : String(e.balanceBefore),
    runUnits: e.runUnits,
    taskId: e.taskId,
    cacheKey: e.cacheKey,
    status: e.status,
    detail: e.detail,
  };
}

export async function insertAuditEvent(e: AuditEvent): Promise<void> {
  await getDb().insert(auditLog).values(auditRow(e));
}

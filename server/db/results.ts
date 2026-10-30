import { and, eq, gt, isNull, or } from "drizzle-orm";
import type { CachedResult } from "../youcam/cache";
import { getDb } from "./index";
import { youcamResults } from "./schema";

export async function getCachedResult(key: string): Promise<CachedResult | undefined> {
  const rows = await getDb()
    .select()
    .from(youcamResults)
    .where(
      and(eq(youcamResults.cacheKey, key), or(isNull(youcamResults.expiresAt), gt(youcamResults.expiresAt, new Date()))),
    )
    .limit(1);
  const r = rows[0];
  if (!r) return undefined;
  return {
    feature: r.feature,
    taskId: r.taskId,
    result: r.result,
    unitsCharged: r.unitsCharged,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt?.toISOString(),
  };
}

export async function setCachedResult(key: string, v: CachedResult): Promise<void> {
  await getDb()
    .insert(youcamResults)
    .values({
      cacheKey: key,
      feature: v.feature,
      taskId: v.taskId,
      result: v.result,
      unitsCharged: v.unitsCharged,
      expiresAt: v.expiresAt ? new Date(v.expiresAt) : undefined,
    })
    .onConflictDoUpdate({
      target: youcamResults.cacheKey,
      set: { taskId: v.taskId, result: v.result, unitsCharged: v.unitsCharged, expiresAt: v.expiresAt ? new Date(v.expiresAt) : null },
    });
}

export async function deleteCachedResult(key: string): Promise<void> {
  await getDb().delete(youcamResults).where(eq(youcamResults.cacheKey, key));
}

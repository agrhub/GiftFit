/**
 * "Delete everything" (owner: A5). One call removes, for one Fit Request:
 *   1. every blob: input photos and try-on renders (PhotoStore.deleteForRequest);
 *   2. every lib/youcam result-cache entry recorded for the request (hex colors, face data, render URLs);
 *   3. every YouCam task (POST /s2s/v2.0/task/delete), which removes YouCam's copy of inputs and outputs;
 *   4. every recipient-derived DB row: recipient_profiles, tryons, hearts, fit_reports;
 * then marks the request `deleted` (or `expired`), which kills both links, and verifies that
 * nothing is left. The giver keeps only what they typed (occasion, budget, shortlist).
 *
 * The same routine runs for expiry (purgeExpired), so "72 h" and "one tap" share one code path.
 */
import type { PrivacyDeps } from "./deps";
import type { RequestRowCounts } from "./repos/types";
import { deleteContactsForRequest } from "@/lib/widget/contacts";

export interface DeleteReceipt {
  fitRequestId: string;
  reason: "recipient_request" | "expired";
  deleted: {
    rows: RequestRowCounts;
    blobs: number;
    cacheEntries: number;
    youcamTasks: number;
  };
  /** YouCam tasks that could not be deleted now (e.g. still running); YouCam drops them within 24 h. */
  youcamTasksPending: string[];
  /** True when a re-count after deletion found no rows and no blobs for the request. */
  verified: boolean;
}

export async function deleteEverything(
  deps: PrivacyDeps,
  fitRequestId: string,
  reason: DeleteReceipt["reason"] = "recipient_request",
): Promise<DeleteReceipt> {
  const rows = await deps.repos.tryons.listForRequest(fitRequestId);
  const taskIds = [...new Set(rows.map((r) => r.taskId).filter((t): t is string => Boolean(t)))];
  const cacheKeys = [...new Set(rows.map((r) => r.cacheKey).filter((k) => /^[a-f0-9]{64}$/.test(k)))];

  // 1. Blobs (all objects under the request's prefixes, which covers every resultRef we wrote).
  const blobs = await deps.photos.deleteForRequest(fitRequestId);

  // 2 + 3. Result cache and YouCam tasks. Failures do not block local deletion.
  const { cacheEntries, youcamTasks, youcamTasksPending } = await purgeYoucamArtifacts(deps, taskIds, cacheKeys);

  // 4. Rows, then close the request so neither link works again.
  const deletedRows = await deps.repos.deleteRecipientData(fitRequestId);
  // Widget e-mail addresses (A6, ADR-046) live exactly as long as the request.
  await deleteContactsForRequest(fitRequestId);
  await deps.repos.fitRequests.setStatus(fitRequestId, reason === "expired" ? "expired" : "deleted");

  const left = await deps.repos.countForRequest(fitRequestId);
  const leftBlobs = await deps.photos.listForRequest(fitRequestId);
  const verified = Object.values(left).every((n) => n === 0) && leftBlobs.length === 0;
  if (!verified) console.error("[privacy] delete verification failed for a Fit Request");

  return {
    fitRequestId,
    reason,
    deleted: { rows: deletedRows, blobs, cacheEntries, youcamTasks },
    youcamTasksPending,
    verified,
  };
}

export interface PurgeSummary {
  requests: number;
  receipts: DeleteReceipt[];
  sweptBlobs: number;
}

/** Deletes recipient data of every expired Fit Request and every overdue blob. Idempotent. */
export async function purgeExpired(deps: PrivacyDeps): Promise<PurgeSummary> {
  const now = deps.now();
  const ids = await deps.repos.fitRequests.listExpired(now);
  const receipts: DeleteReceipt[] = [];
  for (const id of ids) receipts.push(await deleteEverything(deps, id, "expired"));
  const sweptBlobs = await deps.photos.sweepExpired(now);
  return { requests: ids.length, receipts, sweptBlobs };
}

export interface YoucamPurgeSummary {
  cacheEntries: number;
  youcamTasks: number;
  youcamTasksPending: string[];
}

/** Task and cache-key ids recorded for a request (analysis and render tasks). */
export async function youcamArtifactsOf(deps: PrivacyDeps, fitRequestId: string): Promise<{ taskIds: string[]; cacheKeys: string[] }> {
  const rows = await deps.repos.tryons.listForRequest(fitRequestId);
  return {
    taskIds: [...new Set(rows.map((r) => r.taskId).filter((t): t is string => Boolean(t)))],
    cacheKeys: [...new Set(rows.map((r) => r.cacheKey).filter((k) => /^[a-f0-9]{64}$/.test(k)))],
  };
}

/**
 * Drops the lib/youcam result-cache entries and deletes the YouCam tasks (A1's client.purge when
 * present, else per key / per task). Never throws; failed task deletes are reported as pending.
 */
export async function purgeYoucamArtifacts(deps: PrivacyDeps, taskIds: readonly string[], cacheKeys: readonly string[]): Promise<YoucamPurgeSummary> {
  let cacheEntries = 0;
  let youcamTasks = 0;
  const youcamTasksPending: string[] = [];
  let purged = false;
  if (deps.youcam.purge) {
    try {
      const r = await deps.youcam.purge({ cacheKeys, taskIds });
      cacheEntries = r.cacheKeysPurged;
      for (const t of r.tasks) {
        if (t.ok) youcamTasks++;
        else youcamTasksPending.push(t.taskId);
      }
      purged = true;
    } catch (err) {
      console.error("[privacy] YouCam purge failed, falling back:", (err as Error).message);
    }
  }
  if (!purged) {
    for (const key of cacheKeys) {
      try {
        await deps.youcam.deleteCachedResult(key);
        cacheEntries++;
      } catch (err) {
        console.error("[privacy] cache purge failed:", (err as Error).message);
      }
    }
    for (const id of taskIds) {
      try {
        await deps.youcam.deleteTask(id);
        youcamTasks++;
      } catch (err) {
        youcamTasksPending.push(id);
        console.warn("[privacy] YouCam task delete failed:", (err as Error).message);
      }
    }
  }

  return { cacheEntries, youcamTasks, youcamTasksPending };
}

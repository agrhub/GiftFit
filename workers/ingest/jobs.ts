/**
 * In-process ingest job runner (owner: A10). POST /api/ingest starts a job here and returns its id;
 * GET /api/ingest/<id> reads its status. Jobs live in memory for the life of the server process (the
 * durable record is the `stores` row the pipeline updates: ingest_status, ingest_progress, sku_count).
 * At most one running job per host: a second request for a busy host returns the running job.
 *
 * Long live runs (hundreds of pages at ≤ 1 req/s) should use the CLI (workers/ingest/cli.ts) rather
 * than a serverless request, which may be frozen after the response is sent.
 */
import { randomUUID } from "node:crypto";
import { createIngestDeps } from "@/lib/ingest/index";
import type { IngestDeps, IngestResult } from "@/lib/ingest/pipeline";
import { runIngest } from "@/lib/ingest/pipeline";
import type { Coverage, IngestProgress, IngestTier, Platform } from "@/lib/ingest/types";

export type JobStatus = "queued" | "running" | "done" | "error";

export interface IngestJob {
  id: string;
  url: string;
  host: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  progress: IngestProgress;
  storeId?: string;
  platform?: Platform;
  tier?: IngestTier;
  skuCount: number;
  coverage?: Coverage;
  extractor?: string;
  errorCount: number;
  error?: string;
}

export interface StartJobInput {
  url: string;
  tier?: IngestTier | "auto";
  maxProducts?: number;
}

type Registry = { jobs: Map<string, IngestJob>; done: Map<string, Promise<IngestJob>> };
const g = globalThis as unknown as { __giftfitIngestJobs?: Registry };
const registry: Registry = (g.__giftfitIngestJobs ??= { jobs: new Map(), done: new Map() });
const MAX_JOBS_KEPT = 50;

const snapshot = (j: IngestJob): IngestJob => structuredClone(j);

export function getJob(id: string): IngestJob | undefined {
  const j = registry.jobs.get(id);
  return j ? snapshot(j) : undefined;
}

export function listJobs(): IngestJob[] {
  return [...registry.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(snapshot);
}

/** Resolves when the job finishes (tests and the CLI). */
export async function waitForJob(id: string): Promise<IngestJob> {
  const p = registry.done.get(id);
  if (!p) throw new Error(`unknown job ${id}`);
  return p;
}

/** Test helper. */
export function resetJobs(): void {
  registry.jobs.clear();
  registry.done.clear();
}

function prune(): void {
  const finished = [...registry.jobs.values()].filter((j) => j.status === "done" || j.status === "error").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  while (registry.jobs.size > MAX_JOBS_KEPT && finished.length) {
    const old = finished.shift()!;
    registry.jobs.delete(old.id);
    registry.done.delete(old.id);
  }
}

export function startIngestJob(
  input: StartJobInput,
  depsFactory: (onProgress: (p: IngestProgress) => void) => Promise<IngestDeps> = (onProgress) => createIngestDeps(process.env, { onProgress }),
): { job: IngestJob; reused: boolean } {
  const host = new URL(input.url).host;
  const busy = [...registry.jobs.values()].find((j) => j.host === host && (j.status === "queued" || j.status === "running"));
  if (busy) return { job: snapshot(busy), reused: true };

  const now = new Date().toISOString();
  const job: IngestJob = {
    id: randomUUID(),
    url: input.url,
    host,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    progress: { phase: "detect", discovered: 0, processed: 0, skus: 0, errors: 0 },
    skuCount: 0,
    errorCount: 0,
  };
  registry.jobs.set(job.id, job);
  prune();

  const touch = (patch: Partial<IngestJob>) => Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  const run = async (): Promise<IngestJob> => {
    try {
      const deps = await depsFactory((p) => touch({ status: "running", progress: p, skuCount: p.skus, errorCount: p.errors }));
      touch({ status: "running" });
      const r: IngestResult = await runIngest({ url: input.url, tier: input.tier, maxProducts: input.maxProducts }, deps);
      touch({
        status: r.status,
        storeId: r.storeId,
        platform: r.platform,
        tier: r.tier,
        skuCount: r.skus.length,
        coverage: r.coverage,
        extractor: r.extractor,
        errorCount: r.errors.length,
        error: r.fatal,
      });
      await deps.renderer?.close();
    } catch (e) {
      touch({ status: "error", error: e instanceof Error ? e.message : String(e) });
    }
    return snapshot(job);
  };
  registry.done.set(job.id, run());
  return { job: snapshot(job), reused: false };
}

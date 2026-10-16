/**
 * Default dependencies for recipient routes (owner: A5): Drizzle repos when DATABASE_URL is
 * set, else a process-wide in-memory stack (local dev only; it does not survive restarts or
 * span serverless instances). Vercel Blob when BLOB_READ_WRITE_TOKEN is set, else memory.
 * YouCam purge goes through the shared lib/youcam client (task delete is a no-op in mock mode).
 */
import { getDb, hasDatabase } from "@/db/index";
import { getYoucamClient } from "@/lib/youcam/client";
import { youcamCapturePorts } from "./capture";
import { aurumCatalogSource } from "./catalog";
import type { PrivacyDeps } from "./deps";
import { privacyState } from "./global-state";
import { createPhotoStore } from "./photo-store";
import { DrizzlePrivacyRepos, type AnyPgDb } from "./repos/drizzle";
import { MemoryPrivacyRepos } from "./repos/memory";
import { getSigningSecret } from "./signed-url";

async function buildDefaults(): Promise<PrivacyDeps> {
  const repos = hasDatabase()
    ? new DrizzlePrivacyRepos(() => getDb() as unknown as AnyPgDb)
    : (privacyState().memoryRepos ??= new MemoryPrivacyRepos());
  return {
    repos,
    photos: await createPhotoStore(),
    youcam: {
      deleteTask: (taskId) => getYoucamClient().deleteTask(taskId),
      deleteCachedResult: async (key) => {
        await getYoucamClient().cache?.delete(key);
      },
      // A1's batch purge (10287e7): result cache entries + YouCam task/delete, audited with counts only.
      purge: (input) => getYoucamClient().purge(input),
    },
    signingSecret: getSigningSecret(),
    now: () => new Date(),
    catalog: aurumCatalogSource(),
    capturePorts: (baseUrl) => youcamCapturePorts(getYoucamClient(), { baseUrl }),
    youcamMode: () => getYoucamClient().mode,
  };
}

/**
 * The process-wide deps. State lives on globalThis (global-state.ts) so every Next.js route bundle,
 * and lib/fit's PrivacyFitRepository, sees the same repos, photo store and signing secret.
 */
export async function getPrivacyDeps(): Promise<PrivacyDeps> {
  const state = privacyState();
  if (state.override) return state.override;
  state.defaults ??= buildDefaults().catch((err) => {
    state.defaults = undefined;
    throw err;
  });
  return state.defaults;
}

/** Tests and P3 wiring: inject a stack (pass undefined to go back to the defaults). */
export function setPrivacyDeps(deps: PrivacyDeps | undefined): void {
  privacyState().override = deps;
}

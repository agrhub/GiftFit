/**
 * Default dependencies for recipient routes (owner: A5; store selection: A11, server/store/config.ts):
 *   STORE=firestore  Firestore repos (FIRESTORE_DATABASE_ID, default giftfit-db) + private Cloud Storage
 *                    photos (GCS_PHOTO_BUCKET): survives Cloud Run scale-to-zero.
 *   STORE=memory     a process-wide in-memory stack (tests, local mock mode; lost on restart).
 *   unset            Drizzle repos when DATABASE_URL is set, else memory (as before).
 * Photos without STORE=firestore: Vercel Blob when BLOB_READ_WRITE_TOKEN is set, else memory.
 * YouCam purge goes through the shared server/youcam client (task delete is a no-op in mock mode).
 */
import { getDb } from "@/server/db/index";
import { storeKind } from "@/server/store/config";
import { getFirestoreDb } from "@/server/store/gcp-clients";
import { getYoucamClient } from "@/server/youcam/client";
import { youcamCapturePorts } from "./capture";
import { PreviewAwareCatalog } from "@/server/widget/preview";
import { aurumCatalogSource } from "./catalog";
import type { PrivacyDeps } from "./deps";
import { privacyState } from "./global-state";
import { createPhotoStore } from "./photo-store";
import { DrizzlePrivacyRepos, type AnyPgDb } from "./repos/drizzle";
import { FirestorePrivacyRepos } from "./repos/firestore";
import { MemoryPrivacyRepos } from "./repos/memory";
import type { PrivacyRepos } from "./repos/types";
import { getSigningSecret } from "./signed-url";

async function defaultRepos(): Promise<PrivacyRepos> {
  const kind = storeKind();
  if (kind === "firestore") return new FirestorePrivacyRepos(await getFirestoreDb());
  if (kind === "drizzle") return new DrizzlePrivacyRepos(() => getDb() as unknown as AnyPgDb);
  return (privacyState().memoryRepos ??= new MemoryPrivacyRepos());
}

async function buildDefaults(): Promise<PrivacyDeps> {
  const repos = await defaultRepos();
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
    // A6 (ADR-055): preview-store requests carry key-scoped SKU ids resolved from the preview repo.
    catalog: new PreviewAwareCatalog(aurumCatalogSource()),
    capturePorts: (baseUrl, opts) => youcamCapturePorts(getYoucamClient(), { baseUrl, paidGrant: opts?.paidGrant }),
    youcamMode: () => getYoucamClient().mode,
  };
}

/**
 * The process-wide deps. State lives on globalThis (global-state.ts) so every Next.js route bundle,
 * and server/fit's PrivacyFitRepository, sees the same repos, photo store and signing secret.
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

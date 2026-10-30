/**
 * Lazy, process-wide Google Cloud clients (owner: A11). Kept on globalThis (as server/privacy and server/youcam
 * do) so every Next.js route bundle shares one Firestore and one Storage client. The SDKs are imported
 * only on first use, so tests and STORE=memory never load them. Auth: Application Default Credentials
 * (the Cloud Run service account; `gcloud auth application-default login` locally). No secret.
 *
 * The Firestore client is ALWAYS built with an explicit databaseId (firestoreDatabaseId(): a giftfit
 * database only), never the project's `(default)` database.
 */
import { firestoreDatabaseId, gcpProjectId, type Env } from "./config";
import type { FsDb } from "./firestore-types";

export const GCP_STATE_KEY = Symbol.for("giftfit.store.gcp.v1");

/** Structural slice of a @google-cloud/storage Bucket (see photo-store-gcs.ts gcsObjectApi). */
export interface GcsBucketLike {
  readonly name: string;
  file(name: string): {
    save(data: Buffer, opts: Record<string, unknown>): Promise<unknown>;
    download(): Promise<[Buffer]>;
    getMetadata(): Promise<[{ contentType?: string; metadata?: Record<string, unknown> }, ...unknown[]]>;
    delete(opts?: Record<string, unknown>): Promise<unknown>;
  };
  getFiles(query: Record<string, unknown>): Promise<[Array<{ name: string }>, ...unknown[]]>;
}

interface GcpState {
  firestore?: Map<string, Promise<FsDb>>;
  buckets?: Map<string, Promise<GcsBucketLike>>;
}

function state(): GcpState {
  const g = globalThis as typeof globalThis & { [GCP_STATE_KEY]?: GcpState };
  return (g[GCP_STATE_KEY] ??= {});
}

/**
 * A NEW Firestore client for `databaseId` (the live check uses this to simulate a cold start).
 * ignoreUndefinedProperties: optional record fields may be undefined.
 */
export async function newFirestoreDb(opts: { databaseId: string; projectId?: string }): Promise<FsDb> {
  if (!opts.databaseId) throw new Error("databaseId is required");
  // CJS interop: in Next's server bundle the dynamic import exposes the package under `default`.
  const mod = (await import("@google-cloud/firestore")) as typeof import("@google-cloud/firestore") & { default?: typeof import("@google-cloud/firestore") };
  const Firestore = mod.Firestore ?? mod.default?.Firestore;
  if (typeof Firestore !== "function") throw new Error("@google-cloud/firestore: Firestore export not found");
  const db = new Firestore({ databaseId: opts.databaseId, ...(opts.projectId ? { projectId: opts.projectId } : {}), ignoreUndefinedProperties: true });
  return db as unknown as FsDb;
}

/** The process-wide Firestore client for FIRESTORE_DATABASE_ID (default giftfit-db). */
export function getFirestoreDb(env: Env = process.env): Promise<FsDb> {
  const databaseId = firestoreDatabaseId(env);
  const s = state();
  s.firestore ??= new Map();
  let p = s.firestore.get(databaseId);
  if (!p) {
    p = newFirestoreDb({ databaseId, projectId: gcpProjectId(env) }).catch((err) => {
      s.firestore?.delete(databaseId);
      throw err;
    });
    s.firestore.set(databaseId, p);
  }
  return p;
}

export async function newGcsBucket(opts: { bucket: string; projectId?: string }): Promise<GcsBucketLike> {
  const mod = (await import("@google-cloud/storage")) as typeof import("@google-cloud/storage") & { default?: typeof import("@google-cloud/storage") };
  const Storage = mod.Storage ?? mod.default?.Storage;
  if (typeof Storage !== "function") throw new Error("@google-cloud/storage: Storage export not found");
  const storage = new Storage(opts.projectId ? { projectId: opts.projectId } : {});
  return storage.bucket(opts.bucket) as unknown as GcsBucketLike;
}

/** The process-wide handle on one bucket. */
export function getGcsBucket(bucket: string, env: Env = process.env): Promise<GcsBucketLike> {
  const s = state();
  s.buckets ??= new Map();
  let p = s.buckets.get(bucket);
  if (!p) {
    p = newGcsBucket({ bucket, projectId: gcpProjectId(env) }).catch((err) => {
      s.buckets?.delete(bucket);
      throw err;
    });
    s.buckets.set(bucket, p);
  }
  return p;
}

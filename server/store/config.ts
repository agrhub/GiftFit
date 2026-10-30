/**
 * Which backing store the app's durable state uses (owner: A11, GCP-native state for Cloud Run).
 *
 *   STORE=firestore  Firestore (Native) database FIRESTORE_DATABASE_ID (default `giftfit-db`) for every
 *                    repository, counter, rate-limit window and audit row, plus the private Cloud Storage
 *                    bucket GCS_PHOTO_BUCKET for recipient photos and try-on renders. Cloud Run auth is ADC.
 *   STORE=memory     process memory (tests, local mock mode). Lost on restart.
 *   unset            as before A11: Drizzle/Postgres when DATABASE_URL is set, else memory.
 *
 * Safety rail: the GCP project also hosts other apps' databases (`(default)`, `shine-db`) and buckets.
 * Only a database id and a bucket name that start with "giftfit" / contain "giftfit" are accepted, so a
 * typo in an env var can never point this app at another app's data.
 */
export type StoreKind = "firestore" | "memory" | "drizzle";

export type Env = Record<string, string | undefined>;

export const DEFAULT_FIRESTORE_DATABASE_ID = "giftfit-db";

export function storeKind(env: Env = process.env): StoreKind {
  const s = env.STORE?.trim().toLowerCase();
  if (s === "firestore") return "firestore";
  if (s === "memory") return "memory";
  if (s) throw new Error(`STORE must be "firestore" or "memory", got "${env.STORE}"`);
  return env.DATABASE_URL?.trim() ? "drizzle" : "memory";
}

export const isFirestoreStore = (env: Env = process.env) => storeKind(env) === "firestore";

/** The Firestore database id (never "(default)": this app must not touch other apps' databases). */
export function firestoreDatabaseId(env: Env = process.env): string {
  const id = env.FIRESTORE_DATABASE_ID?.trim() || DEFAULT_FIRESTORE_DATABASE_ID;
  if (!/^giftfit[a-z0-9-]{0,56}$/.test(id)) throw new Error(`FIRESTORE_DATABASE_ID must be a giftfit database (e.g. ${DEFAULT_FIRESTORE_DATABASE_ID}), got "${id}"`);
  return id;
}

/** The private photo bucket (required with STORE=firestore). */
export function gcsPhotoBucket(env: Env = process.env): string {
  const b = env.GCS_PHOTO_BUCKET?.trim();
  if (!b) throw new Error("GCS_PHOTO_BUCKET is not set (required with STORE=firestore)");
  if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(b) || !b.includes("giftfit")) throw new Error(`GCS_PHOTO_BUCKET must be the giftfit photo bucket, got "${b}"`);
  return b;
}

export function gcpProjectId(env: Env = process.env): string | undefined {
  return env.GOOGLE_CLOUD_PROJECT?.trim() || undefined;
}

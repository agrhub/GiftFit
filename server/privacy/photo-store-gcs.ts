/**
 * Private Cloud Storage photo store (owner: A11; same contract and key scheme as VercelBlobPhotoStore).
 *
 *   recipient/{fitRequestId}/{selfie|hand}-{expiryMs}-{suffix}   input photos (<= 1 h)
 *   tryon/{fitRequestId}/tryon-{expiryMs}-{suffix}               try-on renders (<= 1 h)
 *
 * Objects are written once (ifGenerationMatch: 0), with Cache-Control "private, no-store" and the expiry
 * in custom metadata as well as in the key. Nothing is ever public and no GCS signed URL is ever issued:
 * bytes are streamed by the app's own route (/api/recipient/tryon/{id}), which first verifies the app's
 * HMAC signature (<= 15 min) bound to the recipient session. A GCS V4 URL would be a bearer URL.
 * deleteForRequest() lists both prefixes and deletes now; sweepExpired() deletes by the expiry in the key.
 */
import { gcsPhotoBucket, type Env } from "@/server/store/config";
import { getGcsBucket, type GcsBucketLike } from "@/server/store/gcp-clients";
import { PHOTO_MAX_TTL_MS, expiryFromKey, photoKey, type PhotoObject, type PhotoStore, type StoredPhoto } from "./photo-store";

/** The object operations GcsPhotoStore needs (the real bucket adapter is gcsObjectApi below). */
export interface GcsObjectApi {
  readonly bucket: string;
  /** Create-only write; rejects if the object exists. */
  save(name: string, bytes: Buffer, opts: { contentType: string; cacheControl: string; metadata: Record<string, string> }): Promise<void>;
  /** undefined when the object does not exist (404). */
  read(name: string): Promise<{ bytes: Uint8Array; contentType: string } | undefined>;
  /** Deletes; a missing object is not an error. */
  delete(names: readonly string[]): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

const is404 = (err: unknown) => (err as { code?: unknown } | null)?.code === 404;

/** Adapter from a @google-cloud/storage Bucket. */
export function gcsObjectApi(bucket: GcsBucketLike): GcsObjectApi {
  return {
    bucket: bucket.name,
    async save(name, bytes, opts) {
      await bucket.file(name).save(bytes, {
        resumable: false,
        contentType: opts.contentType,
        preconditionOpts: { ifGenerationMatch: 0 },
        metadata: { contentType: opts.contentType, cacheControl: opts.cacheControl, metadata: opts.metadata },
      });
    },
    async read(name) {
      const f = bucket.file(name);
      try {
        const [[meta], [buf]] = await Promise.all([f.getMetadata(), f.download()]);
        return { bytes: new Uint8Array(buf), contentType: meta.contentType ?? "application/octet-stream" };
      } catch (err) {
        if (is404(err)) return undefined;
        throw err;
      }
    },
    async delete(names) {
      for (let i = 0; i < names.length; i += 16) {
        await Promise.all(names.slice(i, i + 16).map((n) => bucket.file(n).delete({ ignoreNotFound: true })));
      }
    },
    async list(prefix) {
      const [files] = await bucket.getFiles({ prefix, autoPaginate: true });
      return files.map((f) => f.name);
    },
  };
}

function clampTtl(ttlMs: number | undefined): number {
  const ttl = ttlMs ?? PHOTO_MAX_TTL_MS;
  if (!(ttl > 0)) throw new Error("photo TTL must be positive");
  return Math.min(ttl, PHOTO_MAX_TTL_MS);
}

export class GcsPhotoStore implements PhotoStore {
  readonly kind = "gcs";
  constructor(
    private readonly api: GcsObjectApi,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async put(input: Parameters<PhotoStore["put"]>[0]): Promise<StoredPhoto> {
    const expiresAt = new Date(this.now().getTime() + clampTtl(input.ttlMs));
    const key = photoKey(input.fitRequestId, input.kind, expiresAt, input.name);
    await this.api.save(key, Buffer.from(input.bytes), {
      contentType: input.contentType,
      cacheControl: "private, no-store, max-age=0",
      metadata: { giftfitExpiresAt: expiresAt.toISOString(), giftfitKind: input.kind },
    });
    return { key, contentType: input.contentType, expiresAt };
  }

  async get(key: string): Promise<PhotoObject | undefined> {
    const exp = expiryFromKey(key);
    if (exp === undefined) return undefined;
    if (exp <= this.now().getTime()) {
      await this.delete(key);
      return undefined;
    }
    const o = await this.api.read(key);
    return o ? { key, bytes: o.bytes, contentType: o.contentType, expiresAt: new Date(exp) } : undefined;
  }

  async delete(keys: string | readonly string[]): Promise<void> {
    const list = typeof keys === "string" ? [keys] : [...keys];
    if (list.length) await this.api.delete(list);
  }

  async listForRequest(fitRequestId: string): Promise<string[]> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(fitRequestId)) throw new Error("invalid fit request id");
    const [a, b] = await Promise.all([this.api.list(`recipient/${fitRequestId}/`), this.api.list(`tryon/${fitRequestId}/`)]);
    return [...a, ...b];
  }

  async deleteForRequest(fitRequestId: string): Promise<number> {
    const keys = await this.listForRequest(fitRequestId);
    await this.delete(keys);
    return keys.length;
  }

  async sweepExpired(now = this.now()): Promise<number> {
    const [a, b] = await Promise.all([this.api.list("recipient/"), this.api.list("tryon/")]);
    // Unparseable keys under our prefixes are treated as expired: nothing else may live there.
    const overdue = [...a, ...b].filter((k) => (expiryFromKey(k) ?? 0) <= now.getTime());
    await this.delete(overdue);
    return overdue.length;
  }
}

/** GcsPhotoStore on GCS_PHOTO_BUCKET (process-wide bucket handle). */
export async function createGcsPhotoStore(env: Env = process.env): Promise<GcsPhotoStore> {
  const bucket = gcsPhotoBucket(env);
  return new GcsPhotoStore(gcsObjectApi(await getGcsBucket(bucket, env)));
}

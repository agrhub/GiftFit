/**
 * Short-TTL storage for recipient images (owner: A5).
 *
 * Two kinds of object, both private and both keyed under the Fit Request id:
 *   recipient/{fitRequestId}/...  input photos (selfie, back of hand), deleted right after try-on
 *   tryon/{fitRequestId}/...      rendered try-on images, served only via signed URLs
 *
 * Every object carries an expiry (<= 1 h). Vercel Blob has no native TTL, so the expiry is
 * also encoded in the key and sweepExpired() deletes overdue objects (run on every capture
 * and on the purge cron). Implementations: VercelBlobPhotoStore (when BLOB_READ_WRITE_TOKEN
 * is set) and MemoryPhotoStore (tests, local dev).
 */
import { randomBytes } from "node:crypto";
import { privacyState } from "./global-state";

export const PHOTO_MAX_TTL_MS = 60 * 60 * 1000;

export type PhotoKind = "selfie" | "hand" | "tryon";

export interface StoredPhoto {
  key: string;
  contentType: string;
  expiresAt: Date;
}

export interface PhotoObject extends StoredPhoto {
  bytes: Uint8Array;
}

export interface PhotoStore {
  readonly kind: string;
  put(input: { fitRequestId: string; kind: PhotoKind; bytes: Uint8Array; contentType: string; ttlMs?: number; name?: string }): Promise<StoredPhoto>;
  get(key: string): Promise<PhotoObject | undefined>;
  delete(keys: string | readonly string[]): Promise<void>;
  /** Keys of every object (photos and try-on renders) for one Fit Request. */
  listForRequest(fitRequestId: string): Promise<string[]>;
  /** Deletes every object for one Fit Request; returns how many were deleted. */
  deleteForRequest(fitRequestId: string): Promise<number>;
  /** Deletes every object whose expiry has passed; returns how many were deleted. */
  sweepExpired(now?: Date): Promise<number>;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function assertId(id: string, what: string): void {
  if (!SAFE_ID.test(id)) throw new Error(`invalid ${what}`);
}

function prefixFor(kind: PhotoKind): "recipient" | "tryon" {
  return kind === "tryon" ? "tryon" : "recipient";
}

export function photoKey(fitRequestId: string, kind: PhotoKind, expiresAt: Date, name?: string): string {
  assertId(fitRequestId, "fit request id");
  if (name !== undefined) assertId(name, "photo name");
  const suffix = name ?? randomBytes(9).toString("base64url");
  return `${prefixFor(kind)}/${fitRequestId}/${kind}-${expiresAt.getTime()}-${suffix}`;
}

/** Expiry encoded in a key (ms since epoch), or undefined for keys this module did not write. */
export function expiryFromKey(key: string): number | undefined {
  const m = /^(?:recipient|tryon)\/[A-Za-z0-9_-]+\/(?:selfie|hand|tryon)-(\d{10,16})-[A-Za-z0-9_-]+$/.exec(key);
  return m ? Number(m[1]) : undefined;
}

function clampTtl(ttlMs: number | undefined): number {
  const ttl = ttlMs ?? PHOTO_MAX_TTL_MS;
  if (!(ttl > 0)) throw new Error("photo TTL must be positive");
  return Math.min(ttl, PHOTO_MAX_TTL_MS);
}

export class MemoryPhotoStore implements PhotoStore {
  readonly kind = "memory";
  private readonly objects = new Map<string, PhotoObject>();
  constructor(private readonly now: () => Date = () => new Date()) {}

  async put(input: Parameters<PhotoStore["put"]>[0]): Promise<StoredPhoto> {
    const expiresAt = new Date(this.now().getTime() + clampTtl(input.ttlMs));
    const key = photoKey(input.fitRequestId, input.kind, expiresAt, input.name);
    this.objects.set(key, { key, contentType: input.contentType, expiresAt, bytes: new Uint8Array(input.bytes) });
    return { key, contentType: input.contentType, expiresAt };
  }

  async get(key: string): Promise<PhotoObject | undefined> {
    const o = this.objects.get(key);
    if (!o) return undefined;
    if (o.expiresAt.getTime() <= this.now().getTime()) {
      this.objects.delete(key);
      return undefined;
    }
    return o;
  }

  async delete(keys: string | readonly string[]): Promise<void> {
    for (const k of typeof keys === "string" ? [keys] : keys) this.objects.delete(k);
  }

  async listForRequest(fitRequestId: string): Promise<string[]> {
    assertId(fitRequestId, "fit request id");
    return [...this.objects.keys()].filter((k) => k.startsWith(`recipient/${fitRequestId}/`) || k.startsWith(`tryon/${fitRequestId}/`));
  }

  async deleteForRequest(fitRequestId: string): Promise<number> {
    const keys = await this.listForRequest(fitRequestId);
    await this.delete(keys);
    return keys.length;
  }

  async sweepExpired(now = this.now()): Promise<number> {
    let n = 0;
    for (const [k, o] of this.objects) {
      if (o.expiresAt.getTime() <= now.getTime()) {
        this.objects.delete(k);
        n++;
      }
    }
    return n;
  }

  /** Test helper: every key currently held. */
  keys(): string[] {
    return [...this.objects.keys()];
  }
}

/** Subset of @vercel/blob used here, injectable for tests. */
export interface BlobApi {
  put(pathname: string, body: Buffer, opts: Record<string, unknown>): Promise<{ pathname: string }>;
  get(pathname: string, opts: Record<string, unknown>): Promise<{ statusCode: number; stream: ReadableStream<Uint8Array> | null; blob: { contentType: string | null } } | null>;
  del(pathnames: string[] | string, opts?: Record<string, unknown>): Promise<void>;
  list(opts: Record<string, unknown>): Promise<{ blobs: Array<{ pathname: string }>; cursor?: string; hasMore: boolean }>;
}

/**
 * Private Vercel Blob store. Objects are written with access "private", no random suffix,
 * no overwrite and the shortest cache lifetime the service accepts (60 s), and are only
 * ever read server-side by the signed try-on route.
 */
export class VercelBlobPhotoStore implements PhotoStore {
  readonly kind = "vercel-blob";
  constructor(
    private readonly api: BlobApi,
    private readonly token: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async put(input: Parameters<PhotoStore["put"]>[0]): Promise<StoredPhoto> {
    const expiresAt = new Date(this.now().getTime() + clampTtl(input.ttlMs));
    const key = photoKey(input.fitRequestId, input.kind, expiresAt, input.name);
    await this.api.put(key, Buffer.from(input.bytes), {
      access: "private",
      contentType: input.contentType,
      addRandomSuffix: false,
      allowOverwrite: false,
      cacheControlMaxAge: 60,
      token: this.token,
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
    const r = await this.api.get(key, { access: "private", useCache: false, token: this.token });
    if (!r || r.statusCode !== 200 || !r.stream) return undefined;
    const bytes = new Uint8Array(await new Response(r.stream).arrayBuffer());
    return { key, bytes, contentType: r.blob.contentType ?? "application/octet-stream", expiresAt: new Date(exp) };
  }

  async delete(keys: string | readonly string[]): Promise<void> {
    const list = typeof keys === "string" ? [keys] : [...keys];
    if (list.length) await this.api.del(list, { token: this.token });
  }

  private async listPrefix(prefix: string): Promise<string[]> {
    const out: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.api.list({ prefix, cursor, limit: 1000, token: this.token });
      out.push(...page.blobs.map((b) => b.pathname));
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return out;
  }

  async listForRequest(fitRequestId: string): Promise<string[]> {
    assertId(fitRequestId, "fit request id");
    return [...(await this.listPrefix(`recipient/${fitRequestId}/`)), ...(await this.listPrefix(`tryon/${fitRequestId}/`))];
  }

  async deleteForRequest(fitRequestId: string): Promise<number> {
    const keys = await this.listForRequest(fitRequestId);
    await this.delete(keys);
    return keys.length;
  }

  async sweepExpired(now = this.now()): Promise<number> {
    const keys = [...(await this.listPrefix("recipient/")), ...(await this.listPrefix("tryon/"))];
    // Unparseable keys under our prefixes are treated as expired: nothing else may live there.
    const overdue = keys.filter((k) => (expiryFromKey(k) ?? 0) <= now.getTime());
    await this.delete(overdue);
    return overdue.length;
  }
}

/** Vercel Blob when BLOB_READ_WRITE_TOKEN is set, otherwise a process-local memory store. */
export async function createPhotoStore(env: Record<string, string | undefined> = process.env): Promise<PhotoStore> {
  const token = env.BLOB_READ_WRITE_TOKEN?.trim();
  if (!token) {
    // Shared by every route bundle in this process (see global-state.ts).
    const state = privacyState();
    return (state.memoryPhotos ??= new MemoryPhotoStore());
  }
  const blob = await import("@vercel/blob");
  const api: BlobApi = {
    put: (p, b, o) => blob.put(p, b, o as never),
    get: (p, o) => blob.get(p, o as never) as never,
    del: (p, o) => blob.del(p, o as never),
    list: (o) => blob.list(o as never),
  };
  return new VercelBlobPhotoStore(api, token);
}

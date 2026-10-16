import { describe, expect, it, vi } from "vitest";
import { MemoryPhotoStore, PHOTO_MAX_TTL_MS, VercelBlobPhotoStore, createPhotoStore, expiryFromKey, photoKey, type BlobApi } from "../photo-store";

const T0 = new Date("2026-10-20T12:00:00Z");
const REQ = "4b6c1f0e-1111-4c4c-9a9a-000000000001";

describe("MemoryPhotoStore", () => {
  it("caps every object at 1 h and forgets it after expiry", async () => {
    let now = new Date(T0);
    const store = new MemoryPhotoStore(() => now);
    const a = await store.put({ fitRequestId: REQ, kind: "selfie", bytes: new Uint8Array([1]), contentType: "image/jpeg", ttlMs: 10 * PHOTO_MAX_TTL_MS });
    expect(a.expiresAt.getTime() - T0.getTime()).toBe(PHOTO_MAX_TTL_MS);
    expect(a.key.startsWith(`recipient/${REQ}/selfie-`)).toBe(true);
    expect(expiryFromKey(a.key)).toBe(a.expiresAt.getTime());
    expect((await store.get(a.key))?.bytes).toEqual(new Uint8Array([1]));
    now = new Date(T0.getTime() + PHOTO_MAX_TTL_MS);
    expect(await store.get(a.key)).toBeUndefined();
    expect(store.keys()).toEqual([]);
  });

  it("deletes per request and sweeps overdue objects", async () => {
    let now = new Date(T0);
    const store = new MemoryPhotoStore(() => now);
    await store.put({ fitRequestId: REQ, kind: "selfie", bytes: new Uint8Array([1]), contentType: "image/jpeg", ttlMs: 60_000 });
    await store.put({ fitRequestId: REQ, kind: "tryon", bytes: new Uint8Array([2]), contentType: "image/png" });
    const other = await store.put({ fitRequestId: "other-req", kind: "hand", bytes: new Uint8Array([3]), contentType: "image/jpeg" });
    expect(await store.listForRequest(REQ)).toHaveLength(2);
    now = new Date(T0.getTime() + 61_000);
    expect(await store.sweepExpired()).toBe(1);
    expect(await store.deleteForRequest(REQ)).toBe(1);
    expect(store.keys()).toEqual([other.key]);
    expect(() => photoKey("../etc", "selfie", now)).toThrow(/invalid/);
    await expect(store.listForRequest("a/b")).rejects.toThrow(/invalid/);
  });
});

function fakeBlobApi() {
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  const calls: Array<[string, unknown]> = [];
  const api: BlobApi = {
    put: vi.fn(async (p: string, body: Buffer, opts: Record<string, unknown>) => {
      calls.push(["put", opts]);
      objects.set(p, { body, contentType: String(opts.contentType) });
      return { pathname: p };
    }),
    get: vi.fn(async (p: string) => {
      const o = objects.get(p);
      if (!o) return null;
      return { statusCode: 200, stream: new Response(new Uint8Array(o.body)).body, blob: { contentType: o.contentType } };
    }),
    del: vi.fn(async (ps: string[] | string) => {
      for (const p of typeof ps === "string" ? [ps] : ps) objects.delete(p);
    }),
    list: vi.fn(async (opts: Record<string, unknown>) => {
      const all = [...objects.keys()].filter((k) => k.startsWith(String(opts.prefix ?? ""))).sort();
      const start = opts.cursor ? Number(opts.cursor) : 0;
      const page = all.slice(start, start + 1);
      const hasMore = start + 1 < all.length;
      return { blobs: page.map((pathname) => ({ pathname })), hasMore, cursor: hasMore ? String(start + 1) : undefined };
    }),
  };
  return { api, objects, calls };
}

describe("VercelBlobPhotoStore", () => {
  it("writes private, non-cached, non-guessable objects and reads them back", async () => {
    const { api, calls } = fakeBlobApi();
    const store = new VercelBlobPhotoStore(api, "tok", () => T0);
    const s = await store.put({ fitRequestId: REQ, kind: "selfie", bytes: new Uint8Array([7, 7]), contentType: "image/jpeg" });
    expect(calls[0][1]).toMatchObject({ access: "private", addRandomSuffix: false, allowOverwrite: false, cacheControlMaxAge: 60, token: "tok" });
    const o = await store.get(s.key);
    expect(o?.bytes).toEqual(new Uint8Array([7, 7]));
    expect(o?.contentType).toBe("image/jpeg");
    expect(await store.get("not/a/key")).toBeUndefined();
  });

  it("lists across pages, deletes per request and sweeps by encoded expiry", async () => {
    const { api, objects } = fakeBlobApi();
    let now = new Date(T0);
    const store = new VercelBlobPhotoStore(api, "tok", () => now);
    await store.put({ fitRequestId: REQ, kind: "selfie", bytes: new Uint8Array([1]), contentType: "image/jpeg", ttlMs: 1000 });
    await store.put({ fitRequestId: REQ, kind: "tryon", bytes: new Uint8Array([2]), contentType: "image/png" });
    await store.put({ fitRequestId: REQ, kind: "tryon", bytes: new Uint8Array([3]), contentType: "image/png" });
    await store.put({ fitRequestId: "other", kind: "tryon", bytes: new Uint8Array([4]), contentType: "image/png" });
    objects.set("tryon/other/garbage", { body: Buffer.from([0]), contentType: "x" });
    expect(await store.listForRequest(REQ)).toHaveLength(3);
    now = new Date(T0.getTime() + 2000);
    expect(await store.sweepExpired()).toBe(2); // the 1 s selfie + the unparseable key
    expect(await store.deleteForRequest(REQ)).toBe(2);
    expect([...objects.keys()]).toHaveLength(1);
    // Expired objects are refused (and removed) even if the sweep has not run yet.
    now = new Date(T0.getTime() + PHOTO_MAX_TTL_MS + 1);
    const [last] = objects.keys();
    expect(await store.get(last)).toBeUndefined();
    expect(objects.size).toBe(0);
  });

  it("is only used when BLOB_READ_WRITE_TOKEN is set", async () => {
    expect((await createPhotoStore({})).kind).toBe("memory");
    expect((await createPhotoStore({ BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_x" })).kind).toBe("vercel-blob");
  });
});

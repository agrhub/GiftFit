import { describe, expect, it, vi } from "vitest";
import { fakeBucket } from "@/server/store/__tests__/fake-gcs";
import type { GcsBucketLike } from "@/server/store/gcp-clients";
import { PHOTO_MAX_TTL_MS, expiryFromKey } from "../photo-store";
import { GcsPhotoStore, gcsObjectApi, type GcsObjectApi } from "../photo-store-gcs";

const T0 = new Date("2026-10-20T12:00:00Z");
const REQ = "4b6c1f0e-1111-4c4c-9a9a-000000000001";

describe("gcsObjectApi (adapter over a Storage bucket)", () => {
  it("writes create-only, non-resumable, private no-store objects with the expiry in metadata", async () => {
    const { bucket, saves } = fakeBucket();
    const store = new GcsPhotoStore(gcsObjectApi(bucket), () => T0);
    const s = await store.put({ fitRequestId: REQ, kind: "selfie", bytes: new Uint8Array([7, 7]), contentType: "image/jpeg" });
    expect(saves[0].opts).toMatchObject({
      resumable: false,
      contentType: "image/jpeg",
      preconditionOpts: { ifGenerationMatch: 0 },
      metadata: { contentType: "image/jpeg", cacheControl: "private, no-store, max-age=0", metadata: { giftfitExpiresAt: s.expiresAt.toISOString(), giftfitKind: "selfie" } },
    });
    expect(s.expiresAt.getTime() - T0.getTime()).toBe(PHOTO_MAX_TTL_MS);
    const o = await store.get(s.key);
    expect(o).toMatchObject({ key: s.key, contentType: "image/jpeg", expiresAt: s.expiresAt });
    expect(o?.bytes).toEqual(new Uint8Array([7, 7]));
    // Same key twice is refused (no overwrite).
    await expect(store.put({ fitRequestId: REQ, kind: "selfie", bytes: new Uint8Array([1]), contentType: "image/jpeg", name: "fixed" })).resolves.toBeDefined();
    await expect(store.put({ fitRequestId: REQ, kind: "selfie", bytes: new Uint8Array([1]), contentType: "image/jpeg", name: "fixed" })).rejects.toMatchObject({ code: 412 });
  });

  it("maps 404 to undefined and deletes missing objects without error", async () => {
    const { bucket } = fakeBucket();
    const api = gcsObjectApi(bucket);
    expect(await api.read("tryon/x/tryon-1-a")).toBeUndefined();
    await expect(api.delete(["tryon/x/tryon-1-a", "recipient/x/selfie-1-b"])).resolves.toBeUndefined();
  });

  it("rethrows errors other than 404", async () => {
    const { bucket } = fakeBucket();
    const denied = () => Object.assign(new Error("denied"), { code: 403 });
    const broken: GcsBucketLike = { ...bucket, file: (n) => ({ ...bucket.file(n), getMetadata: async () => Promise.reject(denied()), download: async () => Promise.reject(denied()) }) };
    await expect(gcsObjectApi(broken).read("k")).rejects.toThrow(/denied/);
  });
});

describe("GcsPhotoStore", () => {
  it("lists per request, deletes per request now, and sweeps by the expiry encoded in the key", async () => {
    const { bucket, objects } = fakeBucket();
    let now = new Date(T0);
    const store = new GcsPhotoStore(gcsObjectApi(bucket), () => now);
    const selfie = await store.put({ fitRequestId: REQ, kind: "selfie", bytes: new Uint8Array([1]), contentType: "image/jpeg", ttlMs: 60_000 });
    const render = await store.put({ fitRequestId: REQ, kind: "tryon", bytes: new Uint8Array([2]), contentType: "image/png" });
    const other = await store.put({ fitRequestId: "other-req", kind: "hand", bytes: new Uint8Array([3]), contentType: "image/jpeg" });
    objects.set("recipient/junk/not-ours", { body: Buffer.from([0]), meta: {} });
    expect((await store.listForRequest(REQ)).sort()).toEqual([selfie.key, render.key].sort());
    expect(selfie.key.startsWith(`recipient/${REQ}/selfie-`)).toBe(true);
    expect(render.key.startsWith(`tryon/${REQ}/tryon-`)).toBe(true);
    expect(expiryFromKey(selfie.key)).toBe(selfie.expiresAt.getTime());

    now = new Date(T0.getTime() + 61_000);
    expect(await store.get(selfie.key)).toBeUndefined(); // expired: gone on read
    expect(objects.has(selfie.key)).toBe(false);
    expect(await store.sweepExpired()).toBe(1); // the unparseable key under our prefix
    expect(await store.deleteForRequest(REQ)).toBe(1);
    expect([...objects.keys()]).toEqual([other.key]);
    expect(await store.get(render.key)).toBeUndefined();
    await expect(store.listForRequest("a/b")).rejects.toThrow(/invalid/);
    expect(await store.get("not/a/key")).toBeUndefined();
  });

  it("never reads an expired object from the bucket", async () => {
    const api: GcsObjectApi = { bucket: "b", save: vi.fn(async () => {}), read: vi.fn(async () => ({ bytes: new Uint8Array([1]), contentType: "image/png" })), delete: vi.fn(async () => {}), list: vi.fn(async () => []) };
    const store = new GcsPhotoStore(api, () => T0);
    const key = `tryon/${REQ}/tryon-${T0.getTime() - 1}-abc`;
    expect(await store.get(key)).toBeUndefined();
    expect(api.read).not.toHaveBeenCalled();
    expect(api.delete).toHaveBeenCalledWith([key]);
  });
});

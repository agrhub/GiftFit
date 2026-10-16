/**
 * "Delete my photo now" (ADR-036, clarified): POST /api/recipient/delete-photo deletes every
 * face-derived image (input photos, try-on and swatch renders, result cache, YouCam tasks) at every
 * stage of the flow; hearts, wishes and the numeric profile stay. Mock YouCam only (0 units).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureResponse, RecipientSessionResponse, SwatchResponse } from "@/lib/contracts/api";
import { makeStack, type TestStack } from "@/lib/privacy/__tests__/helpers";
import { youcamCapturePorts, type CapturePorts } from "@/lib/privacy/capture";
import { deleteEverything } from "@/lib/privacy/delete-everything";
import { setPrivacyDeps } from "@/lib/privacy/runtime";
import { RECIPIENT_COOKIE } from "@/lib/privacy/session";
import { newFitRequestTokens } from "@/lib/privacy/tokens";
import { MemoryAuditSink } from "@/lib/youcam/audit";
import { MemoryResultCache } from "@/lib/youcam/cache";
import { createYoucamClient } from "@/lib/youcam/client";
import { GET as captureGET, POST as capturePOST } from "../capture/route";
import { POST as consentPOST } from "../consent/route";
import { POST as deletePhotoPOST } from "../delete-photo/route";
import { POST as deletePOST } from "../delete/route";
import { POST as donePOST } from "../done/route";
import { POST as heartsPOST } from "../hearts/route";
import { POST as sessionPOST } from "../session/route";
import { POST as swatchPOST } from "../swatch/route";
import { GET as tryonGET } from "../tryon/[id]/route";
import { GET as tryonsGET } from "../tryons/route";
import { POST as wishPOST } from "../wish-metal/route";

const BASE = "http://localhost:3000";
const AUR = {
  halo: "dca42809-a2e1-5b50-8339-240170c69845",
  aster: "96b9bb0c-8b22-597e-837e-d90ee529f9b6",
  chime: "e5c65c24-744d-5861-9f52-4edd091329bb",
  crescent: "80de0232-f515-551d-bbd5-8d2af72ff2ff",
  reverie: "74066662-deab-5925-b51f-4f39e11da0e3",
  jubilee: "2ab21844-dbf7-5d72-8edd-4a30ba1d9271",
};

let stack: TestStack;
let renders: number;
let midCapture: (() => Promise<void>) | undefined;

function ports(): (baseUrl: string) => CapturePorts {
  const client = createYoucamClient({ config: { mock: true, allowPaid: false }, cache: new MemoryResultCache(), audit: new MemoryAuditSink(), limiter: null });
  const fetchImg = vi.fn(async () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 3]), { headers: { "content-type": "image/png" } }));
  return (baseUrl) => {
    const base = youcamCapturePorts(client, { baseUrl, fetch: fetchImg as unknown as typeof fetch });
    return {
      ...base,
      analyze: async (img) => {
        const out = await base.analyze(img);
        if (midCapture) await midCapture();
        return out;
      },
      render: async (...args) => {
        renders++;
        return base.render(...args);
      },
    };
  };
}

beforeEach(() => {
  stack = makeStack();
  renders = 0;
  midCapture = undefined;
  stack.deps.capturePorts = ports();
  setPrivacyDeps(stack.deps);
});
afterEach(() => setPrivacyDeps(undefined));

const post = (path: string, token: string, body?: unknown) =>
  new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined && !(body instanceof FormData) ? { "content-type": "application/json" } : {}) },
    body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
  });
const selfieForm = () => {
  const f = new FormData();
  f.set("selfie", new File([new Uint8Array([0xff, 0xd8, 0xff, 5, 5])], "s.jpg", { type: "image/jpeg" }));
  return f;
};

async function seed() {
  const t = newFitRequestTokens();
  const request = await stack.repos.fitRequests.create({
    storeId: null,
    giverTokenHash: t.giverTokenHash,
    recipientTokenHash: t.recipientTokenHash,
    occasion: "birthday",
    budgetMin: null,
    budgetMax: 400,
    currency: "USD",
    shortlistIds: [AUR.halo, AUR.aster],
    decoyIds: [AUR.chime, AUR.crescent, AUR.reverie, AUR.jubilee],
  });
  return { request, token: t.recipientToken, giverToken: t.giverToken };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const deletePhoto = async (token: string) => {
  const res = await deletePhotoPOST(post("/api/recipient/delete-photo", token));
  return { status: res.status, body: await res.json() };
};
const session = async (token: string) => (await (await sessionPOST(post("/api/recipient/session", token))).json()) as RecipientSessionResponse;
const capture = async (token: string) => (await (await capturePOST(post("/api/recipient/capture", token, selfieForm()))).json()) as CaptureResponse;
const getCapture = async (token: string) => (await (await captureGET(new Request(`${BASE}/api/recipient/capture`, { headers: bearer(token) }))).json()) as CaptureResponse;
type TryonsEntry = { itemId: string; swatchId?: string; status: string; imageUrl?: string; failureReason?: string };
const listTryons = async (token: string) => (await (await tryonsGET(new Request(`${BASE}/api/recipient/tryons`, { headers: bearer(token) }))).json()) as { tryOns: TryonsEntry[] };
const swatch = async (token: string, itemId: string, swatchId: string) => (await (await swatchPOST(post("/api/recipient/swatch", token, { itemId, swatchId }))).json()) as SwatchResponse;
const inputPhotos = (requestId: string) => stack.photos.keys().filter((k) => k.startsWith(`recipient/${requestId}/`));
const blobsOf = (requestId: string) => stack.photos.keys().filter((k) => k.includes(`/${requestId}/`));
const extrasOf = (s: RecipientSessionResponse) => s.items.flatMap((i) => i.swatches.filter((w) => !w.isDefault).map((w) => ({ itemId: i.itemId, swatchId: w.swatchId })));
const idOf = (url: string) => url.split("/").pop()!.split("?")[0];
const fetchImage = async (token: string, url: string) =>
  (await tryonGET(new Request(`${BASE}${url}`, { headers: { cookie: `${RECIPIENT_COOKIE}=${token}` } }), { params: Promise.resolve({ id: idOf(url) }) })).status;

async function consented(token: string) {
  await sessionPOST(post("/api/recipient/session", token));
  await consentPOST(post("/api/recipient/consent", token, { accepted: true }));
}

describe("POST /api/recipient/delete-photo (every face-derived image)", () => {
  it("after capture and swatches: every image URL seen before 404s; blobs, cache and YouCam tasks are gone; picks stay", async () => {
    const { request, token } = await seed();
    await consented(token);
    const cap = await capture(token);
    const s = await session(token);
    const seen: string[] = cap.tryons.filter((t) => t.imageUrl).map((t) => t.imageUrl!);
    for (const e of extrasOf(s).slice(0, 2)) {
      const r = await swatch(token, e.itemId, e.swatchId);
      expect(r.status).toBe("ready");
      seen.push(r.imageUrl!);
    }
    const listed = (await listTryons(token)).tryOns;
    expect(listed.every((t) => t.status === "ready" && t.imageUrl)).toBe(true);
    seen.push(...listed.map((t) => t.imageUrl!));
    expect(seen.length).toBeGreaterThanOrEqual(8);
    for (const url of seen) expect(await fetchImage(token, url)).toBe(200);

    const halo = s.items.find((i) => i.title === "Halo Drop Earrings")!;
    await heartsPOST(post("/api/recipient/hearts", token, { hearts: [{ itemId: halo.itemId, swatchId: halo.swatches[0].swatchId }] }));
    await wishPOST(post("/api/recipient/wish-metal", token, { itemId: s.items[1].itemId }));
    const tasks = (await stack.repos.tryons.listForRequest(request.id)).filter((r) => r.taskId);
    expect(tasks).toHaveLength(2 + 6 + 2); // analysis + capture renders + swatch renders

    expect(await deletePhoto(token)).toEqual({ status: 200, body: { photoDeleted: true, rendersLeft: 0 } });

    for (const url of seen) expect(await fetchImage(token, url), url).toBe(404);
    expect(blobsOf(request.id)).toEqual([]);
    expect([...stack.purgedCacheKeys].sort()).toEqual([...new Set(tasks.map((t) => t.cacheKey))].sort());
    expect([...stack.deletedTasks].sort()).toEqual(tasks.map((t) => t.taskId!).sort());
    // Picks and the numeric profile stay.
    expect(await stack.repos.hearts.entries(request.id)).toHaveLength(1);
    expect(await stack.repos.wishes.list(request.id)).toHaveLength(1);
    expect((await stack.repos.profiles.get(request.id))?.undertoneEstimate).not.toBeNull();
    expect((await stack.repos.fitRequests.findById(request.id))?.photoDeletedAt).toBeInstanceOf(Date);

    // Recipient views carry no image URL; the carousel (product photos) is unchanged.
    const reload = await getCapture(token);
    expect(reload.tryons.every((t) => !t.imageUrl && t.status === "failed" && t.failureReason === "photo_deleted")).toBe(true);
    // Exactly the shape A4 keys on: status failed, failureReason photo_deleted, no imageUrl.
    const after = (await listTryons(token)).tryOns;
    expect(after.length).toBe(new Set(listed.map((t) => t.itemId + "|" + t.swatchId)).size);
    for (const t of after) {
      expect(t.status).toBe("failed");
      expect(t.failureReason).toBe("photo_deleted");
      expect("imageUrl" in t).toBe(false);
    }
    for (const t of reload.tryons) expect("imageUrl" in t).toBe(false);
    expect((await session(token)).items.map((i) => i.productImage)).toEqual(s.items.map((i) => i.productImage));

    // No more metal renders, and no YouCam call, even for a metal rendered before.
    const before = renders;
    for (const e of extrasOf(s).slice(0, 3)) expect(await swatch(token, e.itemId, e.swatchId)).toEqual({ status: "failed", failureReason: "photo_deleted", rendersLeft: 0 });
    expect(renders).toBe(before);
  });

  it("uses A1's client.purge when present", async () => {
    const { token } = await seed();
    await consented(token);
    await capture(token);
    const purge = vi.fn(async (input: { cacheKeys: readonly string[]; taskIds: readonly string[] }) => ({
      cacheKeysPurged: input.cacheKeys.length,
      tasks: input.taskIds.map((taskId) => ({ taskId, ok: true })),
    }));
    stack.deps.youcam.purge = purge;
    await deletePhoto(token);
    expect(purge).toHaveBeenCalledTimes(1);
    expect(purge.mock.calls[0][0].taskIds).toHaveLength(8);
    expect(stack.deleteTask).not.toHaveBeenCalled();
  });

  it("empties the real lib/youcam result cache through client.purge", async () => {
    const { request, token } = await seed();
    await consented(token);
    await capture(token);
    const cache = new MemoryResultCache();
    const client = createYoucamClient({ config: { mock: true, allowPaid: false }, cache, audit: new MemoryAuditSink(), limiter: null });
    const rows = (await stack.repos.tryons.listForRequest(request.id)).filter((r) => r.taskId);
    for (const r of rows) await cache.set(r.cacheKey, { feature: r.feature, taskId: r.taskId!, result: { url: 'x' }, unitsCharged: 0, createdAt: 'x' });
    const del = vi.spyOn(client, 'deleteTask');
    stack.deps.youcam.purge = (input) => client.purge(input);
    await deletePhoto(token);
    for (const r of rows) expect(await cache.get(r.cacheKey)).toBeUndefined();
    expect(del).toHaveBeenCalledTimes(rows.length);
  });

  it("during capture: whatever the in-flight capture produced is wiped, and the response has no images", async () => {
    const { request, token } = await seed();
    await consented(token);
    midCapture = async () => {
      expect((await deletePhoto(token)).body).toEqual({ photoDeleted: true, rendersLeft: 0 });
    };
    const cap = await capture(token);
    expect(cap.tryons.every((t) => !t.imageUrl && t.failureReason === "photo_deleted")).toBe(true);
    expect(blobsOf(request.id)).toEqual([]);
    const extra = extrasOf(await session(token))[0];
    expect((await swatch(token, extra.itemId, extra.swatchId)).failureReason).toBe("photo_deleted");
  });

  it("before capture: succeeds with nothing to delete; a later capture is a new photo again", async () => {
    const { request, token } = await seed();
    await consented(token);
    expect((await deletePhoto(token)).body).toEqual({ photoDeleted: true, rendersLeft: 0 });
    expect(inputPhotos(request.id)).toEqual([]);
    const cap = await capture(token);
    expect(cap.tryons.some((t) => t.status === "ready")).toBe(true);
    expect(inputPhotos(request.id)).toHaveLength(1);
    expect((await stack.repos.fitRequests.findById(request.id))?.photoDeletedAt).toBeNull();
  });

  it("is idempotent", async () => {
    const { request, token } = await seed();
    await consented(token);
    await capture(token);
    await deletePhoto(token);
    const first = (await stack.repos.fitRequests.findById(request.id))?.photoDeletedAt;
    stack.clock.advance(1000);
    for (let i = 0; i < 2; i++) expect((await deletePhoto(token)).body).toEqual({ photoDeleted: true, rendersLeft: 0 });
    expect((await stack.repos.fitRequests.findById(request.id))?.photoDeletedAt).toEqual(first);
    expect(blobsOf(request.id)).toEqual([]);
  });

  it("done and delete-everything still work afterwards", async () => {
    const { request, token } = await seed();
    await consented(token);
    await capture(token);
    await deletePhoto(token);
    expect(await (await donePOST(post("/api/recipient/done", token))).json()).toMatchObject({ photosDeleted: true, photosStored: 0 });
    expect((await deletePhoto(token)).status).toBe(200);
    expect(await (await deletePOST(post("/api/recipient/delete", token))).json()).toMatchObject({ ok: true, verified: true });
    expect(await stack.repos.countForRequest(request.id)).toEqual({ recipient_profiles: 0, tryons: 0, hearts: 0, metal_wishes: 0, fit_reports: 0 });
    expect(stack.photos.keys()).toEqual([]);
  });

  it("delete-everything right after delete-photo is verified", async () => {
    const { request, token } = await seed();
    await consented(token);
    await capture(token);
    await deletePhoto(token);
    expect((await deleteEverything(stack.deps, request.id)).verified).toBe(true);
  });

  it("rejects the giver's token and random tokens", async () => {
    const { request, token, giverToken } = await seed();
    await consented(token);
    await capture(token);
    const before = stack.photos.keys().length;
    expect((await deletePhoto(giverToken)).status).toBe(404);
    expect((await deletePhoto("x".repeat(43))).status).toBe(404);
    expect((await deletePhotoPOST(new Request(`${BASE}/api/recipient/delete-photo`, { method: "POST" }))).status).toBe(401);
    expect(stack.photos.keys()).toHaveLength(before);
    expect(inputPhotos(request.id)).toHaveLength(1);
  });
});

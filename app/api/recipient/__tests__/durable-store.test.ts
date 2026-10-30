/**
 * The recipient flow on the durable stack (A11): FirestorePrivacyRepos on the in-process Firestore fake
 * plus GcsPhotoStore on a fake private bucket. A "cold start" swaps in NEW repos/photo-store instances on
 * the same database and bucket (what Cloud Run scale-to-zero does to process memory): links, picks and
 * signed image URLs keep working; "Delete my photo now" still turns every image URL into a 404; delete
 * leaves no document and no object. The seeded demo survives a cold start too. Mock YouCam only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureResponse, DemoSeedResponse, RecipientSessionResponse } from "@/server/contracts/api";
import { readRealFacts } from "@/server/metrics/real";
import { MemoryPurchaseLog } from "@/server/metrics/purchases";
import { makeStack, type TestStack } from "@/server/privacy/__tests__/helpers";
import { youcamCapturePorts, type CapturePorts } from "@/server/privacy/capture";
import type { PrivacyDeps } from "@/server/privacy/deps";
import { resetPrivacyState } from "@/server/privacy/global-state";
import { GcsPhotoStore, gcsObjectApi } from "@/server/privacy/photo-store-gcs";
import { setRateLimitOverride } from "@/server/privacy/rate-limit";
import { FirestorePrivacyRepos } from "@/server/privacy/repos/firestore";
import { setPrivacyDeps } from "@/server/privacy/runtime";
import { RECIPIENT_COOKIE } from "@/server/privacy/session";
import { newFitRequestTokens } from "@/server/privacy/tokens";
import { FakeFirestore } from "@/server/store/__tests__/fake-firestore";
import { fakeBucket } from "@/server/store/__tests__/fake-gcs";
import { COLLECTIONS } from "@/server/store/firestore-types";
import { MemoryAuditSink } from "@/server/youcam/audit";
import { MemoryResultCache } from "@/server/youcam/cache";
import { createYoucamClient } from "@/server/youcam/client";
import { POST as seedPOST } from "../../demo/seed/route";
import { POST as capturePOST } from "../capture/route";
import { POST as consentPOST } from "../consent/route";
import { POST as deletePhotoPOST } from "../delete-photo/route";
import { POST as deletePOST } from "../delete/route";
import { POST as heartsPOST } from "../hearts/route";
import { POST as sessionPOST } from "../session/route";
import { GET as tryonGET } from "../tryon/[id]/route";

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
let db: FakeFirestore;
let bucket: ReturnType<typeof fakeBucket>;

function ports(): (baseUrl: string) => CapturePorts {
  const client = createYoucamClient({ state: "isolated", config: { mock: true, allowPaid: false }, cache: new MemoryResultCache(), audit: new MemoryAuditSink(), limiter: null });
  const fetchImg = vi.fn(async () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 3]), { headers: { "content-type": "image/png" } }));
  return (baseUrl) => youcamCapturePorts(client, { baseUrl, fetch: fetchImg as unknown as typeof fetch });
}

/** Deps on the durable stack; a new call = a new process (cold start) on the same database and bucket. */
function durableDeps(): PrivacyDeps {
  return {
    ...stack.deps,
    repos: new FirestorePrivacyRepos(db, stack.deps.now),
    photos: new GcsPhotoStore(gcsObjectApi(bucket.bucket), stack.deps.now),
    capturePorts: ports(),
  };
}

let deps: PrivacyDeps;
function coldStart() {
  deps = durableDeps();
  setPrivacyDeps(deps);
}

beforeEach(() => {
  resetPrivacyState();
  setRateLimitOverride(false);
  stack = makeStack();
  db = new FakeFirestore();
  bucket = fakeBucket();
  coldStart();
});
afterEach(() => {
  setPrivacyDeps(undefined);
  setRateLimitOverride(undefined);
});

const post = (p: string, token: string, body?: unknown) =>
  new Request(`${BASE}${p}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined && !(body instanceof FormData) ? { "content-type": "application/json" } : {}) },
    body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
  });
const selfieForm = () => {
  const f = new FormData();
  f.set("selfie", new File([new Uint8Array([0xff, 0xd8, 0xff, 5, 5])], "s.jpg", { type: "image/jpeg" }));
  return f;
};
const idOf = (url: string) => url.split("/").pop()!.split("?")[0];
const fetchImage = async (token: string, url: string) =>
  (await tryonGET(new Request(`${BASE}${url}`, { headers: { cookie: `${RECIPIENT_COOKIE}=${token}` } }), { params: Promise.resolve({ id: idOf(url) }) })).status;
const objectsOf = (requestId: string) => [...bucket.objects.keys()].filter((k) => k.includes(`/${requestId}/`));
const docsOf = (requestId: string) =>
  [COLLECTIONS.profiles, COLLECTIONS.tryons, COLLECTIONS.hearts, COLLECTIONS.wishes, COLLECTIONS.reports].flatMap((c) => db.docs(c).filter((d) => d.data.fitRequestId === requestId));

describe("recipient flow on Firestore + Cloud Storage (fakes)", () => {
  it("survives a cold start, then 'Delete my photo now' 404s every URL and delete leaves nothing", async () => {
    const t = newFitRequestTokens();
    const request = await deps.repos.fitRequests.create({
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
    const token = t.recipientToken;
    await sessionPOST(post("/api/recipient/session", token));
    await consentPOST(post("/api/recipient/consent", token, { accepted: true }));
    const cap = (await (await capturePOST(post("/api/recipient/capture", token, selfieForm()))).json()) as CaptureResponse;
    const urls = cap.tryons.filter((x) => x.imageUrl).map((x) => x.imageUrl!);
    expect(urls.length).toBeGreaterThanOrEqual(4);
    expect(objectsOf(request.id).length).toBeGreaterThanOrEqual(urls.length);

    coldStart(); // scale-to-zero: new repos and store instances, same database and bucket
    const s = (await (await sessionPOST(post("/api/recipient/session", token))).json()) as RecipientSessionResponse;
    expect(s.items.length).toBeGreaterThan(0);
    for (const url of urls) expect(await fetchImage(token, url)).toBe(200);
    const halo = s.items.find((i) => i.title === "Halo Drop Earrings")!;
    expect((await heartsPOST(post("/api/recipient/hearts", token, { hearts: [{ itemId: halo.itemId, swatchId: halo.swatches[0].swatchId }] }))).status).toBe(200);

    coldStart();
    expect((await deletePhotoPOST(post("/api/recipient/delete-photo", token))).status).toBe(200);
    for (const url of urls) expect(await fetchImage(token, url), url).toBe(404);
    expect(objectsOf(request.id)).toEqual([]);
    expect(await deps.repos.hearts.entries(request.id)).toHaveLength(1); // picks stay

    coldStart();
    expect((await deletePOST(post("/api/recipient/delete", token))).status).toBe(200);
    expect(docsOf(request.id)).toEqual([]);
    expect(objectsOf(request.id)).toEqual([]);
    expect((await deps.repos.fitRequests.findById(request.id))?.status).toBe("deleted");
    for (const url of urls) expect(await fetchImage(token, url)).not.toBe(200);
  });

  it("keeps a seeded demo across a cold start (fixtures from disk, state in Firestore with demo: true)", async () => {
    const res = await seedPOST(new Request(`${BASE}/api/demo/seed`, { method: "POST", body: "{}" }));
    expect(res.status).toBe(201);
    const seed = (await res.json()) as DemoSeedResponse;
    const token = seed.recipientPath.split("/").pop()!;
    expect(db.docs(COLLECTIONS.fitRequests)[0].data.demo).toBe(true);

    coldStart();
    const s = await sessionPOST(post("/api/recipient/session", token));
    expect(s.status).toBe(200);
    const view = await capturePOST(post("/api/recipient/capture", token, selfieForm()));
    expect(view.status).toBe(409); // demo requests are pre-captured; no capture, no YouCam
    const rows = await deps.repos.tryons.listForRequest((await deps.repos.fitRequests.findByRecipientTokenHash(db.docs(COLLECTIONS.fitRequests)[0].data.recipientTokenHash as string))!.id);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.resultRef?.startsWith("fixture:"))).toBe(true);
    expect(bucket.objects.size).toBe(0); // demo images are never copied to the bucket

    // Metrics never count demo requests.
    expect(await readRealFacts(deps.repos, new MemoryPurchaseLog(), { storeId: "x", isDefaultStore: true })).toEqual([]);
  });
});

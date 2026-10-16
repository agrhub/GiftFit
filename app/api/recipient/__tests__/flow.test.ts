/**
 * P3 recipient flow (ADR-021, lib/contracts/api.ts): session → consent → capture → hearts → done,
 * on the in-memory stack with the lib/youcam mock client (YOUCAM_MOCK, 0 units).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureResponse, DoneResponse, RecipientSessionResponse } from "@/lib/contracts/api";
import { AURUM, makeStack, seedAurumRequest, type TestStack } from "@/lib/privacy/__tests__/helpers";
import type { CapturePorts } from "@/lib/privacy/capture";
import { deleteEverything } from "@/lib/privacy/delete-everything";
import { setPrivacyDeps } from "@/lib/privacy/runtime";
import { RECIPIENT_COOKIE } from "@/lib/privacy/session";
import { FIT_REQUEST_TTL_MS, newToken } from "@/lib/privacy/tokens";
import { MemoryAuditSink } from "@/lib/youcam/audit";
import { MemoryResultCache } from "@/lib/youcam/cache";
import { createYoucamClient } from "@/lib/youcam/client";
import { youcamCapturePorts } from "@/lib/privacy/capture";
import { GET as captureGET, POST as capturePOST } from "../capture/route";
import { POST as consentPOST } from "../consent/route";
import { POST as deletePOST } from "../delete/route";
import { POST as donePOST } from "../done/route";
import { POST as heartsPOST } from "../hearts/route";
import { POST as sessionPOST } from "../session/route";
import { GET as tryonGET } from "../tryon/[id]/route";
import { GET as tryonsGET } from "../tryons/route";
import { GET as undertoneGET, POST as undertonePOST } from "../undertone/route";

const BASE = "http://localhost:3000";
let stack: TestStack;

function mockPorts(): (baseUrl: string) => CapturePorts {
  const client = createYoucamClient({ config: { mock: true, allowPaid: false }, cache: new MemoryResultCache(), audit: new MemoryAuditSink(), limiter: null });
  const fetchImg = vi.fn(async () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]), { headers: { "content-type": "image/png" } }));
  return (baseUrl) => youcamCapturePorts(client, { baseUrl, fetch: fetchImg as unknown as typeof fetch });
}

beforeEach(() => {
  stack = makeStack();
  stack.deps.capturePorts = mockPorts();
  setPrivacyDeps(stack.deps);
});
afterEach(() => setPrivacyDeps(undefined));

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const post = (path: string, token: string, body?: unknown) =>
  new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { ...auth(token), ...(body !== undefined && !(body instanceof FormData) ? { "content-type": "application/json" } : {}) },
    body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
  });

function photoForm(opts: { hand?: boolean; selfieType?: string; noSelfie?: boolean } = {}) {
  const form = new FormData();
  if (!opts.noSelfie) form.set("selfie", new File([new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3])], "selfie.jpg", { type: opts.selfieType ?? "image/jpeg" }));
  if (opts.hand) form.set("hand", new File([new Uint8Array([0xff, 0xd8, 0xff, 4, 5, 6])], "hand.jpg", { type: "image/jpeg" }));
  return form;
}

async function openAndConsent(token: string) {
  const s = (await (await sessionPOST(post("/api/recipient/session", token))).json()) as RecipientSessionResponse;
  await consentPOST(post("/api/recipient/consent", token, { accepted: true }));
  return s;
}

describe("full mock flow: session → consent → capture → hearts → done", () => {
  it("works end to end, never exposes catalog ids, and leaves no images behind", async () => {
    const { request, recipientToken } = await seedAurumRequest(stack);
    const allIds = [...request.shortlistIds, ...request.decoyIds];

    // session
    const sRes = await sessionPOST(post("/api/recipient/session", recipientToken));
    expect(sRes.status).toBe(200);
    expect(sRes.headers.get("set-cookie")).toMatch(new RegExp(`^${RECIPIENT_COOKIE}=.+; Path=/api/recipient; HttpOnly; SameSite=Strict; Max-Age=\\d+`));
    expect(sRes.headers.get("cache-control")).toMatch(/no-store/);
    const session = (await sRes.json()) as RecipientSessionResponse;
    expect(session.status).toBe("awaiting_consent");
    expect(session.occasion).toBe("anniversary");
    expect(session.items).toHaveLength(6);
    const raw = JSON.stringify(session);
    for (const id of allIds) expect(raw).not.toContain(id);
    expect(session.items.filter((i) => i.needsHandPhoto).map((i) => i.category)).toEqual(["ring"]);
    for (const i of session.items) expect(Object.keys(i).sort()).toEqual(["category", "itemId", "needsHandPhoto", "productImage", "swatches", "title"]);
    expect(raw).not.toMatch(/"price"|"currency"|:(yellow_gold|white_gold|rose_gold|silver)"/);
    expect((await stack.repos.fitRequests.findById(request.id))?.status).toBe("opened");

    // consent
    const cRes = await consentPOST(post("/api/recipient/consent", recipientToken, { accepted: true }));
    expect(((await cRes.json()) as RecipientSessionResponse).status).toBe("awaiting_capture");
    expect((await stack.repos.profiles.get(request.id))?.consentAt).toBeInstanceOf(Date);

    // capture (selfie only)
    const put = vi.spyOn(stack.photos, "put");
    const capRes = await capturePOST(post("/api/recipient/capture", recipientToken, photoForm()));
    expect(capRes.status).toBe(200);
    const cap = (await capRes.json()) as CaptureResponse;
    expect(cap.tryons).toHaveLength(6);
    expect(cap.tryons.map((t) => t.itemId).sort()).toEqual(session.items.map((i) => i.itemId).sort());
    const ring = session.items.find((i) => i.needsHandPhoto)!;
    expect(cap.tryons.find((t) => t.itemId === ring.itemId)).toMatchObject({ itemId: ring.itemId, status: "skipped_needs_hand" });
    const ready = cap.tryons.filter((t) => t.status === "ready");
    expect(ready).toHaveLength(5);
    for (const t of ready) expect(t.imageUrl).toMatch(/^\/api\/recipient\/tryon\/[^?]+\?exp=\d+&sig=[A-Za-z0-9_-]{43}$/);
    expect(["warm", "neutral", "cool"]).toContain(cap.undertone.estimate);
    expect(cap.undertone.label).toMatch(/undertone \(estimate\)$/);
    expect(cap.undertone.override).toBeNull();
    expect(cap.faceShapeLabel).toMatch(/face shape \(estimate\)|not detected/);
    expect(cap.processingSeconds).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(cap)).not.toMatch(/#[0-9a-f]{6}|store:|blob/i);
    expect(put.mock.calls.filter((c) => c[0].kind === "selfie")).toHaveLength(1);
    // Input photos are gone; only renders remain.
    expect(stack.photos.keys().every((k) => k.startsWith(`tryon/${request.id}/`))).toBe(true);
    expect(stack.photos.keys()).toHaveLength(5);

    // signed image loads with the session cookie
    const img = await tryonGET(new Request(`${BASE}${ready[0].imageUrl}`, { headers: { cookie: `${RECIPIENT_COOKIE}=${recipientToken}` } }), {
      params: Promise.resolve({ id: ready[0].imageUrl!.split("/").pop()!.split("?")[0] }),
    });
    expect(img.status).toBe(200);
    // Refreshing signed URLs keys them by the same opaque item ids.
    const list = (await (await tryonsGET(new Request(`${BASE}/api/recipient/tryons`, { headers: auth(recipientToken) }))).json()) as { tryOns: Array<{ itemId: string }> };
    expect(list.tryOns.map((x) => x.itemId).sort()).toEqual(ready.map((x) => x.itemId).sort());

    // override then label follows
    await undertonePOST(post("/api/recipient/undertone", recipientToken, { undertone: "cool" }));
    expect(((await (await undertoneGET(new Request(`${BASE}/api/recipient/undertone`, { headers: auth(recipientToken) }))).json()) as { effective: string }).effective).toBe("cool");

    // hearts (replace semantics, mapped server-side)
    const pick = session.items.filter((i) => !i.needsHandPhoto).slice(0, 3).map((i) => i.itemId);
    await heartsPOST(post("/api/recipient/hearts", recipientToken, { itemIds: pick }));
    const hRes = await heartsPOST(post("/api/recipient/hearts", recipientToken, { itemIds: pick.slice(0, 2) }));
    expect(await hRes.json()).toMatchObject({ hearted: pick.slice(0, 2) });
    const hearted = await stack.repos.hearts.list(request.id);
    expect(hearted).toHaveLength(2);
    for (const id of hearted) expect(allIds).toContain(id.split(":")[0]); // legacy itemIds heart the default variant

    // done
    const dRes = await donePOST(post("/api/recipient/done", recipientToken));
    const done = (await dRes.json()) as DoneResponse;
    expect(done).toMatchObject({ photosDeleted: true, photosStored: 0 });
    expect(Date.parse(done.completedAt)).not.toBeNaN();
    expect((await stack.repos.fitRequests.findById(request.id))?.status).toBe("completed");
    expect(stack.photos.keys()).toEqual([]);
    expect(((await (await sessionPOST(post("/api/recipient/session", recipientToken))).json()) as RecipientSessionResponse).status).toBe("completed");
    expect((await heartsPOST(post("/api/recipient/hearts", recipientToken, { itemIds: [] }))).status).toBe(409);

    // delete everything still covers every row this flow created
    const counts = await stack.repos.countForRequest(request.id);
    expect(counts).toEqual({ recipient_profiles: 1, tryons: 7, hearts: 2, metal_wishes: 0, fit_reports: 0 });
    const del = await deletePOST(post("/api/recipient/delete", recipientToken));
    expect(await del.json()).toMatchObject({ ok: true, verified: true, deleted: { rows: { recipient_profiles: 1, tryons: 7, hearts: 2 }, youcamTasks: 7, cacheEntries: 7 } });
    expect(await stack.repos.countForRequest(request.id)).toEqual({ recipient_profiles: 0, tryons: 0, hearts: 0, metal_wishes: 0, fit_reports: 0 });
  });

  it("uses the hand photo for hand jewelry", async () => {
    const { recipientToken } = await seedAurumRequest(stack);
    await openAndConsent(recipientToken);
    const cap = (await (await capturePOST(post("/api/recipient/capture", recipientToken, photoForm({ hand: true })))).json()) as CaptureResponse;
    expect(cap.tryons.every((t) => t.status === "ready")).toBe(true);
    expect(stack.photos.keys().some((k) => k.startsWith("recipient/"))).toBe(false);
  });

  it("re-capture replaces rows instead of duplicating them", async () => {
    const { request, recipientToken } = await seedAurumRequest(stack);
    await openAndConsent(recipientToken);
    await capturePOST(post("/api/recipient/capture", recipientToken, photoForm()));
    await capturePOST(post("/api/recipient/capture", recipientToken, photoForm()));
    expect((await stack.repos.countForRequest(request.id)).tryons).toBe(7);
  });
});

describe("GET /api/recipient/capture (reload, ADR-023)", () => {
  const getCapture = (token: string) => captureGET(new Request(`${BASE}/api/recipient/capture`, { headers: auth(token) }));
  const idOf = (url: string) => url.split("/").pop()!.split("?")[0];

  it("404 not_captured before capture", async () => {
    const { recipientToken } = await seedAurumRequest(stack);
    await openAndConsent(recipientToken);
    const res = await getCapture(recipientToken);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_captured" });
  });

  it("returns the same CaptureResponse with freshly signed URLs that load", async () => {
    const { recipientToken } = await seedAurumRequest(stack);
    await openAndConsent(recipientToken);
    const first = (await (await capturePOST(post("/api/recipient/capture", recipientToken, photoForm()))).json()) as CaptureResponse;
    stack.clock.advance(5 * 60 * 1000);
    const res = await getCapture(recipientToken);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    const again = (await res.json()) as CaptureResponse;

    const strip = (r: CaptureResponse) => r.tryons.map(({ itemId, status }) => ({ itemId, status })).sort((a, b) => a.itemId.localeCompare(b.itemId));
    expect(strip(again)).toEqual(strip(first));
    expect(again.undertone).toEqual(first.undertone);
    expect(again.faceShapeLabel).toBe(first.faceShapeLabel);
    expect(again.processingSeconds).toBe(0);
    for (const t of again.tryons.filter((x) => x.status === "ready")) {
      const before = first.tryons.find((x) => x.itemId === t.itemId)!;
      expect(t.imageUrl).not.toBe(before.imageUrl); // re-signed later
      expect(idOf(t.imageUrl!)).toBe(idOf(before.imageUrl!));
      const img = await tryonGET(new Request(`${BASE}${t.imageUrl}`, { headers: { cookie: `${RECIPIENT_COOKIE}=${recipientToken}` } }), { params: Promise.resolve({ id: idOf(t.imageUrl!) }) });
      expect(img.status).toBe(200);
    }
    expect(JSON.stringify(again)).not.toMatch(/#[0-9a-f]{6}|store:|blob|catalogId/i);
  });

  it("reflects an override, and reports renders gone after done or past their 1 h TTL", async () => {
    const { recipientToken } = await seedAurumRequest(stack);
    await openAndConsent(recipientToken);
    await capturePOST(post("/api/recipient/capture", recipientToken, photoForm()));
    await undertonePOST(post("/api/recipient/undertone", recipientToken, { undertone: "cool" }));
    const withOverride = (await (await getCapture(recipientToken)).json()) as CaptureResponse;
    expect(withOverride.undertone).toMatchObject({ override: "cool", label: "Cool undertone (your choice)" });

    stack.clock.advance(60 * 60 * 1000);
    const late = (await (await getCapture(recipientToken)).json()) as CaptureResponse;
    expect(late.tryons.filter((t) => t.status === "ready")).toEqual([]);
    expect(late.tryons.filter((t) => t.status === "failed").every((t) => t.failureReason === "expired")).toBe(true);
    expect(late.tryons.filter((t) => t.status === "skipped_needs_hand")).toHaveLength(1);

    await donePOST(post("/api/recipient/done", recipientToken));
    const afterDone = (await (await getCapture(recipientToken)).json()) as CaptureResponse;
    expect(afterDone.tryons.some((t) => t.status === "ready")).toBe(false);
  });
});

describe("photos are deleted even when things fail", () => {
  it("render throws → items failed, photo store has no input photos", async () => {
    const { recipientToken } = await seedAurumRequest(stack);
    const ports = mockPorts();
    stack.deps.capturePorts = (b) => ({ ...ports(b), render: async () => Promise.reject(new Error("engine exploded")) });
    await openAndConsent(recipientToken);
    const cap = (await (await capturePOST(post("/api/recipient/capture", recipientToken, photoForm({ hand: true })))).json()) as CaptureResponse;
    expect(cap.tryons.every((t) => t.status === "failed" && t.failureReason === "render_failed")).toBe(true);
    expect(stack.photos.keys()).toEqual([]);
  });

  it("analysis throws → 422, photo store empty", async () => {
    const { recipientToken } = await seedAurumRequest(stack);
    const ports = mockPorts();
    stack.deps.capturePorts = (b) => ({ ...ports(b), analyze: async () => Promise.reject(new Error("no face")) });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await openAndConsent(recipientToken);
    const res = await capturePOST(post("/api/recipient/capture", recipientToken, photoForm({ hand: true })));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "analysis_failed" });
    expect(stack.photos.keys()).toEqual([]);
  });
});

describe("capture input checks", () => {
  it("requires consent first, a selfie, and jpeg/png", async () => {
    const { recipientToken } = await seedAurumRequest(stack);
    await sessionPOST(post("/api/recipient/session", recipientToken));
    expect((await capturePOST(post("/api/recipient/capture", recipientToken, photoForm()))).status).toBe(409);
    expect((await consentPOST(post("/api/recipient/consent", recipientToken, { accepted: false }))).status).toBe(400);
    await consentPOST(post("/api/recipient/consent", recipientToken, { accepted: true }));
    expect((await capturePOST(post("/api/recipient/capture", recipientToken, photoForm({ noSelfie: true })))).status).toBe(400);
    expect((await capturePOST(post("/api/recipient/capture", recipientToken, photoForm({ selfieType: "image/gif" })))).status).toBe(415);
    expect((await capturePOST(post("/api/recipient/capture", recipientToken, { not: "multipart" }))).status).toBe(400);
    expect(stack.photos.keys()).toEqual([]);
  });

  it("hearts accept only this request's item ids", async () => {
    const { recipientToken } = await seedAurumRequest(stack);
    const s = await openAndConsent(recipientToken);
    expect((await heartsPOST(post("/api/recipient/hearts", recipientToken, { itemIds: [AURUM.earrings[0]] }))).status).toBe(400);
    expect((await heartsPOST(post("/api/recipient/hearts", recipientToken, { itemIds: "x" }))).status).toBe(400);
    expect((await heartsPOST(post("/api/recipient/hearts", recipientToken, { itemIds: [s.items[0].itemId, s.items[0].itemId] }))).status).toBe(200);
  });
});

describe("opaque item ids and per-request order", () => {
  it("item ids differ from catalog ids; order is stable per request and differs across requests", async () => {
    const orders: string[] = [];
    const idSets: string[][] = [];
    for (let i = 0; i < 6; i++) {
      const { recipientToken } = await seedAurumRequest(stack);
      const a = (await (await sessionPOST(post("/api/recipient/session", recipientToken))).json()) as RecipientSessionResponse;
      const b = (await (await sessionPOST(post("/api/recipient/session", recipientToken))).json()) as RecipientSessionResponse;
      expect(b.items).toEqual(a.items); // stable per request
      for (const it of a.items) {
        expect(it.itemId).toMatch(/^[A-Za-z0-9_-]{16}$/);
        expect([...Object.values(AURUM).flat()]).not.toContain(it.itemId);
      }
      orders.push(a.items.map((x) => x.title).join("|"));
      idSets.push(a.items.map((x) => x.itemId));
    }
    // Same six products in every request, but neither the ids nor the order repeat.
    expect(new Set(orders).size).toBeGreaterThan(1);
    expect(new Set(idSets.flat()).size).toBe(36);
  });

  it("the shortlist is not recoverable from position", async () => {
    // Shortlist listed first or last in storage must not decide the carousel position.
    const firstPositions = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const { recipientToken } = await seedAurumRequest(stack);
      const s = (await (await sessionPOST(post("/api/recipient/session", recipientToken))).json()) as RecipientSessionResponse;
      firstPositions.add(s.items[0].title);
    }
    expect(firstPositions.size).toBeGreaterThan(1);
  });
});

describe("auth on every recipient route", () => {
  const routes: Array<[string, (token: string) => Promise<Response>]> = [
    ["session", (t) => sessionPOST(post("/api/recipient/session", t))],
    ["consent", (t) => consentPOST(post("/api/recipient/consent", t, { accepted: true }))],
    ["capture", (t) => capturePOST(post("/api/recipient/capture", t, photoForm()))],
    ["capture GET", (t) => captureGET(new Request(`${BASE}/api/recipient/capture`, { headers: auth(t) }))],
    ["hearts", (t) => heartsPOST(post("/api/recipient/hearts", t, { itemIds: [] }))],
    ["done", (t) => donePOST(post("/api/recipient/done", t))],
    ["delete", (t) => deletePOST(post("/api/recipient/delete", t))],
    ["undertone GET", (t) => undertoneGET(new Request(`${BASE}/api/recipient/undertone`, { headers: auth(t) }))],
    ["undertone POST", (t) => undertonePOST(post("/api/recipient/undertone", t, { undertone: "cool" }))],
    ["tryons", (t) => tryonsGET(new Request(`${BASE}/api/recipient/tryons`, { headers: auth(t) }))],
    ["tryon image", (t) => tryonGET(new Request(`${BASE}/api/recipient/tryon/x?exp=1&sig=${"a".repeat(43)}`, { headers: auth(t) }), { params: Promise.resolve({ id: "x" }) })],
  ];

  it.each(routes)("%s rejects the giver's token and random tokens without side effects", async (_n, call) => {
    const { request, giverToken } = await seedAurumRequest(stack);
    expect((await call(giverToken)).status).toBe(404);
    expect((await call(newToken())).status).toBe(404);
    const after = await stack.repos.fitRequests.findById(request.id);
    expect(after?.status).toBe("created");
    expect(await stack.repos.countForRequest(request.id)).toEqual({ recipient_profiles: 0, tryons: 0, hearts: 0, metal_wishes: 0, fit_reports: 0 });
  });

  it.each(routes.filter(([n]) => n !== "delete"))("%s answers 410 with status expired after 72 h", async (_n, call) => {
    const { request, recipientToken } = await seedAurumRequest(stack);
    stack.clock.advance(FIT_REQUEST_TTL_MS);
    const res = await call(recipientToken);
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ status: "expired" });
    expect((await stack.repos.fitRequests.findById(request.id))?.status).toBe("expired");
  });
});

describe("delete-everything after a real flow", () => {
  it("purges rows created by session/consent/capture/hearts even before done", async () => {
    const { request, recipientToken } = await seedAurumRequest(stack);
    const s = await openAndConsent(recipientToken);
    await capturePOST(post("/api/recipient/capture", recipientToken, photoForm({ hand: true })));
    await heartsPOST(post("/api/recipient/hearts", recipientToken, { itemIds: [s.items[0].itemId] }));
    const receipt = await deleteEverything(stack.deps, request.id);
    expect(receipt.verified).toBe(true);
    expect(receipt.deleted.rows).toEqual({ recipient_profiles: 1, tryons: 8, hearts: 1, metal_wishes: 0, fit_reports: 0 });
    expect(receipt.deleted.blobs).toBe(6);
    expect(stack.photos.keys()).toEqual([]);
  });
});

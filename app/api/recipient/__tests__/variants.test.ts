/**
 * Metal variants on the recipient side (ADR-032/035): swatches in the session, default-metal
 * capture, lazy swatch renders with cache and cap, variant hearts, metal wishes, delete-everything,
 * and the giver's report through A3's adapter. Mock YouCam only (0 units).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureResponse, RecipientSessionResponse, SwatchResponse } from "@/lib/contracts/api";
import { configureFit, resetFitDeps } from "@/lib/fit/deps";
import { makeStack, type TestStack } from "@/lib/privacy/__tests__/helpers";
import { youcamCapturePorts, type CapturePorts } from "@/lib/privacy/capture";
import { deleteEverything } from "@/lib/privacy/delete-everything";
import { setPrivacyDeps } from "@/lib/privacy/runtime";
import { RECIPIENT_COOKIE } from "@/lib/privacy/session";
import { newFitRequestTokens } from "@/lib/privacy/tokens";
import { MemoryAuditSink } from "@/lib/youcam/audit";
import { MemoryResultCache } from "@/lib/youcam/cache";
import { createYoucamClient } from "@/lib/youcam/client";
import { POST as reportPOST } from "@/app/api/fit/report/route";
import { POST as capturePOST } from "../capture/route";
import { POST as consentPOST } from "../consent/route";
import { POST as donePOST } from "../done/route";
import { POST as heartsPOST } from "../hearts/route";
import { POST as sessionPOST } from "../session/route";
import { POST as swatchPOST } from "../swatch/route";
import { GET as tryonGET } from "../tryon/[id]/route";
import { POST as wishPOST } from "../wish-metal/route";

const BASE = "http://localhost:3000";
const AUR = {
  halo: "dca42809-a2e1-5b50-8339-240170c69845", // yellow 245 · white 265 · rose 249
  aster: "96b9bb0c-8b22-597e-837e-d90ee529f9b6", // single metal
  chime: "e5c65c24-744d-5861-9f52-4edd091329bb", // rose 259 · yellow 259 · white 325
  crescent: "80de0232-f515-551d-bbd5-8d2af72ff2ff", // rose 259 · yellow 319 · silver 109
  reverie: "74066662-deab-5925-b51f-4f39e11da0e3", // white 215 · yellow 335 · rose 335
  jubilee: "2ab21844-dbf7-5d72-8edd-4a30ba1d9271", // white 245 · yellow 239
};

let stack: TestStack;
let renders: number;

function countingPorts(overrides: Partial<CapturePorts> = {}): (baseUrl: string) => CapturePorts {
  const client = createYoucamClient({ config: { mock: true, allowPaid: false }, cache: new MemoryResultCache(), audit: new MemoryAuditSink(), limiter: null });
  const fetchImg = vi.fn(async () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 7]), { headers: { "content-type": "image/png" } }));
  return (baseUrl) => {
    const base = youcamCapturePorts(client, { baseUrl, fetch: fetchImg as unknown as typeof fetch });
    return {
      ...base,
      render: async (...args) => {
        renders++;
        return (overrides.render ?? base.render)(...args);
      },
      ...(overrides.analyze ? { analyze: overrides.analyze } : {}),
    };
  };
}

beforeEach(() => {
  stack = makeStack();
  renders = 0;
  stack.deps.capturePorts = countingPorts();
  setPrivacyDeps(stack.deps);
  configureFit({ now: () => new Date(stack.clock.now) });
});
afterEach(() => {
  resetFitDeps();
  setPrivacyDeps(undefined);
});

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const post = (path: string, token: string, body?: unknown) =>
  new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { ...auth(token), ...(body !== undefined && !(body instanceof FormData) ? { "content-type": "application/json" } : {}) },
    body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
  });
const selfieForm = () => {
  const f = new FormData();
  f.set("selfie", new File([new Uint8Array([0xff, 0xd8, 0xff, 9, 9])], "s.jpg", { type: "image/jpeg" }));
  return f;
};

/** Halo Drop (3 metals) + a single-metal pick; decoys with 3, 3, 3 and 2 metals under $400. */
async function seedVariantRequest(opts: { metalLock?: ("yellow_gold" | "white_gold" | "rose_gold" | "silver")[]; shortlist?: string[] } = {}) {
  const t = newFitRequestTokens();
  const request = await stack.repos.fitRequests.create({
    storeId: null,
    giverTokenHash: t.giverTokenHash,
    recipientTokenHash: t.recipientTokenHash,
    occasion: "anniversary",
    budgetMin: null,
    budgetMax: 400,
    currency: "USD",
    shortlistIds: opts.shortlist ?? [AUR.halo, AUR.aster],
    decoyIds: [AUR.chime, AUR.crescent, AUR.reverie, AUR.jubilee],
    metalLock: opts.metalLock ?? null,
  });
  return { request, giverToken: t.giverToken, recipientToken: t.recipientToken };
}

async function session(token: string) {
  return (await (await sessionPOST(post("/api/recipient/session", token))).json()) as RecipientSessionResponse;
}

async function captured(token: string) {
  await sessionPOST(post("/api/recipient/session", token));
  await consentPOST(post("/api/recipient/consent", token, { accepted: true }));
  const cap = (await (await capturePOST(post("/api/recipient/capture", token, selfieForm()))).json()) as CaptureResponse;
  return { cap, s: await session(token) };
}

const swatch = async (token: string, itemId: string, swatchId: string) => {
  const res = await swatchPOST(post("/api/recipient/swatch", token, { itemId, swatchId }));
  return { status: res.status, body: (await res.json()) as SwatchResponse & { error?: string } };
};

describe("session swatches", () => {
  it("every item carries swatches in one shape; no prices, catalog or variant ids", async () => {
    const { request, recipientToken } = await seedVariantRequest();
    const s = await session(recipientToken);
    expect(s.items).toHaveLength(6);
    const raw = JSON.stringify(s);
    expect(raw).not.toMatch(/"price"|"currency"|\$\d/);
    for (const id of [...request.shortlistIds, ...request.decoyIds]) expect(raw).not.toContain(id);
    // No internal variant ids ("<catalogId>:<metal>"). Public product-image filenames may name a metal
    // (e.g. aur-ear-034-yellow_gold.jpg) for every item alike, so they reveal nothing about the shortlist.
    expect(raw).not.toMatch(/:(yellow_gold|white_gold|rose_gold|silver|platinum|mixed_two_tone)/);
    for (const item of s.items) {
      expect(item.swatches.length).toBeGreaterThanOrEqual(1);
      expect(item.swatches.filter((w) => w.isDefault)).toHaveLength(1);
      for (const w of item.swatches) {
        expect(Object.keys(w).sort()).toEqual(["isDefault", "metalLabel", "swatchColor", "swatchId"]);
        expect(w.swatchId).toMatch(/^[A-Za-z0-9_-]{16}$/);
        expect(["Yellow gold", "Rose gold", "White gold", "Sterling silver", "Platinum", "Two-tone"]).toContain(w.metalLabel);
        expect(w.swatchColor).toMatch(/^#[0-9A-F]{6}$/);
      }
    }
    const halo = s.items.find((i) => i.title === "Halo Drop Earrings")!;
    expect(halo.swatches.map((w) => w.metalLabel).sort()).toEqual(["Rose gold", "White gold", "Yellow gold"]);
  });

  it("shortlist and decoys are indistinguishable in swatch shape (leveled counts, same fields)", async () => {
    const { request, recipientToken } = await seedVariantRequest();
    const s = await session(recipientToken);
    const titleOf = new Map((await stack.deps.catalog.getSkus([...request.shortlistIds, ...request.decoyIds])).map((k) => [k.id, k.title]));
    const shortTitles = new Set(request.shortlistIds.map((id) => titleOf.get(id)));
    const counts = (pick: boolean) => s.items.filter((i) => shortTitles.has(i.title) === pick).map((i) => i.swatches.length);
    const maxShort = Math.max(...counts(true));
    // The design with the most swatches is never only a shortlist design (lib/fit swatchCap leveling).
    expect(counts(false).some((n) => n >= maxShort)).toBe(true);
    const shape = (pick: boolean) => new Set(s.items.filter((i) => shortTitles.has(i.title) === pick).flatMap((i) => i.swatches.map((w) => Object.keys(w).sort().join())));
    expect([...shape(true)]).toEqual([...shape(false)]);
  });

  it("respects the giver's metal lock, and swatch ids differ across requests", async () => {
    // A3's POST /api/fit/requests refuses a lock that leaves a pick with no metal (422), so only lockable picks here.
    const a = await seedVariantRequest({ metalLock: ["yellow_gold"], shortlist: [AUR.halo] });
    const sa = await session(a.recipientToken);
    for (const i of sa.items) for (const w of i.swatches) expect(w.metalLabel).toBe("Yellow gold");
    const b = await seedVariantRequest();
    const c = await seedVariantRequest();
    const ids = async (t: string) => (await session(t)).items.flatMap((i) => i.swatches.map((w) => w.swatchId));
    const [ib, ic] = [await ids(b.recipientToken), await ids(c.recipientToken)];
    expect(ib.filter((x) => ic.includes(x))).toEqual([]);
  });
});

describe("capture renders the default swatch and keeps the selfie only for swatches", () => {
  it("one render per item, tagged with the default swatch; selfie kept until done", async () => {
    const { recipientToken, request } = await seedVariantRequest();
    const { cap, s } = await captured(recipientToken);
    expect(renders).toBe(6);
    for (const t of cap.tryons) {
      const item = s.items.find((i) => i.itemId === t.itemId)!;
      expect(t.swatchId).toBe(item.swatches.find((w) => w.isDefault)!.swatchId);
      expect(t.status).toBe("ready");
    }
    const keys = stack.photos.keys();
    expect(keys.filter((k) => k.startsWith(`recipient/${request.id}/selfie-`))).toHaveLength(1);
    await donePOST(post("/api/recipient/done", recipientToken));
    expect(stack.photos.keys()).toEqual([]);
  });

  it("drops the selfie right away when no design has a second metal", async () => {
    const t = newFitRequestTokens();
    await stack.repos.fitRequests.create({
      storeId: null,
      giverTokenHash: t.giverTokenHash,
      recipientTokenHash: t.recipientTokenHash,
      occasion: null,
      budgetMin: null,
      budgetMax: 400,
      currency: "USD",
      shortlistIds: [AUR.halo],
      decoyIds: [AUR.chime, AUR.crescent],
      metalLock: ["rose_gold"],
    });
    await captured(t.recipientToken);
    expect(stack.photos.keys().some((k) => k.startsWith("recipient/"))).toBe(false);
  });
});

describe("POST /api/recipient/swatch", () => {
  it("renders lazily, caches per (photo, variant), and caps extra renders at 4", async () => {
    const { recipientToken, request } = await seedVariantRequest();
    const { s } = await captured(recipientToken);
    expect(renders).toBe(6);

    // The default swatch is already rendered: free.
    const halo = s.items.find((i) => i.title === "Halo Drop Earrings")!;
    const def = halo.swatches.find((w) => w.isDefault)!;
    const d = await swatch(recipientToken, halo.itemId, def.swatchId);
    expect(d.body).toMatchObject({ status: "ready", rendersLeft: 4 });
    expect(renders).toBe(6);

    const extras = s.items.flatMap((i) => i.swatches.filter((w) => !w.isDefault).map((w) => ({ itemId: i.itemId, swatchId: w.swatchId })));
    expect(extras.length).toBeGreaterThanOrEqual(5);

    const first = await swatch(recipientToken, extras[0].itemId, extras[0].swatchId);
    expect(first.body).toMatchObject({ status: "ready", rendersLeft: 3 });
    expect(first.body.imageUrl).toMatch(/^\/api\/recipient\/tryon\/[^?]+\?exp=\d+&sig=/);
    expect(renders).toBe(7);
    const img = await tryonGET(new Request(`${BASE}${first.body.imageUrl}`, { headers: { cookie: `${RECIPIENT_COOKIE}=${recipientToken}` } }), {
      params: Promise.resolve({ id: first.body.imageUrl!.split("/").pop()!.split("?")[0] }),
    });
    expect(img.status).toBe(200);

    // Cached repeat: no call, no count.
    const again = await swatch(recipientToken, extras[0].itemId, extras[0].swatchId);
    expect(again.body).toMatchObject({ status: "ready", rendersLeft: 3 });
    expect(renders).toBe(7);

    for (let i = 1; i < 4; i++) expect((await swatch(recipientToken, extras[i].itemId, extras[i].swatchId)).body.status).toBe("ready");
    expect(renders).toBe(10);
    // At the cap the kept selfie is gone.
    expect(stack.photos.keys().some((k) => k.startsWith(`recipient/${request.id}/`))).toBe(false);

    const fifth = await swatch(recipientToken, extras[4].itemId, extras[4].swatchId);
    expect(fifth.body).toEqual({ status: "cap_reached", rendersLeft: 0 });
    expect(renders).toBe(10);
    // Already-rendered swatches stay available after the cap.
    expect((await swatch(recipientToken, extras[1].itemId, extras[1].swatchId)).body).toMatchObject({ status: "ready", rendersLeft: 0 });
    expect(JSON.stringify(fifth.body)).not.toMatch(/price|:yellow_gold|store:/);
  });

  it("maps engine failures like capture and does not count them", async () => {
    const { recipientToken } = await seedVariantRequest();
    const { s } = await captured(recipientToken);
    stack.deps.capturePorts = countingPorts({ render: async (kind, _src, catalogId) => ({ catalogId, kind, ok: false, code: "ERROR_EARLOBE_NOT_FOUND" }) });
    const extra = s.items.flatMap((i) => i.swatches.filter((w) => !w.isDefault).map((w) => ({ itemId: i.itemId, swatchId: w.swatchId })))[0];
    const r = await swatch(recipientToken, extra.itemId, extra.swatchId);
    expect(r.body).toEqual({ status: "failed", failureReason: "ERROR_EARLOBE_NOT_FOUND", rendersLeft: 4 });
  });

  it("validates ids and state", async () => {
    const { recipientToken } = await seedVariantRequest();
    const s0 = await session(recipientToken);
    expect((await swatch(recipientToken, s0.items[0].itemId, s0.items[0].swatches[0].swatchId)).status).toBe(409); // before capture
    const { s } = await captured(recipientToken);
    const [a, b] = [s.items[0], s.items.find((i) => i.swatches.length > 1 && i.itemId !== s.items[0].itemId)!];
    expect((await swatch(recipientToken, "nope", a.swatches[0].swatchId)).body.error).toBe("unknown_item");
    expect((await swatch(recipientToken, a.itemId, b.swatches[1].swatchId)).body.error).toBe("unknown_swatch");
    expect((await swatchPOST(post("/api/recipient/swatch", recipientToken, { itemId: a.itemId }))).status).toBe(400);
    await donePOST(post("/api/recipient/done", recipientToken));
    expect((await swatch(recipientToken, a.itemId, a.swatches[0].swatchId)).status).toBe(409);
  });

  it("reports photo_expired once the kept selfie is past its 1 h TTL", async () => {
    const { recipientToken } = await seedVariantRequest();
    const { s } = await captured(recipientToken);
    stack.clock.advance(60 * 60 * 1000 + 1);
    const extra = s.items.flatMap((i) => i.swatches.filter((w) => !w.isDefault).map((w) => ({ itemId: i.itemId, swatchId: w.swatchId })))[0];
    expect((await swatch(recipientToken, extra.itemId, extra.swatchId)).body).toMatchObject({ status: "failed", failureReason: "photo_expired" });
  });

  it("rejects the giver's token", async () => {
    const { giverToken } = await seedVariantRequest();
    expect((await swatchPOST(post("/api/recipient/swatch", giverToken, { itemId: "x", swatchId: "y" }))).status).toBe(404);
    expect((await wishPOST(post("/api/recipient/wish-metal", giverToken, { itemId: "x" }))).status).toBe(404);
  });
});

describe("hearts per variant and metal wishes", () => {
  it("stores hearts per variant, accepts legacy itemIds, and records wishes without a render", async () => {
    const { request, recipientToken } = await seedVariantRequest();
    const { s } = await captured(recipientToken);
    const halo = s.items.find((i) => i.title === "Halo Drop Earrings")!;
    const [w1, w2] = halo.swatches.filter((w) => !w.isDefault);
    const res = await heartsPOST(post("/api/recipient/hearts", recipientToken, { hearts: [{ itemId: halo.itemId, swatchId: w1.swatchId }, { itemId: halo.itemId, swatchId: w2.swatchId }] }));
    expect(await res.json()).toEqual({ hearted: [halo.itemId], hearts: [{ itemId: halo.itemId, swatchId: w1.swatchId }, { itemId: halo.itemId, swatchId: w2.swatchId }] });
    const entries = await stack.repos.hearts.entries(request.id);
    expect(entries.map((e) => e.variantId?.split(":")[0])).toEqual([AUR.halo, AUR.halo]);
    expect(new Set(entries.map((e) => e.variantId)).size).toBe(2);

    // Legacy: default swatch; replaces the set.
    await heartsPOST(post("/api/recipient/hearts", recipientToken, { itemIds: [halo.itemId] }));
    const legacy = await stack.repos.hearts.entries(request.id);
    expect(legacy).toHaveLength(1);
    expect(legacy[0].variantId).toMatch(new RegExp(`^${AUR.halo}:`));

    // Bad pairs.
    expect((await heartsPOST(post("/api/recipient/hearts", recipientToken, { hearts: [{ itemId: halo.itemId, swatchId: "x" }] }))).status).toBe(400);
    expect((await heartsPOST(post("/api/recipient/hearts", recipientToken, { hearts: "x" }))).status).toBe(400);

    // Wish: no render, idempotent, visible to lib/fit as `wish:<designId>`.
    const before = renders;
    const aster = s.items.find((i) => i.title !== "Halo Drop Earrings" && i.swatches.length === 1)!;
    expect(await (await wishPOST(post("/api/recipient/wish-metal", recipientToken, { itemId: aster.itemId }))).json()).toEqual({ wished: [aster.itemId] });
    await wishPOST(post("/api/recipient/wish-metal", recipientToken, { itemId: aster.itemId }));
    expect(renders).toBe(before);
    expect(await stack.repos.wishes.list(request.id)).toHaveLength(1);
    expect((await stack.repos.hearts.list(request.id)).filter((r) => r.startsWith("wish:"))).toHaveLength(1);
    expect((await wishPOST(post("/api/recipient/wish-metal", recipientToken, { itemId: "nope" }))).status).toBe(400);
  });

  it("delete-everything clears variant hearts and wishes", async () => {
    const { request, recipientToken } = await seedVariantRequest();
    const { s } = await captured(recipientToken);
    const halo = s.items.find((i) => i.title === "Halo Drop Earrings")!;
    const extra = halo.swatches.find((w) => !w.isDefault)!;
    await swatch(recipientToken, halo.itemId, extra.swatchId);
    await heartsPOST(post("/api/recipient/hearts", recipientToken, { hearts: [{ itemId: halo.itemId, swatchId: extra.swatchId }] }));
    await wishPOST(post("/api/recipient/wish-metal", recipientToken, { itemId: s.items[0].itemId }));
    expect(await stack.repos.countForRequest(request.id)).toMatchObject({ hearts: 1, metal_wishes: 1, tryons: 9 });
    const receipt = await deleteEverything(stack.deps, request.id);
    expect(receipt.verified).toBe(true);
    expect(receipt.deleted.rows).toMatchObject({ hearts: 1, metal_wishes: 1, tryons: 9 });
    expect(await stack.repos.countForRequest(request.id)).toEqual({ recipient_profiles: 0, tryons: 0, hearts: 0, metal_wishes: 0, fit_reports: 0 });
    expect(stack.photos.keys()).toEqual([]);
  });
});

describe("giver report through A3's adapter", () => {
  it("shows the hearted design's metal and price, and otherMetalWishes; nothing recipient-visual", async () => {
    const { request, recipientToken, giverToken } = await seedVariantRequest();
    const { s } = await captured(recipientToken);
    const halo = s.items.find((i) => i.title === "Halo Drop Earrings")!;
    const sessionSwatch = (label: string) => halo.swatches.find((w) => w.metalLabel === label)!;
    await heartsPOST(post("/api/recipient/hearts", recipientToken, { hearts: [{ itemId: halo.itemId, swatchId: sessionSwatch("White gold").swatchId }] }));
    const aster = s.items.find((i) => i.title !== "Halo Drop Earrings" && request.shortlistIds.length && i.swatches.length === 1 && i.category === "earring")!;
    await wishPOST(post("/api/recipient/wish-metal", recipientToken, { itemId: aster.itemId }));
    await donePOST(post("/api/recipient/done", recipientToken));

    const res = await reportPOST(new Request(`${BASE}/api/fit/report`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ giverToken }) }));
    expect(res.status).toBe(200);
    const report = (await res.json()) as {
      status: string;
      results: Array<{ skuId: string; variantId?: string; metal?: string; price?: number; wishOtherMetal?: boolean }>;
      heartedShortlistIds?: string[];
      otherMetalWishes?: string[];
    };
    expect(report.status).toBe("completed");
    const haloResult = report.results.find((r) => r.skuId === AUR.halo)!;
    expect(haloResult).toMatchObject({ metal: "white_gold", price: 265 });
    expect(report.heartedShortlistIds).toEqual([AUR.halo]);
    // Aster is a shortlist design only if the session's single-metal earring is Aster.
    if (aster.title.startsWith("Aster")) expect(report.otherMetalWishes).toEqual([AUR.aster]);
    expect(JSON.stringify(report)).not.toMatch(/\/api\/recipient|store:|#[0-9a-fA-F]{6}|skin|swatchId/);
  });
});

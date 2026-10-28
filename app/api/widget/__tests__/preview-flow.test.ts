/**
 * Store-URL previews end to end through the real route modules (A6, ADR-055): the Concierge grounds on
 * the preview's own catalog (jewelry → brief; other stores → products only), a Fit Request from a
 * preview on the PUBLIC production site (A16: YOUCAM_MOCK=0, recording switch off) is hearts-only (session
 * tryOn:false, capture and swatch refused, no YouCam), and every giver response stays leak-free. The try-on
 * path for previews (owner recording / mock) is in lib/privacy/__tests__/tryon-mode.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as conciergePOST } from "@/app/api/concierge/route";
import { POST as reportPOST } from "@/app/api/fit/report/route";
import { POST as requestsPOST } from "@/app/api/fit/requests/route";
import { POST as capturePOST } from "@/app/api/recipient/capture/route";
import { POST as consentPOST } from "@/app/api/recipient/consent/route";
import { POST as donePOST } from "@/app/api/recipient/done/route";
import { POST as heartsPOST } from "@/app/api/recipient/hearts/route";
import { POST as sessionPOST } from "@/app/api/recipient/session/route";
import { POST as swatchPOST } from "@/app/api/recipient/swatch/route";
import type { ConciergeEvent } from "@/lib/concierge/types";
import type { CreateFitRequestResponse, RecipientSessionResponse } from "@/lib/contracts/api";
import { resetFitDeps } from "@/lib/fit/deps";
import { findGiverLeaks } from "@/lib/privacy/giver-guard";
import { makeStack, type TestStack } from "@/lib/privacy/__tests__/helpers";
import { setPrivacyDeps } from "@/lib/privacy/runtime";
import { defaultPreviewRepo, type MemoryPreviewRepo } from "@/lib/preview/repo";
import { PreviewAwareCatalog, previewKeyOfSkuId } from "@/lib/widget/preview";
import { fixturePreview } from "@/lib/widget/preview-fixtures";

const repo = defaultPreviewRepo() as MemoryPreviewRepo;
let stack: TestStack;
let youcamCalls = 0;

beforeEach(() => {
  vi.stubEnv("CONCIERGE_MOCK", "1");
  stack = makeStack();
  stack.clock.now = new Date();
  youcamCalls = 0;
  stack.deps.catalog = new PreviewAwareCatalog(stack.deps.catalog);
  stack.deps.capturePorts = () => {
    youcamCalls++;
    throw new Error("YouCam must never be reached for a preview");
  };
  setPrivacyDeps(stack.deps);
  resetFitDeps();
});
afterEach(() => {
  setPrivacyDeps(undefined);
  resetFitDeps();
  repo.records.clear();
  vi.unstubAllEnvs();
});

async function seed(kind: "jewelry" | "generic") {
  const f = fixturePreview(kind, { imageBase: "https://giftfit.example" });
  await repo.create(f.record);
  return f.record.key;
}

const post = (url: string, body: unknown, bearer?: string) =>
  new Request(`https://giftfit.example${url}`, { method: "POST", headers: { "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body) });

async function chat(store: string, content: string): Promise<{ status: number; events: ConciergeEvent[] }> {
  const res = await conciergePOST(post("/api/concierge", { messages: [{ role: "user", content }], store }));
  if (res.status !== 200) return { status: res.status, events: [] };
  const events = (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l) as ConciergeEvent);
  return { status: 200, events };
}
const finalOf = (evs: ConciergeEvent[]) => evs.find((e): e is Extract<ConciergeEvent, { type: "final" }> => e.type === "final")!;

describe("Concierge on a preview store", () => {
  it("jewelry preview: a brief and suggestions from that preview only", async () => {
    const key = await seed("jewelry");
    await seed("jewelry"); // another preview's SKUs must never show up
    const { status, events } = await chat(`preview:${key}`, "Birthday gift for my sister, earrings under $300");
    expect(status).toBe(200);
    const f = finalOf(events);
    expect(f.brief).toMatchObject({ occasion: "birthday", budgetMax: 300 });
    expect(f.suggestions.length).toBeGreaterThan(0);
    for (const s of f.suggestions) expect(previewKeyOfSkuId(s.catalogId)).toBe(key);
    for (const e of events) expect(findGiverLeaks(e, { allowProductImages: true })).toEqual([]);
  });

  it("non-jewelry preview: product suggestions, no brief", async () => {
    const key = await seed("generic");
    const f = finalOf((await chat(`preview:${key}`, "A tea gift for my dad under $50")).events);
    expect(f.brief).toBeUndefined();
    expect(f.products?.length).toBeGreaterThan(0);
    expect(f.products?.every((p) => p.url.startsWith("https://teahouse.example/"))).toBe(true);
  });

  it("unknown or malformed preview stores are refused before any answer", async () => {
    expect((await chat(`preview:${"Z".repeat(22)}`, "gift")).status).toBe(404);
    expect((await chat("preview:nope", "gift")).status).toBe(400);
    expect((await chat("aurum", "Birthday gift for my sister, earrings under $300")).status).toBe(200);
  });
});

describe("Fit Request from a preview on the public site: hearts only, never YouCam", () => {
  it("help me choose → session tryOn:false → capture/swatch 409 → hearts → done → report", async () => {
    // Production: real mode, no owner recording session (A16) → 0 units, hearts-only.
    vi.stubEnv("YOUCAM_MOCK", "0");
    stack.deps.youcamMode = () => "real";
    const key = await seed("jewelry");
    const created = await requestsPOST(post("/api/fit/requests", { storeId: `preview:${key}`, mode: "help_me_choose", occasion: "birthday", budgetMax: 300, currency: "USD", shortlistIds: [], categories: ["earring"] }));
    expect(created.status).toBe(201);
    const c = (await created.json()) as CreateFitRequestResponse;
    expect(c.tryOn).toBe(false);
    const recipientToken = c.recipientPath.split("/").pop()!;

    const session = (await (await sessionPOST(post("/api/recipient/session", {}, recipientToken))).json()) as RecipientSessionResponse;
    expect(session.tryOn).toBe(false);
    expect(session).toMatchObject({ tryOnNote: "preview_off", preview: true });
    expect(session.items.length).toBeGreaterThanOrEqual(4);
    for (const i of session.items) expect(i.productImage).toMatch(/^https:\/\/giftfit\.example\/catalog\/aurum\//);

    await consentPOST(post("/api/recipient/consent", { accepted: true }, recipientToken));
    const form = new FormData();
    form.append("selfie", new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: "image/jpeg" }), "s.jpg");
    const capture = await capturePOST(new Request("https://giftfit.example/api/recipient/capture", { method: "POST", headers: { Authorization: `Bearer ${recipientToken}` }, body: form }));
    expect(capture.status).toBe(409);
    expect(await capture.json()).toMatchObject({ error: "tryon_disabled_preview" });
    const item = session.items[0];
    const swatch = await swatchPOST(post("/api/recipient/swatch", { itemId: item.itemId, swatchId: item.swatches[0].swatchId }, recipientToken));
    expect(swatch.status).toBe(409);
    expect(youcamCalls).toBe(0);

    expect((await heartsPOST(post("/api/recipient/hearts", { hearts: [{ itemId: item.itemId, swatchId: item.swatches[0].swatchId }] }, recipientToken))).status).toBe(200);
    expect((await donePOST(post("/api/recipient/done", {}, recipientToken))).status).toBe(200);

    const report = await reportPOST(post("/api/fit/report", { giverToken: c.giverToken }));
    const body = await report.json();
    expect(body.status).toBe("completed");
    expect(body.heartedShortlistIds).toHaveLength(1);
    expect(findGiverLeaks(body, { allowedImageUrls: (body.products ?? []).map((p: { image?: string }) => p.image).filter(Boolean) })).toEqual([]);
    expect(body.products.length).toBeGreaterThan(0);
    expect(youcamCalls).toBe(0);
  });

  it("a preview that is gone or not jewelry cannot back a Fit Request", async () => {
    const generic = await seed("generic");
    const r = await requestsPOST(post("/api/fit/requests", { storeId: `preview:${generic}`, mode: "help_me_choose", occasion: "birthday", budgetMax: 300, currency: "USD", shortlistIds: [] }));
    expect(r.status).toBe(422);
    const gone = await requestsPOST(post("/api/fit/requests", { storeId: `preview:${"Z".repeat(22)}`, mode: "help_me_choose", occasion: "birthday", budgetMax: 300, currency: "USD", shortlistIds: [] }));
    expect(gone.status).toBe(422);
  });
});

describe("gift links outlive the preview (ADR-055 fixes)", () => {
  const create = (key: string, extra: Record<string, unknown> = {}) =>
    requestsPOST(post("/api/fit/requests", { storeId: `preview:${key}`, mode: "help_me_choose", occasion: "birthday", budgetMax: 300, currency: "USD", shortlistIds: [], categories: ["earring"], ...extra }));

  it("creating a request extends the preview to the request's expiry, capped at 72 h after the preview", async () => {
    const key = await seed("jewelry");
    const before = (await repo.get(key))!;
    const res = await create(key);
    const c = (await res.json()) as CreateFitRequestResponse;
    const after = (await repo.get(key))!;
    const cap = before.createdAt.getTime() + 72 * 3_600_000;
    expect(after.expiresAt.getTime()).toBe(Math.min(new Date(c.expiresAt).getTime(), cap));
    expect(after.expiresAt.getTime()).toBeGreaterThan(before.expiresAt.getTime());
  });

  it("the create response names the giver's own pieces (never decoys) with merchant images", async () => {
    const key = await seed("jewelry");
    const view = (await (await import("@/lib/widget/preview")).loadPreviewStore(key))!;
    const pick = view.skus[0].id;
    const res = await create(key, { mode: "i_have_ideas", shortlistIds: [pick], categories: undefined });
    expect(res.status).toBe(201);
    const c = (await res.json()) as CreateFitRequestResponse;
    expect(c.products).toEqual([expect.objectContaining({ catalogId: pick, title: "Aria Gold Hoops", url: "https://lumen-jewelry.example/products/1001" })]);
    expect(c.products![0].image).toMatch(/^https:\/\/giftfit\.example\/catalog\//);
  });

  it("after the preview is deleted: the cached report still names the pieces; the recipient sees an expired preview; nothing 500s", async () => {
    const key = await seed("jewelry");
    const c = (await (await create(key)).json()) as CreateFitRequestResponse;
    const token = c.recipientPath.split("/").pop()!;
    const s = (await (await sessionPOST(post("/api/recipient/session", {}, token))).json()) as RecipientSessionResponse;
    await consentPOST(post("/api/recipient/consent", { accepted: true }, token));
    await heartsPOST(post("/api/recipient/hearts", { hearts: [{ itemId: s.items[0].itemId, swatchId: s.items[0].swatches[0].swatchId }] }, token));
    await donePOST(post("/api/recipient/done", {}, token));
    const first = await (await reportPOST(post("/api/fit/report", { giverToken: c.giverToken }))).json();
    expect(first.status).toBe("completed");

    await repo.delete(key);
    const res = await reportPOST(post("/api/fit/report", { giverToken: c.giverToken }));
    expect(res.status).toBe(200);
    const report = await res.json();
    expect(report).toMatchObject({ status: "completed", previewExpired: true });
    expect(report.results.length).toBeGreaterThan(0);
    const named = new Set(report.products.map((p: { catalogId: string }) => p.catalogId));
    for (const r of report.results) expect(named.has(r.skuId)).toBe(true);
    expect(report.products.every((p: { title: string; url: string; image?: string }) => p.title && p.url.startsWith("https://lumen-jewelry.example/") && (!p.image || p.image.startsWith("https://giftfit.example/catalog/")))).toBe(true);
    // Only the merchant images it names are allowed through the guard.
    const { findGiverLeaks } = await import("@/lib/privacy/giver-guard");
    expect(findGiverLeaks(report, { allowedImageUrls: report.products.map((p: { image?: string }) => p.image).filter(Boolean) })).toEqual([]);

    // A second request whose recipient never finished: no report possible, a clear state instead.
    const key2 = await seed("jewelry");
    const c2 = (await (await create(key2)).json()) as CreateFitRequestResponse;
    const token2 = c2.recipientPath.split("/").pop()!;
    await repo.delete(key2);
    const s2 = await sessionPOST(post("/api/recipient/session", {}, token2));
    expect(s2.status).toBe(200);
    expect(await s2.json()).toMatchObject({ previewExpired: true, items: [] });
    expect((await consentPOST(post("/api/recipient/consent", { accepted: true }, token2))).status).toBe(200);
    expect((await heartsPOST(post("/api/recipient/hearts", { hearts: [{ itemId: "x", swatchId: "y" }] }, token2))).status).toBe(400);
    expect((await donePOST(post("/api/recipient/done", {}, token2))).status).toBe(200);
    const r2 = await reportPOST(post("/api/fit/report", { giverToken: c2.giverToken }));
    expect(r2.status).toBe(200);
    expect(await r2.json()).toMatchObject({ status: "completed", previewExpired: true });
    expect(youcamCalls).toBe(0);
  });
});

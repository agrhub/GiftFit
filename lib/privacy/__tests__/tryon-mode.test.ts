/**
 * Who gets a try-on (A16) through the real route modules, at 0 units: YouCam is the mock client (fixtures) or a
 * real-mode client on the in-memory FakeYoucamApi. Covers the public 0-unit flows, the owner recording switch,
 * its mock rehearsal, and a store-URL preview gift that mixes tried-on and hearts-only pieces end to end
 * (giver → link → recipient → hearts → done → giver Fit Report).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as reportPOST } from "@/app/api/fit/report/route";
import { POST as requestsPOST } from "@/app/api/fit/requests/route";
import { POST as capturePOST } from "@/app/api/recipient/capture/route";
import { POST as consentPOST } from "@/app/api/recipient/consent/route";
import { POST as donePOST } from "@/app/api/recipient/done/route";
import { POST as heartsPOST } from "@/app/api/recipient/hearts/route";
import { POST as sessionPOST } from "@/app/api/recipient/session/route";
import { POST as swatchPOST } from "@/app/api/recipient/swatch/route";
import type { CaptureResponse, CreateFitRequestResponse, GiverReportStatus, RecipientSessionResponse } from "@/lib/contracts/api";
import { resetFitDeps } from "@/lib/fit/deps";
import { NO_TRYON_WORDS } from "@/lib/fit/explain";
import { defaultPreviewRepo, type MemoryPreviewRepo } from "@/lib/preview/repo";
import { findGiverLeaks } from "@/lib/privacy/giver-guard";
import { setRateLimitOverride } from "@/lib/privacy/rate-limit";
import { setPrivacyDeps } from "@/lib/privacy/runtime";
import { MemoryAuditSink } from "@/lib/youcam/audit";
import { MemoryResultCache } from "@/lib/youcam/cache";
import { createYoucamClient, YoucamClient } from "@/lib/youcam/client";
import { RECORDING_COOKIE, recordingCookieValue } from "@/lib/youcam/recording";
import { FakeYoucamApi } from "@/lib/youcam/__tests__/fake-api";
import { loadPreviewStore, PreviewAwareCatalog } from "@/lib/widget/preview";
import { fixturePreview } from "@/lib/widget/preview-fixtures";
import { youcamCapturePorts } from "../capture";
import { resetPrivacyState } from "../global-state";
import { baseTryOnMode } from "../tryon-mode";
import { makeStack, seedAurumRequest, type TestStack } from "./helpers";

const TOKEN = "owner-recording-token-0123456789-abcdefghij";
const BASE = "https://giftfit.example";
const repo = defaultPreviewRepo() as MemoryPreviewRepo;
let stack: TestStack;
const fetchImg = vi.fn(async () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]), { headers: { "content-type": "image/png" } }));

function mockPorts() {
  const client = createYoucamClient({ config: { mock: true, allowPaid: false }, cache: new MemoryResultCache(), audit: new MemoryAuditSink(), limiter: null, state: "isolated" });
  return (baseUrl: string) => youcamCapturePorts(client, { baseUrl, fetch: fetchImg as unknown as typeof fetch });
}

beforeEach(() => {
  resetPrivacyState();
  setRateLimitOverride(true);
  stack = makeStack();
  stack.clock.now = new Date();
  stack.deps.catalog = new PreviewAwareCatalog(stack.deps.catalog);
  stack.deps.capturePorts = mockPorts();
  setPrivacyDeps(stack.deps);
  resetFitDeps();
});
afterEach(() => {
  setPrivacyDeps(undefined);
  resetFitDeps();
  resetPrivacyState();
  repo.records.clear();
  vi.unstubAllEnvs();
});

const ownerCookie = () => `${RECORDING_COOKIE}=${recordingCookieValue(TOKEN)}`;
const post = (url: string, body: unknown, opts: { bearer?: string; cookie?: string } = {}) =>
  new Request(`${BASE}${url}`, {
    method: "POST",
    headers: {
      ...(body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...(opts.bearer ? { Authorization: `Bearer ${opts.bearer}` } : {}),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200) + 1}`,
    },
    body: body instanceof FormData ? body : JSON.stringify(body),
  });
const selfie = () => {
  const f = new FormData();
  f.append("selfie", new Blob([new Uint8Array([0xff, 0xd8, 0xff, Math.floor(Math.random() * 255)])], { type: "image/jpeg" }), "s.jpg");
  return f;
};
const session = async (token: string, cookie?: string) => (await (await sessionPOST(post("/api/recipient/session", {}, { bearer: token, cookie }))).json()) as RecipientSessionResponse;
const consent = (token: string, cookie?: string) => consentPOST(post("/api/recipient/consent", { accepted: true }, { bearer: token, cookie }));
const capture = (token: string, cookie?: string) => capturePOST(post("/api/recipient/capture", selfie(), { bearer: token, cookie }));

describe("baseTryOnMode: the switch table", () => {
  const rec = { YOUCAM_RECORDING: "on", GIFTFIT_RECORDING_TOKEN: TOKEN };
  it.each([
    ["production, switch off", "real", {}, false, "off"],
    ["production, switch off, owner cookie", "real", {}, true, "off"],
    ["production, switch on, public", "real", rec, false, "off"],
    ["production, switch on, owner, paid-ready", "real", rec, true, "live"],
    ["mock, switch off (dev/CI)", "mock", {}, false, "mock"],
    ["mock rehearsal, public", "mock", rec, false, "off"],
    ["mock rehearsal, owner", "mock", rec, true, "live"],
  ] as const)("%s → %s", (_n, youcamMode, env, owner, want) => {
    expect(baseTryOnMode({ youcamMode, owner, env, paidReady: youcamMode === "real" && owner })).toBe(want);
  });
  it("production owner without a paid-ready deployment gets no try-on (fail closed)", () => {
    expect(baseTryOnMode({ youcamMode: "real", owner: true, env: rec, paidReady: false })).toBe("off");
  });
});

describe("public site (YOUCAM_MOCK=0, recording off): 0 units", () => {
  it("demo store: hearts-only with the demo-mode note; capture and swatch refused before any YouCam call", async () => {
    stack.deps.youcamMode = () => "real";
    stack.deps.capturePorts = () => {
      throw new Error("YouCam must not be reached");
    };
    const { recipientToken } = await seedAurumRequest(stack);
    const s = await session(recipientToken);
    expect(s).toMatchObject({ tryOn: false, tryOnNote: "demo_mode" });
    expect(s.preview).toBeUndefined();
    await consent(recipientToken);
    const res = await capture(recipientToken);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "tryon_off" });
    const item = s.items[0];
    expect((await swatchPOST(post("/api/recipient/swatch", { itemId: item.itemId, swatchId: item.swatches[0].swatchId }, { bearer: recipientToken }))).status).toBe(409);
  });
});

describe("recording switch on, no owner credential: the YouCam client's paid methods are never invoked", () => {
  it("public recipient on a real-mode client (fake API): 409, no method call, no request to YouCam", async () => {
    vi.stubEnv("YOUCAM_RECORDING", "on");
    vi.stubEnv("GIFTFIT_RECORDING_TOKEN", TOKEN);
    const api = new FakeYoucamApi();
    const client = new YoucamClient({ requirePaidGrant: true, config: { mock: false, allowPaid: true, apiKey: "fake-key", baseUrl: "https://api.test", maxPolls: 2, pollIntervalMs: 1 }, fetch: api.fetch, sleep: async () => {}, audit: new MemoryAuditSink(), cache: null, limiter: null, dailyCounter: null, state: "isolated" });
    const spies = [vi.spyOn(client, "facialColorTones"), vi.spyOn(client, "faceAttributes"), vi.spyOn(client, "jewelryVto"), vi.spyOn(client, "run")];
    stack.deps.capturePorts = (baseUrl, opts) => youcamCapturePorts(client, { baseUrl, paidGrant: opts?.paidGrant, fetch: fetchImg as unknown as typeof fetch });
    stack.deps.youcamMode = () => "real";
    stack.deps.youcamPaidReady = () => true;
    const { recipientToken } = await seedAurumRequest(stack);
    expect(await session(recipientToken)).toMatchObject({ tryOn: false, tryOnNote: "demo_mode" });
    await consent(recipientToken);
    expect((await capture(recipientToken)).status).toBe(409);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    expect(api.calls).toEqual([]);

    // The owner's cookie on a deployment that is NOT paid-ready (no durable store, no paid flag in env): the route
    // reaches the client, but no grant can be minted, so the client refuses every paid task (fail closed).
    const res = await capture(recipientToken, ownerCookie());
    expect(res.status).toBe(422);
    expect(api.callsTo("POST", /\/task\//)).toEqual([]);
  });
});

describe("store-URL preview with eligible and ineligible pieces (mock YouCam, 0 units)", () => {
  async function previewGift(cookie?: string) {
    const f = fixturePreview("jewelry", { imageBase: BASE });
    await repo.create(f.record);
    const view = (await loadPreviewStore(f.record.key))!;
    const byTitle = (t: string) => view.skus.find((s) => s.title === t)!;
    const tried = byTitle("Aria Gold Hoops");
    const untried = byTitle("Tide Bar Earrings"); // its photo is a model shot
    expect(tried.attributes.tryon_eligible).toBe(true);
    expect(untried.attributes.tryon_eligible).toBe(false);
    const res = await requestsPOST(post("/api/fit/requests", { storeId: `preview:${f.record.key}`, mode: "i_have_ideas", occasion: "birthday", budgetMax: 300, currency: "USD", shortlistIds: [tried.id, untried.id] }, { cookie }));
    expect(res.status).toBe(201);
    const c = (await res.json()) as CreateFitRequestResponse;
    return { c, tried, untried, token: c.recipientPath.split("/").pop()! };
  }

  it("giver → link → recipient: mock try-on on eligible pieces, hearts-only on the others → done → mixed Fit Report", async () => {
    const { c, tried, untried, token } = await previewGift();
    expect(c.tryOn).toBeUndefined();
    expect(c.tryOnPartial).toBe(true);

    const s = await session(token);
    expect(s.tryOn).toBeUndefined();
    expect(s.preview).toBe(true);
    const untriedItem = s.items.find((i) => i.title === "Tide Bar Earrings")!;
    const triedItem = s.items.find((i) => i.title === "Aria Gold Hoops")!;
    expect(untriedItem.tryOn).toBe(false);
    expect(triedItem.tryOn).toBeUndefined();

    await consent(token);
    const cap = await capture(token);
    expect(cap.status).toBe(200);
    const body = (await cap.json()) as CaptureResponse;
    expect(body.tryons.find((t) => t.itemId === untriedItem.itemId)).toMatchObject({ status: "skipped_not_eligible" });
    expect(body.tryons.find((t) => t.itemId === triedItem.itemId)).toMatchObject({ status: "ready" });
    for (const t of body.tryons) if (s.items.find((i) => i.itemId === t.itemId)?.tryOn === false) expect(t.status).toBe("skipped_not_eligible");
    // A metal swatch on a never-tried piece is never rendered.
    if (untriedItem.swatches.length > 1) {
      const sw = await swatchPOST(post("/api/recipient/swatch", { itemId: untriedItem.itemId, swatchId: untriedItem.swatches[1].swatchId }, { bearer: token }));
      expect(await sw.json()).toMatchObject({ status: "failed", failureReason: "not_eligible" });
    }

    expect((await heartsPOST(post("/api/recipient/hearts", { hearts: [triedItem, untriedItem].map((i) => ({ itemId: i.itemId, swatchId: i.swatches[0].swatchId })) }, { bearer: token }))).status).toBe(200);
    expect((await donePOST(post("/api/recipient/done", {}, { bearer: token }))).status).toBe(200);
    // Privacy unchanged: every recipient photo and render is gone at Done.
    expect(stack.photos.keys()).toEqual([]);

    const report = (await (await reportPOST(post("/api/fit/report", { giverToken: c.giverToken }))).json()) as GiverReportStatus;
    expect(report.status).toBe("completed");
    expect(report.tryOn).toBeUndefined(); // something was tried on
    const r1 = report.results!.find((r) => r.skuId === tried.id)!;
    const r2 = report.results!.find((r) => r.skuId === untried.id)!;
    expect(r1.tryOn).toBeUndefined();
    expect(Object.keys(r1.breakdown).sort()).toEqual(["budgetOccasion", "hearts", "metal", "style"]);
    expect(r2.tryOn).toBe(false);
    expect(Object.keys(r2.breakdown).sort()).toEqual(["budgetOccasion", "hearts"]);
    expect(r2.breakdown.hearts).toBe(80); // hearted, FIT_WEIGHTS_NO_TRYON
    for (const t of [...r2.reasons, r2.caution ?? ""]) expect(t, t).not.toMatch(NO_TRYON_WORDS);
    expect(findGiverLeaks(report, { allowedImageUrls: (report.products ?? []).flatMap((p) => (p.image ? [p.image] : [])) })).toEqual([]);
  });

  it("mock rehearsal (YOUCAM_RECORDING=on): the public gets hearts-only, the owner's browser gets the try-on", async () => {
    vi.stubEnv("YOUCAM_RECORDING", "on");
    vi.stubEnv("GIFTFIT_RECORDING_TOKEN", TOKEN);
    const pub = await previewGift();
    expect(pub.c.tryOn).toBe(false);
    expect(await session(pub.token)).toMatchObject({ tryOn: false, tryOnNote: "preview_off", preview: true });
    await consent(pub.token);
    const refused = await capture(pub.token);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "tryon_disabled_preview" });

    const own = await previewGift(ownerCookie());
    expect(own.c.tryOn).toBeUndefined();
    expect(own.c.tryOnPartial).toBe(true);
    const s = await session(own.token, ownerCookie());
    expect(s.tryOn).toBeUndefined();
    await consent(own.token, ownerCookie());
    const ok = await capture(own.token, ownerCookie());
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as CaptureResponse).tryons.some((t) => t.status === "ready")).toBe(true);
  });

  it("a preview whose photos are all unusable is hearts-only with the no_eligible note", async () => {
    const f = fixturePreview("jewelry", { imageBase: BASE });
    f.record.products = f.record.products.map((p) => ({ ...p, tryOnEligible: false, tryOnReason: "worn_or_lifestyle" as const }));
    await repo.create(f.record);
    const res = await requestsPOST(post("/api/fit/requests", { storeId: `preview:${f.record.key}`, mode: "help_me_choose", occasion: "birthday", budgetMax: 300, currency: "USD", shortlistIds: [], categories: ["earring"] }));
    const c = (await res.json()) as CreateFitRequestResponse;
    expect(c.tryOn).toBe(false);
    const token = c.recipientPath.split("/").pop()!;
    expect(await session(token)).toMatchObject({ tryOn: false, tryOnNote: "no_eligible" });
  });
});

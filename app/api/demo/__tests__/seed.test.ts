/**
 * Seeded judge demo (MASTER_PLAN §8, ADR-030/037): POST /api/demo/seed and the recipient flow on it.
 * No YouCam call anywhere (the capture ports throw if touched), 0 units.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CaptureResponse, DemoSeedResponse, RecipientSessionResponse, SwatchResponse } from "@/server/contracts/api";
import { POST as reportPOST } from "@/app/api/fit/report/route";
import { POST as captureRecipientPOST, GET as captureGET } from "@/app/api/recipient/capture/route";
import { POST as deletePhotoPOST } from "@/app/api/recipient/delete-photo/route";
import { POST as deletePOST } from "@/app/api/recipient/delete/route";
import { POST as donePOST } from "@/app/api/recipient/done/route";
import { POST as heartsPOST } from "@/app/api/recipient/hearts/route";
import { POST as sessionPOST } from "@/app/api/recipient/session/route";
import { POST as swatchPOST } from "@/app/api/recipient/swatch/route";
import { GET as tryonGET } from "@/app/api/recipient/tryon/[id]/route";
import { readRealFacts } from "@/server/metrics/real";
import { MemoryPurchaseLog } from "@/server/metrics/purchases";
import { configureFit, resetFitDeps } from "@/server/fit/deps";
import { makeStack, seedAurumRequest, type TestStack } from "@/server/privacy/__tests__/helpers";
import type { CapturePorts } from "@/server/privacy/capture";
import { demoRoot } from "@/server/privacy/demo";
import { findGiverLeaks } from "@/server/privacy/giver-guard";
import { resetPrivacyState } from "@/server/privacy/global-state";
import { setRateLimitOverride } from "@/server/privacy/rate-limit";
import { setPrivacyDeps } from "@/server/privacy/runtime";
import { RECIPIENT_COOKIE } from "@/server/privacy/session";
import { POST as seedPOST } from "../seed/route";

const BASE = "http://localhost:3000";
const AURUM_STORE = "f8b2aec0-f78f-5107-bb6f-4be30806c501";
let stack: TestStack;
let youcamCalls: number;

/** Any YouCam-facing call fails the test. */
function forbiddenPorts(): CapturePorts {
  const boom = async (): Promise<never> => {
    youcamCalls++;
    throw new Error("YouCam must not be called in the seeded demo");
  };
  return { analyze: boom, render: boom, fetchImage: boom };
}

function fixtureDigest(): string {
  const h = createHash("sha256");
  const walk = (dir: string) => {
    for (const name of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, name.name);
      if (name.isDirectory()) walk(p);
      else h.update(name.name).update(readFileSync(p));
    }
  };
  walk(demoRoot());
  return h.digest("hex");
}

beforeEach(() => {
  resetPrivacyState();
  stack = makeStack();
  youcamCalls = 0;
  stack.deps.capturePorts = () => forbiddenPorts();
  setPrivacyDeps(stack.deps);
  configureFit({ now: () => new Date(stack.clock.now) });
});
afterEach(() => {
  resetFitDeps();
  setPrivacyDeps(undefined);
  resetPrivacyState();
});

const seed = async (body?: unknown, ip = "203.0.113.7") => {
  const res = await seedPOST(new Request(`${BASE}/api/demo/seed`, { method: "POST", headers: { "x-forwarded-for": `198.18.0.99, ${ip}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
  return { status: res.status, headers: res.headers, body: (await res.json()) as DemoSeedResponse & { error?: string } };
};
const tokenOf = (p: string) => p.split("/").pop()!;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const post = (p: string, t: string, body?: unknown) =>
  new Request(`${BASE}${p}`, { method: "POST", headers: { ...auth(t), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const idOf = (url: string) => url.split("/").pop()!.split("?")[0];
const fetchImage = async (t: string, url: string) =>
  tryonGET(new Request(`${BASE}${url}`, { headers: { cookie: `${RECIPIENT_COOKIE}=${t}` } }), { params: Promise.resolve({ id: idOf(url) }) });

describe("POST /api/demo/seed", () => {
  it("creates a full, ready-for-hearts request for the hero: 6 items with fixture try-ons, demo flag, no YouCam call", async () => {
    const before = fixtureDigest();
    const r = await seed();
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ subject: "showcase-latina-medium-warm", label: "AI-generated model" });
    expect(r.body.recipientPath).toMatch(/^\/r\/[A-Za-z0-9_-]{43}$/);
    expect(r.body.giverReportPath).toMatch(/^\/g\/[A-Za-z0-9_-]{43}$/);
    expect(findGiverLeaks(r.body)).toEqual([]);
    const t = tokenOf(r.body.recipientPath);

    const s = (await (await sessionPOST(post("/api/recipient/session", t))).json()) as RecipientSessionResponse;
    expect(s.demo).toBe(true);
    expect(s.status).toBe("trying_on");
    expect(s.items).toHaveLength(6);
    expect(s.items.map((i) => i.title).sort()).toEqual(
      ["Halo Drop Earrings", "Reverie Pear Pendant", "Chime Bell Drop Earrings", "Starlit Bib Collar", "Cove Fringe Earrings", "Jubilee Pearl Chandeliers"].sort(),
    );

    const cap = (await (await captureGET(new Request(`${BASE}/api/recipient/capture`, { headers: auth(t) }))).json()) as CaptureResponse;
    expect(cap.demo).toBe(true);
    expect(cap.tryons).toHaveLength(6);
    for (const tr of cap.tryons) {
      expect(tr.status).toBe("ready");
      const img = await fetchImage(t, tr.imageUrl!);
      expect(img.status).toBe(200);
      expect(img.headers.get("content-type")).toBe("image/jpeg");
      expect(img.headers.get("x-giftfit-demo")).toBe("AI-generated model");
      expect(new Uint8Array(await img.arrayBuffer()).length).toBeGreaterThan(10_000);
    }
    expect(["warm", "neutral", "cool"]).toContain(cap.undertone.estimate);
    expect(cap.faceShapeLabel).toBe("Heart-shaped face shape (estimate)");
    // Profile holds estimates only (the hex stays in the fixture file).
    const req = await stack.repos.fitRequests.findByRecipientTokenHash(createHash("sha256").update(t).digest("hex"));
    expect(JSON.stringify(await stack.repos.profiles.get(req!.id))).not.toMatch(/#[0-9a-f]{6}/i);
    expect(stack.photos.keys()).toEqual([]); // fixtures are read, never copied into the PhotoStore
    expect(youcamCalls).toBe(0);
    expect(fixtureDigest()).toBe(before);
  });

  it("each call is a fresh request", async () => {
    const a = await seed();
    const b = await seed();
    expect(a.body.recipientPath).not.toBe(b.body.recipientPath);
    expect(stack.repos.demoRequests.size).toBe(2);
  });

  it("swatches: fixture metals 'render' from fixtures, others are demo_metal_unavailable; capture is refused; no YouCam call", async () => {
    const t = tokenOf((await seed()).body.recipientPath);
    const s = (await (await sessionPOST(post("/api/recipient/session", t))).json()) as RecipientSessionResponse;
    const halo = s.items.find((i) => i.title === "Halo Drop Earrings")!;
    const swatch = async (itemId: string, swatchId: string) => (await (await swatchPOST(post("/api/recipient/swatch", t, { itemId, swatchId }))).json()) as SwatchResponse;
    for (const w of halo.swatches.filter((x) => !x.isDefault)) {
      const r = await swatch(halo.itemId, w.swatchId);
      expect(r.status, w.metalLabel).toBe("ready"); // hero has Halo in all three metals
      expect((await fetchImage(t, r.imageUrl!)).status).toBe(200);
    }
    const chime = s.items.find((i) => i.title === "Chime Bell Drop Earrings")!;
    const other = chime.swatches.find((w) => !w.isDefault);
    if (other) expect(await swatch(chime.itemId, other.swatchId)).toMatchObject({ status: "failed", failureReason: "demo_metal_unavailable" });

    const form = new FormData();
    form.set("selfie", new File([new Uint8Array([0xff, 0xd8, 0xff, 1])], "s.jpg", { type: "image/jpeg" }));
    const cap = await captureRecipientPOST(new Request(`${BASE}/api/recipient/capture`, { method: "POST", headers: auth(t), body: form }));
    expect(cap.status).toBe(409);
    expect(await cap.json()).toEqual({ error: "demo_request" });
    expect(youcamCalls).toBe(0);
  });

  it("hearts → done → the giver report is completed with scores; giver leak scan clean", async () => {
    const r = await seed();
    const t = tokenOf(r.body.recipientPath);
    const s = (await (await sessionPOST(post("/api/recipient/session", t))).json()) as RecipientSessionResponse;
    const halo = s.items.find((i) => i.title === "Halo Drop Earrings")!;
    const reverie = s.items.find((i) => i.title === "Reverie Pear Pendant")!;
    await heartsPOST(post("/api/recipient/hearts", t, { hearts: [{ itemId: halo.itemId, swatchId: halo.swatches.find((w) => w.isDefault)!.swatchId }, { itemId: reverie.itemId, swatchId: reverie.swatches[0].swatchId }] }));
    expect((await donePOST(post("/api/recipient/done", t))).status).toBe(200);

    const res = await reportPOST(new Request(`${BASE}/api/fit/report`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ giverToken: tokenOf(r.body.giverReportPath) }) }));
    expect(res.status).toBe(200);
    const report = (await res.json()) as { status: string; results: Array<{ score: number; metal?: string; price?: number }>; heartedShortlistIds: string[] };
    expect(report.status).toBe("completed");
    expect(report.results).toHaveLength(3);
    for (const x of report.results) expect(x.score).toBeGreaterThan(0);
    expect(report.heartedShortlistIds).toHaveLength(2);
    expect(findGiverLeaks(report)).toEqual([]);
    expect(JSON.stringify(report)).not.toMatch(/fixture:|\/api\/recipient|showcase-|\.jpg/);
    // Done revokes this request's fixture URLs.
    const cap = (await (await captureGET(new Request(`${BASE}/api/recipient/capture`, { headers: auth(t) }))).json()) as CaptureResponse;
    expect(cap.tryons.some((x) => x.status === "ready")).toBe(false);
    expect(youcamCalls).toBe(0);
  });

  it("delete-photo and delete-everything revoke this request's images without touching the committed files", async () => {
    const before = fixtureDigest();
    const t = tokenOf((await seed()).body.recipientPath);
    const cap = (await (await captureGET(new Request(`${BASE}/api/recipient/capture`, { headers: auth(t) }))).json()) as CaptureResponse;
    const urls = cap.tryons.map((x) => x.imageUrl!);
    expect((await deletePhotoPOST(post("/api/recipient/delete-photo", t))).status).toBe(200);
    for (const u of urls) expect((await fetchImage(t, u)).status).toBe(404);
    const after = (await (await captureGET(new Request(`${BASE}/api/recipient/capture`, { headers: auth(t) }))).json()) as CaptureResponse;
    expect(after.tryons.every((x) => x.status === "failed" && x.failureReason === "photo_deleted" && !("imageUrl" in x))).toBe(true);
    const del = await (await deletePOST(post("/api/recipient/delete", t))).json();
    expect(del).toMatchObject({ ok: true, verified: true });
    expect(stack.deletedTasks).toEqual([]); // nothing at YouCam to delete
    expect(fixtureDigest()).toBe(before);

    // A second demo is unaffected by the first one's deletion.
    const t2 = tokenOf((await seed()).body.recipientPath);
    const cap2 = (await (await captureGET(new Request(`${BASE}/api/recipient/capture`, { headers: auth(t2) }))).json()) as CaptureResponse;
    expect((await fetchImage(t2, cap2.tryons[0].imageUrl!)).status).toBe(200);
  });

  it("the man gets a men's carousel: picks and gender-matched decoys all render from fixtures (ADR-038)", async () => {
    const r = await seed({ subject: "showcase-man-lightmed-neutral" });
    expect(r.status).toBe(201);
    const t = tokenOf(r.body.recipientPath);
    const s = (await (await sessionPOST(post("/api/recipient/session", t))).json()) as RecipientSessionResponse;
    expect(s.items.map((i) => i.title)).toEqual(expect.arrayContaining(["Ashford Dress Watch 40", "Strand Box Chain", "Everyday Curb Chain"]));
    const cap = (await (await captureGET(new Request(`${BASE}/api/recipient/capture`, { headers: auth(t) }))).json()) as CaptureResponse;
    const watch = s.items.find((i) => i.title === "Ashford Dress Watch 40")!;
    expect(cap.tryons.find((x) => x.itemId === watch.itemId)?.status).toBe("ready");
    // All six cards render (decoys too), so picks can't be spotted by "has a try-on" (ADR-038).
    expect(s.items).toHaveLength(6);
    expect(cap.tryons.filter((x) => x.status === "ready")).toHaveLength(6);
    // Decoys match the picks' presentation: nothing feminine in a men's carousel.
    expect(s.items.map((i) => i.title)).toEqual(expect.arrayContaining(["Paddock Chronograph 42", "Monarch Onyx Signet Ring", "Anchor Chunky Curb Choker"]));
    expect(youcamCalls).toBe(0);
  });

  it("validates the subject and the body", async () => {
    expect((await seed({ subject: "someone" })).body).toEqual({ error: "unknown_subject" });
    const bad = await seedPOST(new Request(`${BASE}/api/demo/seed`, { method: "POST", body: "{" }));
    expect(bad.status).toBe(400);
  });

  it("rate-limits per trusted client IP: 10 per hour (the spoofable left-most XFF entry is ignored)", async () => {
    setRateLimitOverride(true);
    for (let i = 0; i < 10; i++) expect((await seed(undefined, "198.51.100.1")).status).toBe(201);
    const over = await seed(undefined, "198.51.100.1");
    expect(over.status).toBe(429);
    expect(over.body).toEqual({ error: "rate_limited" });
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await seed(undefined, "198.51.100.2")).status).toBe(201);
    stack.clock.advance(60 * 60 * 1000 + 1);
    expect((await seed(undefined, "198.51.100.1")).status).toBe(201);
  });

  it("demo requests never count as real in A6's metrics", async () => {
    const real = await seedAurumRequest(stack);
    await seed();
    await seed();
    const facts = await readRealFacts(stack.repos, new MemoryPurchaseLog(), { storeId: AURUM_STORE, isDefaultStore: true });
    expect(facts).toHaveLength(1);
    expect(facts[0].shortlistIds).toEqual(real.request.shortlistIds);
    // ...while every demo stays reachable by its own tokens.
    expect(stack.repos.demoRequests.size).toBe(2);
  });
});


/**
 * Per-IP limits on paid recipient calls and Fit Request creation (A8 "Requirement for A5"), plus
 * A1's daily unit cap mapped to 503. YouCam is faked with counting ports; 0 units.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecipientSessionResponse, SwatchResponse } from "@/lib/contracts/api";
import { POST as requestsPOST } from "@/app/api/fit/requests/route";
import { POST as seedPOST } from "@/app/api/demo/seed/route";
import { makeStack, seedAurumRequest, type TestStack } from "@/lib/privacy/__tests__/helpers";
import { CaptureDailyCapError, youcamCapturePorts, type CapturePorts } from "@/lib/privacy/capture";
import { resetPrivacyState } from "@/lib/privacy/global-state";
import { rateKeysForTests, setRateLimitOverride } from "@/lib/privacy/rate-limit";
import { setPrivacyDeps } from "@/lib/privacy/runtime";
import { newFitRequestTokens } from "@/lib/privacy/tokens";
import { MemoryAuditSink } from "@/lib/youcam/audit";
import { MemoryResultCache } from "@/lib/youcam/cache";
import { createYoucamClient, type YoucamClient } from "@/lib/youcam/client";
import { DailyCapError } from "@/lib/youcam/errors";
import { POST as capturePOST } from "../capture/route";
import { POST as consentPOST } from "../consent/route";
import { POST as sessionPOST } from "../session/route";
import { POST as swatchPOST } from "../swatch/route";

const BASE = "http://localhost:3000";
const REAL_IP = "203.0.113.50";
let stack: TestStack;
let calls: { analyze: number; render: number; preflight: number };
let dailyCap = false;

function ports(): (baseUrl: string) => CapturePorts {
  const client = createYoucamClient({ config: { mock: true, allowPaid: false }, cache: new MemoryResultCache(), audit: new MemoryAuditSink(), limiter: null });
  const fetchImg = vi.fn(async () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]), { headers: { "content-type": "image/png" } }));
  return (baseUrl) => {
    const base = youcamCapturePorts(client, { baseUrl, fetch: fetchImg as unknown as typeof fetch });
    return {
      ...base,
      analyze: async (img) => {
        calls.analyze++;
        return base.analyze(img);
      },
      render: async (...a) => {
        calls.render++;
        return base.render(...a);
      },
      preflight: async () => {
        calls.preflight++;
        return dailyCap ? "daily_cap" : "ok";
      },
    };
  };
}

beforeEach(() => {
  resetPrivacyState();
  setRateLimitOverride(true);
  stack = makeStack();
  stack.deps.capturePorts = ports();
  stack.deps.youcamMode = () => "real"; // calls "can reach YouCam" (the ports are fakes)
  calls = { analyze: 0, render: 0, preflight: 0 };
  dailyCap = false;
  setPrivacyDeps(stack.deps);
});
afterEach(() => {
  setPrivacyDeps(undefined);
  resetPrivacyState();
});

/** Cloud Run direct: the GFE appends the real client; anything left of it is client-controlled. */
const xff = (realIp: string, spoof = "") => ({ "x-forwarded-for": spoof ? `${spoof}, ${realIp}` : realIp });
const post = (p: string, token: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`${BASE}${p}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, ...headers, ...(body !== undefined && !(body instanceof FormData) ? { "content-type": "application/json" } : {}) },
    body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
  });
const selfie = () => {
  const f = new FormData();
  f.set("selfie", new File([new Uint8Array([0xff, 0xd8, 0xff, Math.floor(Math.random() * 255)])], "s.jpg", { type: "image/jpeg" }));
  return f;
};

async function readyRequest() {
  const { recipientToken, request } = await seedAurumRequest(stack);
  await sessionPOST(post("/api/recipient/session", recipientToken));
  await consentPOST(post("/api/recipient/consent", recipientToken, { accepted: true }));
  return { token: recipientToken, request };
}
const capture = (token: string, headers: Record<string, string>) => capturePOST(post("/api/recipient/capture", token, selfie(), headers));

describe("POST /api/recipient/capture per-IP limit (2/h, 4/24h)", () => {
  it("allows 2 per hour, then 429 with Retry-After and no YouCam call, even with a spoofed left-most XFF", async () => {
    for (let i = 0; i < 2; i++) expect((await capture((await readyRequest()).token, xff(REAL_IP))).status).toBe(200);
    const before = { ...calls };
    const third = await readyRequest();
    // The exact A8 scenario: a fresh forged left-most entry on every try.
    for (const spoof of ["1.2.3.4", "5.6.7.8", "9.9.9.9, 8.8.8.8"]) {
      const res = await capture(third.token, xff(REAL_IP, spoof));
      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ error: "rate_limited" });
      expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(3000);
    }
    expect(calls.analyze).toBe(before.analyze);
    expect(calls.render).toBe(before.render);
    expect(stack.photos.keys().filter((k) => k.startsWith(`recipient/${third.request.id}/`))).toEqual([]);
    // Another network is unaffected.
    expect((await capture(third.token, xff("198.51.100.77"))).status).toBe(200);
  });

  it("4 per 24 h: after two hours of 2 each, the fifth waits for the day window", async () => {
    for (let i = 0; i < 2; i++) expect((await capture((await readyRequest()).token, xff(REAL_IP))).status).toBe(200);
    stack.clock.advance(60 * 60 * 1000);
    for (let i = 0; i < 2; i++) expect((await capture((await readyRequest()).token, xff(REAL_IP))).status).toBe(200);
    stack.clock.advance(60 * 60 * 1000);
    const res = await capture((await readyRequest()).token, xff(REAL_IP));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(20 * 3600);
  });

  it("refusals before YouCam (validation, consent, demo) don't count", async () => {
    const { recipientToken } = await seedAurumRequest(stack);
    await sessionPOST(post("/api/recipient/session", recipientToken));
    for (let i = 0; i < 3; i++) expect((await capture(recipientToken, xff(REAL_IP))).status).toBe(409); // no consent yet
    const demo = await seedPOST(new Request(`${BASE}/api/demo/seed`, { method: "POST", headers: xff(REAL_IP) }));
    const demoToken = ((await demo.json()) as { recipientPath: string }).recipientPath.split("/").pop()!;
    for (let i = 0; i < 3; i++) expect((await capture(demoToken, xff(REAL_IP))).status).toBe(409); // demo_request
    for (let i = 0; i < 2; i++) expect((await capture((await readyRequest()).token, xff(REAL_IP))).status).toBe(200);
  });

  it("mock mode is exempt", async () => {
    stack.deps.youcamMode = () => "mock";
    for (let i = 0; i < 5; i++) expect((await capture((await readyRequest()).token, xff(REAL_IP))).status).toBe(200);
  });

  it("keeps only salted hashes of the IP", async () => {
    await capture((await readyRequest()).token, xff(REAL_IP, "6.6.6.6"));
    expect(JSON.stringify(rateKeysForTests())).not.toMatch(/203\.0\.113\.50|6\.6\.6\.6/);
  });
});

describe("POST /api/recipient/swatch per-IP limit (8/h)", () => {
  /** Halo Drop + decoys with several metals under $400 (see variants.test.ts). */
  async function capturedVariantRequest(ip: string) {
    const t = newFitRequestTokens();
    await stack.repos.fitRequests.create({
      storeId: null,
      giverTokenHash: t.giverTokenHash,
      recipientTokenHash: t.recipientTokenHash,
      occasion: null,
      budgetMin: null,
      budgetMax: 400,
      currency: "USD",
      shortlistIds: ["dca42809-a2e1-5b50-8339-240170c69845", "96b9bb0c-8b22-597e-837e-d90ee529f9b6"],
      decoyIds: ["e5c65c24-744d-5861-9f52-4edd091329bb", "80de0232-f515-551d-bbd5-8d2af72ff2ff", "74066662-deab-5925-b51f-4f39e11da0e3", "2ab21844-dbf7-5d72-8edd-4a30ba1d9271"],
    });
    await sessionPOST(post("/api/recipient/session", t.recipientToken));
    await consentPOST(post("/api/recipient/consent", t.recipientToken, { accepted: true }));
    stack.deps.youcamMode = () => "mock"; // the captures themselves are not under test here
    expect((await capture(t.recipientToken, xff(ip))).status).toBe(200);
    stack.deps.youcamMode = () => "real";
    const s = (await (await sessionPOST(post("/api/recipient/session", t.recipientToken))).json()) as RecipientSessionResponse;
    return { token: t.recipientToken, extras: s.items.flatMap((i) => i.swatches.filter((w) => !w.isDefault).map((w) => ({ itemId: i.itemId, swatchId: w.swatchId }))) };
  }
  const swatch = async (token: string, e: { itemId: string; swatchId: string }, headers: Record<string, string>) => {
    const res = await swatchPOST(post("/api/recipient/swatch", token, e, headers));
    return { status: res.status, headers: res.headers, body: (await res.json()) as SwatchResponse & { error?: string } };
  };

  it("8 real renders per hour across requests; cached repeats don't count; the 9th is 429 without a call", async () => {
    const a = await capturedVariantRequest(REAL_IP);
    const b = await capturedVariantRequest(REAL_IP);
    for (const e of a.extras.slice(0, 4)) expect((await swatch(a.token, e, xff(REAL_IP))).body.status).toBe("ready");
    // Cached repeats: free, uncounted.
    for (let i = 0; i < 5; i++) expect((await swatch(a.token, a.extras[0], xff(REAL_IP, `1.1.1.${i}`))).body.status).toBe("ready");
    for (const e of b.extras.slice(0, 4)) expect((await swatch(b.token, e, xff(REAL_IP))).body.status).toBe("ready");
    const c = await capturedVariantRequest(REAL_IP);
    const renders = calls.render;
    const over = await swatch(c.token, c.extras[0], xff(REAL_IP, "7.7.7.7"));
    expect(over.status).toBe(429);
    expect(over.body).toEqual({ error: "rate_limited" });
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(calls.render).toBe(renders);
    // The per-request cap is still separate and still answers first when reached.
    expect((await swatch(a.token, a.extras[4], xff("198.51.100.8"))).body).toMatchObject({ status: "cap_reached" });
  });

  it("mock mode is exempt", async () => {
    const a = await capturedVariantRequest(REAL_IP);
    const b = await capturedVariantRequest(REAL_IP);
    const c = await capturedVariantRequest(REAL_IP);
    stack.deps.youcamMode = () => "mock";
    let ready = 0;
    for (const r of [a, b, c]) for (const e of r.extras.slice(0, 4)) if ((await swatch(r.token, e, xff(REAL_IP))).body.status === "ready") ready++;
    expect(ready).toBe(12);
  });
});

describe("POST /api/fit/requests per-IP limit (10/h)", () => {
  const create = (headers: Record<string, string>) =>
    requestsPOST(
      new Request(`${BASE}/api/fit/requests`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ occasion: "anniversary", budgetMax: 300, currency: "USD", shortlistIds: ["dca42809-a2e1-5b50-8339-240170c69845"] }),
      }),
    );

  it("10 per hour per trusted IP; spoofing the left-most entry does not help", async () => {
    for (let i = 0; i < 10; i++) expect((await create(xff(REAL_IP, `10.0.0.${i}`))).status).toBe(201);
    const over = await create(xff(REAL_IP, "4.4.4.4"));
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ error: "rate_limited" });
    expect(over.headers.get("retry-after")).toBeTruthy();
    expect((await create(xff("198.51.100.9"))).status).toBe(201);
  });
});

describe("A1's daily unit cap → 503 daily_cap_reached", () => {
  it("capture: refused before any call, Retry-After until the next UTC day, nothing stored, quota untouched", async () => {
    const { token, request } = await readyRequest();
    dailyCap = true;
    const res = await capture(token, xff(REAL_IP));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "daily_cap_reached" });
    const now = stack.deps.now();
    const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    expect(Number(res.headers.get("retry-after"))).toBe(Math.ceil((next - now.getTime()) / 1000));
    expect(calls.analyze + calls.render).toBe(0);
    expect(stack.photos.keys()).toEqual([]);
    expect(await stack.repos.countForRequest(request.id)).toMatchObject({ tryons: 0 });
    expect((await stack.repos.profiles.get(request.id))?.undertoneEstimate ?? null).toBeNull();
    expect(rateKeysForTests()).toEqual([]); // the cap answered before the per-IP limit was charged
    dailyCap = false;
    expect((await capture(token, xff(REAL_IP))).status).toBe(200);
  });

  it("swatch: 503 before any render", async () => {
    const t = newFitRequestTokens();
    await stack.repos.fitRequests.create({
      storeId: null,
      giverTokenHash: t.giverTokenHash,
      recipientTokenHash: t.recipientTokenHash,
      occasion: null,
      budgetMin: null,
      budgetMax: 400,
      currency: "USD",
      shortlistIds: ["dca42809-a2e1-5b50-8339-240170c69845"],
      decoyIds: ["e5c65c24-744d-5861-9f52-4edd091329bb", "80de0232-f515-551d-bbd5-8d2af72ff2ff"],
    });
    await sessionPOST(post("/api/recipient/session", t.recipientToken));
    await consentPOST(post("/api/recipient/consent", t.recipientToken, { accepted: true }));
    await capture(t.recipientToken, xff(REAL_IP));
    const s = (await (await sessionPOST(post("/api/recipient/session", t.recipientToken))).json()) as RecipientSessionResponse;
    const e = s.items.flatMap((i) => i.swatches.filter((w) => !w.isDefault).map((w) => ({ itemId: i.itemId, swatchId: w.swatchId })))[0];
    dailyCap = true;
    const renders = calls.render;
    const res = await swatchPOST(post("/api/recipient/swatch", t.recipientToken, e, xff(REAL_IP)));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "daily_cap_reached" });
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect(calls.render).toBe(renders);
  });

  it("a cap hit inside the analysis pair purges the half that ran (no orphan task or cache entry)", async () => {
    const purge = vi.fn(async () => ({ cacheKeysPurged: 1, tasks: [], ok: true }));
    const fake = {
      facialColorTones: async () => ({ feature: "skin-tone-analysis", taskId: "t-tones", cacheKey: "a".repeat(64), result: { color: { skin_color: "#9e7558" } }, unitsCharged: 20 }),
      faceAttributes: async () => {
        throw new DailyCapError("refused", "face-attr-analysis", 10, 150, 150);
      },
      purge,
    } as unknown as YoucamClient;
    await expect(youcamCapturePorts(fake).analyze({ bytes: new Uint8Array([1]), contentType: "image/jpeg" })).rejects.toBeInstanceOf(CaptureDailyCapError);
    expect(purge).toHaveBeenCalledWith({ cacheKeys: ["a".repeat(64)], taskIds: ["t-tones"] });
  });
});

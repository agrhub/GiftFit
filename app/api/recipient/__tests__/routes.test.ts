import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeStack, seedFullRequest, type SeededRequest, type TestStack } from "@/server/privacy/__tests__/helpers";
import { setPrivacyDeps } from "@/server/privacy/runtime";
import { RECIPIENT_COOKIE } from "@/server/privacy/session";
import { signTryOnUrl } from "@/server/privacy/signed-url";
import { FIT_REQUEST_TTL_MS, newToken } from "@/server/privacy/tokens";
import { POST as deletePOST } from "../delete/route";
import { GET as purgeGET } from "../purge-expired/route";
import { GET as tryonGET } from "../tryon/[id]/route";
import { GET as tryonsGET } from "../tryons/route";
import { GET as undertoneGET, POST as undertonePOST } from "../undertone/route";

const BASE = "http://localhost:3000";
let stack: TestStack;
let seeded: SeededRequest;

beforeEach(async () => {
  stack = makeStack();
  setPrivacyDeps(stack.deps);
  seeded = await seedFullRequest(stack);
});
afterEach(() => {
  setPrivacyDeps(undefined);
  vi.unstubAllEnvs();
});

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const cookie = (token: string) => ({ cookie: `other=1; ${RECIPIENT_COOKIE}=${token}` });
const req = (path: string, init: RequestInit = {}) => new Request(`${BASE}${path}`, init);
const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("recipient authentication (all recipient routes)", () => {
  const calls: Array<[string, (headers: Record<string, string>) => Promise<Response>]> = [
    ["delete", (h) => deletePOST(req("/api/recipient/delete", { method: "POST", headers: h }))],
    ["undertone GET", (h) => undertoneGET(req("/api/recipient/undertone", { headers: h }))],
    ["tryons", (h) => tryonsGET(req("/api/recipient/tryons", { headers: h }))],
  ];

  it.each(calls)("%s: 401 without a token, 404 for the giver's token or a random one", async (_n, call) => {
    expect((await call({})).status).toBe(401);
    expect((await call(bearer(seeded.giverToken))).status).toBe(404);
    expect((await call(bearer(newToken()))).status).toBe(404);
    expect((await call(bearer("not-a-token"))).status).toBe(404);
    expect((await call(bearer("two words"))).status).toBe(401);
    expect(await stack.repos.countForRequest(seeded.request.id)).toMatchObject({ recipient_profiles: 1 });
  });

  it("a link past 72 h answers 410 and its data is purged on first touch", async () => {
    stack.clock.advance(FIT_REQUEST_TTL_MS);
    const res = await undertoneGET(req("/api/recipient/undertone", { headers: bearer(seeded.recipientToken) }));
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: "link_expired", status: "expired" });
    expect(await stack.repos.countForRequest(seeded.request.id)).toEqual({ recipient_profiles: 0, tryons: 0, hearts: 0, metal_wishes: 0, fit_reports: 0 });
    expect((await stack.repos.fitRequests.findById(seeded.request.id))?.status).toBe("expired");
  });
});

describe("POST /api/recipient/delete", () => {
  it("deletes everything with one call and kills the link", async () => {
    const res = await deletePOST(req("/api/recipient/delete", { method: "POST", headers: bearer(seeded.recipientToken) }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, verified: true, deleted: { blobs: 3, youcamTasks: 4, cacheEntries: 4 } });
    expect(res.headers.get("set-cookie")).toMatch(new RegExp(`${RECIPIENT_COOKIE}=;.*Max-Age=0`));
    expect(await stack.repos.countForRequest(seeded.request.id)).toEqual({ recipient_profiles: 0, tryons: 0, hearts: 0, metal_wishes: 0, fit_reports: 0 });
    expect(await stack.photos.listForRequest(seeded.request.id)).toEqual([]);
    expect(stack.deletedTasks).toHaveLength(4);
    expect(stack.purgedCacheKeys).toHaveLength(4);
    // The link no longer opens anything; a second tap is harmless.
    expect((await undertoneGET(req("/api/recipient/undertone", { headers: bearer(seeded.recipientToken) }))).status).toBe(410);
    const again = await deletePOST(req("/api/recipient/delete", { method: "POST", headers: cookie(seeded.recipientToken) }));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, alreadyDeleted: true });
  });
});

describe("/api/recipient/undertone", () => {
  it("returns the estimate labelled as such, and lets the recipient override and clear it", async () => {
    const h = bearer(seeded.recipientToken);
    const get = await undertoneGET(req("/api/recipient/undertone", { headers: h }));
    expect(await get.json()).toEqual({ label: "estimate", estimate: "warm", confidence: 0.7, override: null, effective: "warm" });

    const set = await undertonePOST(req("/api/recipient/undertone", { method: "POST", headers: h, body: JSON.stringify({ undertone: "cool" }) }));
    expect(await set.json()).toMatchObject({ estimate: "warm", override: "cool", effective: "cool" });
    expect((await stack.repos.profiles.get(seeded.request.id))?.undertoneOverride).toBe("cool");

    const clear = await undertonePOST(req("/api/recipient/undertone", { method: "POST", headers: h, body: JSON.stringify({ undertone: null }) }));
    expect(await clear.json()).toMatchObject({ override: null, effective: "warm" });
  });

  it("validates input and refuses the giver", async () => {
    const h = bearer(seeded.recipientToken);
    expect((await undertonePOST(req("/api/recipient/undertone", { method: "POST", headers: h, body: "{" }))).status).toBe(400);
    expect((await undertonePOST(req("/api/recipient/undertone", { method: "POST", headers: h, body: JSON.stringify({ undertone: "olive" }) }))).status).toBe(400);
    const giver = await undertonePOST(req("/api/recipient/undertone", { method: "POST", headers: bearer(seeded.giverToken), body: JSON.stringify({ undertone: "cool" }) }));
    expect(giver.status).toBe(404);
    expect((await stack.repos.profiles.get(seeded.request.id))?.undertoneOverride).toBeNull();
  });
});

describe("try-on images", () => {
  it("lists renders (not analysis tasks) with signed URLs that load with the session cookie", async () => {
    const list = await tryonsGET(req("/api/recipient/tryons", { headers: bearer(seeded.recipientToken) }));
    const body = (await list.json()) as { tryOns: Array<{ itemId: string; imageUrl: string; imageUrlExpiresAt: number }> };
    const idOf = (url: string) => url.split("/").pop()!.split("?")[0];
    expect(body.tryOns.map((t) => idOf(t.imageUrl)).sort()).toEqual([...seeded.tryOnIds].sort());
    expect(body.tryOns.every((t) => /^[A-Za-z0-9_-]{16}$/.test(t.itemId))).toBe(true);
    // Opaque item ids only: no catalog ids, no storage refs, no hex.
    expect(JSON.stringify(body)).not.toMatch(/sku-a-|catalogId|store:|blob|#[0-9a-f]{6}/i);

    const t = body.tryOns[0];
    const img = await tryonGET(req(t.imageUrl, { headers: cookie(seeded.recipientToken) }), params(idOf(t.imageUrl)));
    expect(img.status).toBe(200);
    expect(img.headers.get("cache-control")).toMatch(/no-store/);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await img.arrayBuffer()).length).toBe(3);
  });

  it("refuses a URL without the session, with another session, tampered, expired, or for another request's try-on", async () => {
    const other = await seedFullRequest(stack, "z");
    const id = seeded.tryOnIds[0];
    const signed = signTryOnUrl({ tryOnId: id, sessionToken: seeded.recipientToken, secret: stack.deps.signingSecret, nowMs: stack.deps.now().getTime() });

    // Leaked URL alone (no cookie): refused.
    expect((await tryonGET(req(signed.url), params(id))).status).toBe(403);
    // The giver's token: refused.
    expect((await tryonGET(req(signed.url, { headers: cookie(seeded.giverToken) }), params(id))).status).toBe(404);
    // Another recipient's valid session: signature is bound to the first session.
    expect((await tryonGET(req(signed.url, { headers: cookie(other.recipientToken) }), params(id))).status).toBe(403);
    // Tampered signature / exp.
    const bad = signed.url.replace(/sig=(.)/, (_m, c: string) => `sig=${c === "A" ? "B" : "A"}`);
    expect((await tryonGET(req(bad, { headers: cookie(seeded.recipientToken) }), params(id))).status).toBe(403);
    const later = signed.url.replace(`exp=${signed.exp}`, `exp=${signed.exp + 60}`);
    expect((await tryonGET(req(later, { headers: cookie(seeded.recipientToken) }), params(id))).status).toBe(403);
    // A valid signature for a try-on of another request (minted with that request's own session).
    const foreign = signTryOnUrl({ tryOnId: other.tryOnIds[0], sessionToken: seeded.recipientToken, secret: stack.deps.signingSecret, nowMs: stack.deps.now().getTime() });
    expect((await tryonGET(req(foreign.url, { headers: cookie(seeded.recipientToken) }), params(other.tryOnIds[0]))).status).toBe(404);
    // Expired after 10 minutes.
    stack.clock.advance(10 * 60 * 1000 + 1000);
    expect((await tryonGET(req(signed.url, { headers: cookie(seeded.recipientToken) }), params(id))).status).toBe(403);
  });

  it("returns 404 once the render is gone (deleted or past its 1 h TTL)", async () => {
    const id = seeded.tryOnIds[0];
    stack.clock.advance(60 * 60 * 1000);
    const signed = signTryOnUrl({ tryOnId: id, sessionToken: seeded.recipientToken, secret: stack.deps.signingSecret, nowMs: stack.deps.now().getTime() });
    expect((await tryonGET(req(signed.url, { headers: cookie(seeded.recipientToken) }), params(id))).status).toBe(404);
  });
});

describe("GET /api/recipient/purge-expired", () => {
  it("needs CRON_SECRET and purges expired requests", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await purgeGET(req("/api/recipient/purge-expired"))).status).toBe(503);
    vi.stubEnv("CRON_SECRET", "cron-secret-value");
    expect((await purgeGET(req("/api/recipient/purge-expired", { headers: bearer("wrong") }))).status).toBe(401);
    stack.clock.advance(FIT_REQUEST_TTL_MS + 1);
    const res = await purgeGET(req("/api/recipient/purge-expired", { headers: bearer("cron-secret-value") }));
    expect(await res.json()).toEqual({ requests: 1, sweptBlobs: 0, verified: true });
    expect(await stack.repos.countForRequest(seeded.request.id)).toEqual({ recipient_profiles: 0, tryons: 0, hearts: 0, metal_wishes: 0, fit_reports: 0 });
  });
});

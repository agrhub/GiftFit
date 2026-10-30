/**
 * A25: POST /api/fit/requests with an `Idempotency-Key` header. A retry after a lost response (or a browser
 * re-sending the POST) gets the SAME CreateFitRequestResponse (same giver token, same request) instead of
 * a second request; concurrent duplicates create once; other keys, clients or bodies create again; invalid or
 * missing keys behave as before; entries expire after the TTL and failures are never replayed later.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateFitRequestResponse } from "@/server/contracts/api";
import type { CatalogSku } from "@/server/contracts/giftfit";
import { handleCreateRequest } from "@/server/fit/api";
import { configureFit, getFitDeps, resetFitDeps } from "@/server/fit/deps";
import { IDEMPOTENCY_TTL_MS, IdempotencyStore, type StoredOutcome, parseIdempotencyKey } from "@/server/fit/idempotency";
import { PrivacyFitRepository, StaticCatalog } from "@/server/fit/repository";
import { fakeRules, makeCatalog, sku } from "@/server/fit/__tests__/fixtures";
import { MemoryPrivacyRepos } from "@/server/privacy/repos/memory";
import { setPrivacyDeps } from "@/server/privacy/runtime";
import { POST as requestsPOST } from "../requests/route";

const T0 = new Date("2026-10-20T12:00:00Z");
const KEY = "0b7f3c1e-6a2d-4c8e-9f10-2d3c4b5a6e7f";
const OTHER_KEY = "5d6e7f80-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
let repos: MemoryPrivacyRepos;
let repo: PrivacyFitRepository;
let createSpy: ReturnType<typeof vi.spyOn>;
let clock = T0.getTime();

const CATALOG: CatalogSku[] = [
  sku("fix-001", { title: "Halo Drop Earrings", price: 240 }),
  sku("fix-002", { title: "Luna Hoop Earrings", price: 180, attributes: { earring_shape: "hoop_round_large", metal: "white_gold", metal_tone: "cool" } }),
  ...makeCatalog(120, "idem"),
];
const BODY = { occasion: "birthday", budgetMax: 300, currency: "USD", shortlistIds: ["fix-001", "fix-002"] };

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/fit/requests", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

async function send(headers: Record<string, string> = {}, body: unknown = BODY) {
  const res = await requestsPOST(post(body, headers));
  return { res, status: res.status, json: (await res.json()) as CreateFitRequestResponse };
}

beforeEach(() => {
  resetFitDeps();
  clock = T0.getTime();
  repos = new MemoryPrivacyRepos(() => T0);
  repo = new PrivacyFitRepository(async () => repos, new StaticCatalog(CATALOG));
  createSpy = vi.spyOn(repo, "createRequest");
  configureFit({ repository: repo, rules: fakeRules, explainer: null, decoySecret: "test-secret", now: () => T0, idempotency: new IdempotencyStore<StoredOutcome>({ now: () => clock }) });
});
afterEach(() => {
  resetFitDeps();
  setPrivacyDeps(undefined);
  vi.restoreAllMocks();
});

describe("POST /api/fit/requests with Idempotency-Key", () => {
  it("the same key twice, one after the other: one request, identical responses through the giver guard", async () => {
    const a = await send({ "Idempotency-Key": KEY });
    const b = await send({ "Idempotency-Key": KEY });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.json).toEqual(a.json);
    expect(b.json.giverToken).toBe(a.json.giverToken);
    expect(b.res.headers.get("cache-control")).toBe("private, no-store");
    expect(createSpy).toHaveBeenCalledTimes(1);
    // The one stored request answers the replayed giver token.
    expect((await getFitDeps().repository.findByGiverToken(b.json.giverToken))?.id).toBe(a.json.fitRequestId);
  });

  it("the same key concurrently: the in-flight request is shared, still one request", async () => {
    const [a, b, c] = await Promise.all([send({ "Idempotency-Key": KEY }), send({ "Idempotency-Key": KEY }), send({ "Idempotency-Key": KEY })]);
    expect([a.status, b.status, c.status]).toEqual([201, 201, 201]);
    expect(b.json).toEqual(a.json);
    expect(c.json).toEqual(a.json);
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it("different keys create two requests", async () => {
    const a = await send({ "Idempotency-Key": KEY });
    const b = await send({ "Idempotency-Key": OTHER_KEY });
    expect(b.json.fitRequestId).not.toBe(a.json.fitRequestId);
    expect(b.json.giverToken).not.toBe(a.json.giverToken);
    expect(createSpy).toHaveBeenCalledTimes(2);
  });

  it("a key is scoped to its body and its client: another body or another client IP creates again", async () => {
    const a = await send({ "Idempotency-Key": KEY });
    const b = await send({ "Idempotency-Key": KEY }, { ...BODY, budgetMax: 280 });
    const c = await send({ "Idempotency-Key": KEY, "x-forwarded-for": "203.0.113.9" });
    expect(new Set([a.json.fitRequestId, b.json.fitRequestId, c.json.fitRequestId]).size).toBe(3);
    expect(createSpy).toHaveBeenCalledTimes(3);
  });

  it("no key, or an invalid one, keeps today's behaviour: every call creates", async () => {
    const bad = ["short", "x".repeat(65), "has spaces in it 1234", "<script>alert(1)</script>", "ünïcödé-ünïcödé-ünïcödé"];
    for (const k of bad) {
      await send({ "Idempotency-Key": k });
      await send({ "Idempotency-Key": k });
    }
    await send();
    await send();
    expect(createSpy).toHaveBeenCalledTimes(bad.length * 2 + 2);
    expect(getFitDeps().idempotency?.size).toBe(0);
  });

  it("expires after the TTL: a retry 15 min later creates a new request", async () => {
    const a = await send({ "Idempotency-Key": KEY });
    clock += IDEMPOTENCY_TTL_MS - 1;
    expect((await send({ "Idempotency-Key": KEY })).json.giverToken).toBe(a.json.giverToken);
    clock += 1;
    const later = await send({ "Idempotency-Key": KEY });
    expect(later.json.giverToken).not.toBe(a.json.giverToken);
    expect(createSpy).toHaveBeenCalledTimes(2);
  });

  it("a failure is not replayed later: after a throw the retry creates; a 404 answer is not kept", async () => {
    createSpy.mockRejectedValueOnce(new Error("db down"));
    await expect(requestsPOST(post(BODY, { "Idempotency-Key": KEY }))).rejects.toThrow("db down");
    expect((await send({ "Idempotency-Key": KEY })).status).toBe(201);
    const bad = await requestsPOST(post({ ...BODY, shortlistIds: ["nope"] }, { "Idempotency-Key": OTHER_KEY }));
    expect(bad.status).toBe(404);
    expect(getFitDeps().idempotency?.size).toBe(1);
  });

  it("the rate limit runs once per key: a replay spends no slot, and a 429 is not replayed", async () => {
    const deps = getFitDeps();
    const limited = new Response(JSON.stringify({ error: "rate_limited" }), { status: 429, headers: { "content-type": "application/json", "Retry-After": "60" } });
    const limit = vi.fn<() => Promise<Response | undefined>>().mockResolvedValueOnce(limited).mockResolvedValue(undefined);
    const first = await handleCreateRequest(post(BODY, { "Idempotency-Key": KEY }), deps, limit);
    expect(first.status).toBe(429);
    expect(first.headers.get("retry-after")).toBe("60");
    expect((await handleCreateRequest(post(BODY, { "Idempotency-Key": KEY }), deps, limit)).status).toBe(201);
    expect((await handleCreateRequest(post(BODY, { "Idempotency-Key": KEY }), deps, limit)).status).toBe(201);
    expect(limit).toHaveBeenCalledTimes(2);
    expect(createSpy).toHaveBeenCalledTimes(1);
  });
});

describe("IdempotencyStore", () => {
  it("parseIdempotencyKey: 16–64 of [A-Za-z0-9_-], else undefined", () => {
    expect(parseIdempotencyKey(KEY)).toBe(KEY);
    expect(parseIdempotencyKey("a".repeat(64))).toBe("a".repeat(64));
    expect(parseIdempotencyKey("0123456789abcdef0123456789abcdef")).toBeDefined();
    for (const bad of [null, undefined, "", "a".repeat(15), "a".repeat(65), "abc def ghi jkl mno", "abc/def/ghi/jkl/mno"]) expect(parseIdempotencyKey(bad)).toBeUndefined();
  });

  it("is bounded: past maxEntries the oldest entry goes first", async () => {
    const store = new IdempotencyStore<number>({ maxEntries: 2 });
    let calls = 0;
    const fn = async () => ++calls;
    await store.run("a", fn, () => true);
    await store.run("b", fn, () => true);
    await store.run("c", fn, () => true);
    expect(store.size).toBe(2);
    expect((await store.run("c", fn, () => true)).replayed).toBe(true);
    expect((await store.run("a", fn, () => true)).replayed).toBe(false);
    expect(calls).toBe(4);
  });

  it("shares an in-flight value with joiners, then forgets one that is not kept", async () => {
    const store = new IdempotencyStore<string>();
    let release!: (v: string) => void;
    const fn = vi.fn(() => new Promise<string>((r) => (release = r)));
    const first = store.run("k", fn, (v) => v === "ok");
    const joiner = store.run("k", fn, (v) => v === "ok");
    release("fail");
    expect(await first).toEqual({ value: "fail", replayed: false });
    expect(await joiner).toEqual({ value: "fail", replayed: true });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(0);
  });
});

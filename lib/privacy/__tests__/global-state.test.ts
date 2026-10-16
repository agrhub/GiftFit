/**
 * Next.js bundles each route separately, so module-level state is per route. These tests load
 * lib/privacy twice (vi.resetModules = a second "bundle") and prove the defaults are shared.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(async () => {
  vi.stubEnv("DATABASE_URL", "");
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
  vi.stubEnv("GIFTFIT_URL_SIGNING_SECRET", "");
  (await import("../global-state")).resetPrivacyState();
});
afterEach(async () => {
  (await import("../global-state")).resetPrivacyState();
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function loadBundle() {
  vi.resetModules();
  const runtime = await import("../runtime");
  const signed = await import("../signed-url");
  const tokens = await import("../tokens");
  return { runtime, signed, tokens };
}

describe("process-wide state survives separate module instances (route bundles)", () => {
  it("shares the dev signing secret, the photo store and the in-memory repos", { timeout: 60_000 }, async () => {
    const a = await loadBundle();
    const b = await loadBundle();
    expect(a.runtime).not.toBe(b.runtime); // genuinely two module instances

    const depsA = await a.runtime.getPrivacyDeps();
    const depsB = await b.runtime.getPrivacyDeps();
    expect(depsB.signingSecret).toBe(depsA.signingSecret);
    expect(b.signed.getSigningSecret()).toBe(a.signed.getSigningSecret());
    expect(depsB.repos).toBe(depsA.repos);
    expect(depsB.photos).toBe(depsA.photos);

    // What "capture" writes in bundle A, "tryon/[id]" reads in bundle B.
    const t = a.tokens.newFitRequestTokens();
    const req = await depsA.repos.fitRequests.create({
      storeId: null,
      giverTokenHash: t.giverTokenHash,
      recipientTokenHash: t.recipientTokenHash,
      occasion: null,
      budgetMin: null,
      budgetMax: null,
      currency: null,
      shortlistIds: [],
      decoyIds: [],
    });
    const stored = await depsA.photos.put({ fitRequestId: req.id, kind: "tryon", bytes: new Uint8Array([1, 2]), contentType: "image/png" });
    const url = a.signed.signTryOnUrl({ tryOnId: "x", sessionToken: t.recipientToken, secret: depsA.signingSecret });
    const u = new URL(url.url, "http://x");
    expect(
      b.signed.verifyTryOnSignature({ tryOnId: "x", sessionToken: t.recipientToken, exp: u.searchParams.get("exp"), sig: u.searchParams.get("sig"), secret: depsB.signingSecret }).ok,
    ).toBe(true);
    expect((await depsB.repos.fitRequests.findByRecipientTokenHash(t.recipientTokenHash))?.id).toBe(req.id);
    expect((await depsB.photos.get(stored.key))?.bytes).toEqual(new Uint8Array([1, 2]));
  });

  it("shares an injected override across bundles", { timeout: 60_000 }, async () => {
    const a = await loadBundle();
    const b = await loadBundle();
    const fake = { marker: true } as never;
    a.runtime.setPrivacyDeps(fake);
    expect(await b.runtime.getPrivacyDeps()).toBe(fake);
    b.runtime.setPrivacyDeps(undefined);
    expect(await a.runtime.getPrivacyDeps()).not.toBe(fake);
  });

  it("keeps state under one namespaced symbol on globalThis", { timeout: 60_000 }, async () => {
    const { PRIVACY_STATE_KEY, privacyState } = await import("../global-state");
    expect(PRIVACY_STATE_KEY).toBe(Symbol.for("giftfit.privacy.state.v1"));
    const { runtime } = await loadBundle();
    await runtime.getPrivacyDeps();
    const state = privacyState();
    expect(state.memoryRepos).toBeDefined();
    expect(state.memoryPhotos).toBeDefined();
    expect(state.devSigningSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((globalThis as Record<symbol, unknown>)[PRIVACY_STATE_KEY]).toBe(state);
  });
});

describe("signing secret policy", () => {
  it("production still requires GIFTFIT_URL_SIGNING_SECRET", async () => {
    const { getSigningSecret } = await import("../signed-url");
    expect(() => getSigningSecret({ NODE_ENV: "production" })).toThrow(/GIFTFIT_URL_SIGNING_SECRET/);
  });

  it("warns once when generating a secret outside tests, never under tests", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { getSigningSecret } = await import("../signed-url");
    getSigningSecret({ NODE_ENV: "test" });
    expect(warn).not.toHaveBeenCalled();
    (await import("../global-state")).resetPrivacyState();
    getSigningSecret({ NODE_ENV: "development" });
    getSigningSecret({ NODE_ENV: "development" });
    getSigningSecret({});
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/GIFTFIT_URL_SIGNING_SECRET is not set/);
  });
});

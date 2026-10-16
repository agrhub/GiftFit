/**
 * Mock-mode API smoke for recipient deletion and the expiry cron (owner: A8), against the
 * production build. The full delete-everything behaviour (blobs, cache, tasks, rows, receipt) is
 * unit-tested in lib/privacy/__tests__/delete-everything.test.ts, drizzle-delete.test.ts and
 * app/api/recipient/__tests__/routes.test.ts. This spec checks the deployed surface: status codes,
 * no-store caching, cookie clearing and CRON_SECRET auth, with the real env handling of `next start`
 * (NODE_ENV=production, where GIFTFIT_URL_SIGNING_SECRET is mandatory).
 *
 * A session-bearing delete (create request -> capture -> delete -> links dead) needs a Fit Request
 * creator route, which does not exist yet; it is covered by tests/e2e/ui/gift-flow.spec.ts once A4's
 * P3 pages land.
 */
import { expect, test } from "@playwright/test";

const fakeToken = (c: string) => c.repeat(43); // shaped like a 256-bit base64url token, never issued

test("POST /api/recipient/delete without a token is 401 and never cached", async ({ request }) => {
  const res = await request.post("/api/recipient/delete");
  expect(res.status()).toBe(401);
  expect(res.headers()["cache-control"]).toContain("no-store");
  expect(await res.json()).toEqual({ error: "missing_token" });
});

test("POST /api/recipient/delete with an unknown token (Bearer or cookie) is 404", async ({ request }) => {
  const bearer = await request.post("/api/recipient/delete", { headers: { authorization: `Bearer ${fakeToken("Z")}` } });
  expect(bearer.status()).toBe(404);
  expect(bearer.headers()["cache-control"]).toContain("no-store");
  expect(await bearer.json()).toEqual({ error: "link_not_valid" });

  const cookie = await request.post("/api/recipient/delete", { headers: { cookie: `gf_recipient=${fakeToken("Y")}` } });
  expect(cookie.status()).toBe(404);

  // Not token-shaped at all: refused before any lookup (401 or 404, never 200).
  const junk = await request.post("/api/recipient/delete", { headers: { authorization: "Bearer not a token" } });
  expect([401, 404]).toContain(junk.status());
});

test("recipient data routes refuse callers without a recipient session", async ({ request }) => {
  for (const res of [
    await request.get("/api/recipient/undertone"),
    await request.get("/api/recipient/tryons"),
    await request.get("/api/recipient/tryon/does-not-exist"),
  ]) {
    expect([401, 403, 404]).toContain(res.status());
    expect(res.headers()["cache-control"] ?? "").toContain("no-store");
    const ct = res.headers()["content-type"] ?? "";
    expect(ct.startsWith("image/"), `${res.url()} must not serve an image without a session`).toBe(false);
  }
});

test("GET /api/recipient/purge-expired requires the cron secret", async ({ request }) => {
  const none = await request.get("/api/recipient/purge-expired");
  expect(none.status()).toBe(401);
  const wrong = await request.get("/api/recipient/purge-expired", { headers: { authorization: "Bearer wrong" } });
  expect(wrong.status()).toBe(401);
});

test("GET /api/recipient/purge-expired with the cron secret purges and verifies", async ({ request }) => {
  test.skip(!!process.env.E2E_BASE_URL, "cron secret is only known for the server this config starts");
  const res = await request.get("/api/recipient/purge-expired", { headers: { authorization: `Bearer ${process.env.E2E_CRON_SECRET}` } });
  expect(res.status()).toBe(200);
  expect(res.headers()["cache-control"]).toContain("no-store");
  const body = (await res.json()) as { requests: number; sweptBlobs: number; verified: boolean };
  expect(body.verified).toBe(true);
  expect(body.requests).toBeGreaterThanOrEqual(0);
});

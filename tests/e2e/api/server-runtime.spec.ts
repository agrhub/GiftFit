/**
 * Runtime check of the production build's server externals (owner: A8).
 *
 * next.config.ts keeps server-only packages (zod, drizzle-orm, @anthropic-ai/sdk, cheerio,
 * fast-xml-parser, robots-parser, @vercel/blob, standardwebhooks, playwright, ...) out of the webpack
 * bundle; they are `require`d from node_modules when a route first runs. Vitest never sees the
 * built bundle, so a bad external would only fail in production. This spec makes every route
 * family load its module graph in `next start`, offline: ingest runs on the committed fixture store
 * (INGEST_FIXTURE=1, heuristic extractor, no Claude), the webhook verifier rejects an unsigned call.
 */
import { expect, test } from "@playwright/test";

// The fixture crawl runs in-process and is CPU-heavy on small machines; keep this file's tests in
// order on one worker so they do not starve each other.
test.describe.configure({ mode: "serial", timeout: 60_000 });

test("ingest refuses hosts outside the allow-list", async ({ request }) => {
  const res = await request.post("/api/ingest", { data: { url: "https://example.com/" } });
  expect(res.status()).toBe(403);
});

test("ingest (cheerio, fast-xml-parser, robots-parser, zod): a fixture crawl completes", async ({ request }) => {
  test.setTimeout(90_000);
  const start = await request.post("/api/ingest", { data: { url: "https://aurum-fixture.test/", maxProducts: 5 } });
  expect([200, 202]).toContain(start.status());
  const { jobId, statusUrl } = (await start.json()) as { jobId: string; statusUrl: string };
  expect(jobId).toBeTruthy();

  let job: { status: string; skuCount: number; error?: string } = { status: "queued", skuCount: 0 };
  await expect
    .poll(
      async () => {
        job = await (await request.get(statusUrl)).json();
        return job.status;
      },
      { timeout: 75_000, intervals: [500, 1000, 2000] },
    )
    .toMatch(/^(done|error)$/);
  expect(job.error ?? null).toBeNull();
  expect(job.status).toBe("done");
  expect(job.skuCount).toBeGreaterThan(0);

  const list = await request.get("/api/ingest");
  expect(list.status()).toBe(200);
});

test("YouCam webhook (standardwebhooks) rejects an unsigned call", async ({ request }) => {
  const res = await request.post("/api/youcam/webhook", { data: { task_id: "x", task_status: "success" } });
  // 401 bad signature when YOUCAM_WEBHOOK_SECRET is set, 503 when it is not configured; never 200/500.
  expect([401, 503]).toContain(res.status());
});

test("mock-mode assets are served only for known names", async ({ request }) => {
  expect((await request.get("/api/youcam/mock-asset/mock-jewelry-vto.png")).status()).toBe(200);
  expect((await request.get("/api/youcam/mock-asset/..%2F..%2Fpackage.json")).status()).toBe(404);
});

test("health (Cloud Run smoke): flags and version only, nothing secret", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.status()).toBe(200);
  expect(res.headers()["cache-control"]).toBe("no-store");
  const text = await res.text();
  const body = JSON.parse(text);
  expect(Object.keys(body).sort()).toEqual(["demoAvailable", "mock", "ok", "paidCallsEnabled", "version"]);
  expect(body).toMatchObject({ ok: true, mock: true, demoAvailable: true, paidCallsEnabled: false });
  expect(text).not.toContain(process.env.E2E_CRON_SECRET!);
  expect(text).not.toContain(process.env.E2E_SIGNING_SECRET!);
});

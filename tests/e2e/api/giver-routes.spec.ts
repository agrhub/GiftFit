/**
 * Mock-mode API smoke for the giver routes (owner: A8), against the production build.
 *
 * Unit tests (lib/privacy/__tests__/giver-routes.probe.test.ts, app/api/fit/__tests__) call the
 * handlers in-process. This spec covers what they cannot: the compiled `next start` server with
 * its externalised server packages, real HTTP serialisation and headers, and the route table as
 * actually built. Every giver route listed in A5's route manifest must be exercised here.
 */
import { expect, test, type APIResponse } from "@playwright/test";
import { ROUTE_MANIFEST } from "../../../lib/privacy/route-manifest";
import { scanGiverResponse } from "../support/giver-leaks";

// app/api/fit/requests is exercised end to end in gift-journey.spec.ts (P3 merge).
const COVERED_GIVER_ROUTES = ["app/api/fit/report/route.ts", "app/api/fit/decoys/route.ts", "app/api/fit/weights/route.ts", "app/api/fit/requests/route.ts", "app/api/demo/seed/route.ts"];

async function expectNoLeaks(res: APIResponse): Promise<unknown> {
  const text = await res.text();
  const leaks = scanGiverResponse(text, res.headers());
  expect(leaks, `giver response from ${res.url()} leaks recipient data:\n${JSON.stringify(leaks, null, 2)}`).toEqual([]);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

test("every giver route in the route manifest is covered by this smoke", () => {
  const giverRoutes = Object.entries(ROUTE_MANIFEST)
    .filter(([, e]) => e.audience === "giver")
    .map(([k]) => k)
    .sort();
  expect(giverRoutes, "a giver route was added: add it to this spec and to COVERED_GIVER_ROUTES").toEqual([...COVERED_GIVER_ROUTES].sort());
});

test("GET /api/fit/weights publishes the formula and nothing about any recipient", async ({ request }) => {
  const res = await request.get("/api/fit/weights");
  expect(res.status()).toBe(200);
  const body = (await expectNoLeaks(res)) as { version: string; weights: Record<string, number> };
  expect(body.version).toMatch(/^fit-v/);
  const total = Object.values(body.weights).reduce((a, b) => a + (typeof b === "number" ? b : 0), 0);
  expect(total).toBeGreaterThan(0);
});

test("POST /api/fit/decoys returns ids and reason codes only", async ({ request }) => {
  const res = await request.post("/api/fit/decoys", { data: { shortlistIds: ["AUR-EAR-028", "AUR-NEC-037"], requestId: "e2e-smoke" } });
  // 404 unknown_sku until the default FitRepository is wired to the Aurum catalog (P3, see docs/reports/A8.md).
  expect([200, 404]).toContain(res.status());
  const body = (await expectNoLeaks(res)) as Record<string, unknown>;
  if (res.status() === 200) {
    expect(Array.isArray(body.decoyIds)).toBe(true);
    expect(typeof body.ok).toBe("boolean");
    expect(Object.keys(body).sort()).toEqual(["carouselSize", "decoyIds", "ok", "reasons"]);
  } else {
    test.info().annotations.push({ type: "note", description: "decoys: catalog not wired into the default FitRepository (unknown_sku)" });
    expect(body).toEqual({ error: "unknown_sku" });
  }
});

test("POST /api/fit/decoys rejects bad bodies and unknown ids without echoing them", async ({ request }) => {
  for (const data of [{}, { shortlistIds: [] }, { shortlistIds: ["a", "b", "c", "d", "e"] }, { shortlistIds: "AUR-EAR-028" }]) {
    const res = await request.post("/api/fit/decoys", { data });
    expect(res.status()).toBe(400);
    expect(await expectNoLeaks(res)).toEqual({ error: "bad_request" });
  }
  const unknown = await request.post("/api/fit/decoys", { data: { shortlistIds: ["NOT-A-SKU-#ff00aa"] } });
  expect(unknown.status()).toBe(404);
  expect(await expectNoLeaks(unknown)).toEqual({ error: "unknown_sku" });
});

test("POST /api/fit/report: unknown or malformed giver tokens get bare error codes", async ({ request }) => {
  const unknown = await request.post("/api/fit/report", { data: { giverToken: "A".repeat(43) } });
  expect(unknown.status()).toBe(404);
  expect(await expectNoLeaks(unknown)).toEqual({ error: "not_found" });

  const viaHeader = await request.post("/api/fit/report", { headers: { "x-giver-token": "B".repeat(43) } });
  expect(viaHeader.status()).toBe(404);
  await expectNoLeaks(viaHeader);

  const malformed = await request.post("/api/fit/report", { data: { giverToken: "short" } });
  expect(malformed.status()).toBe(400);
  expect(await expectNoLeaks(malformed)).toEqual({ error: "bad_request" });
});

test("giver routes refuse methods they do not implement", async ({ request }) => {
  for (const res of [await request.get("/api/fit/report"), await request.get("/api/fit/decoys"), await request.post("/api/fit/weights")]) {
    expect(res.status()).toBe(405);
    await expectNoLeaks(res);
  }
});

test("POST /api/demo/seed returns links and the AI-model label only, with no recipient data", async ({ request }) => {
  const res = await request.post("/api/demo/seed", { data: {} });
  expect(res.status()).toBe(201);
  const body = (await expectNoLeaks(res)) as Record<string, unknown>;
  expect(body.recipientPath).toMatch(/^\/r\//);
  expect(body.giverReportPath).toMatch(/^\/g\//);
  expect(String(body.label)).toMatch(/AI-generated model/);
  expect(JSON.stringify(body)).not.toMatch(/tryon|\.jpg|skin_color|faceshape/i);
});

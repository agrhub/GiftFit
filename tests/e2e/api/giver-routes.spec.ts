/**
 * Mock-mode API smoke for the giver routes (owner: A8), against the production build.
 *
 * Unit tests (server/privacy/__tests__/giver-routes.probe.test.ts, app/api/fit/__tests__) call the
 * handlers in-process. This spec covers what they cannot: the compiled `next start` server with
 * its externalised server packages, real HTTP serialisation and headers, and the route table as
 * actually built. Every giver route listed in A5's route manifest must be exercised here.
 */
import { expect, test, type APIResponse } from "@playwright/test";
import { ROUTE_MANIFEST } from "../../../server/privacy/route-manifest";
import { scanGiverResponse } from "../support/giver-leaks";

// app/api/fit/requests is exercised end to end in gift-journey.spec.ts (P3 merge).
const COVERED_GIVER_ROUTES = [
  "app/api/fit/report/route.ts",
  "app/api/fit/decoys/route.ts",
  "app/api/fit/weights/route.ts",
  "app/api/fit/requests/route.ts",
  "app/api/demo/seed/route.ts",
  "app/api/concierge/route.ts",
  // A6 widget (ADR-046); the full UI flow is in tests/e2e/plugin/widget.spec.ts.
  "app/api/widget/send-card/route.ts",
  "app/api/widget/notify/route.ts",
  // A13 voice (ADR-052/053), VOICE_MOCK=1 in the webServer env; the UI flow is in tests/e2e/plugin/voice.spec.ts.
  "app/api/voice/stt/route.ts",
  "app/api/voice/tts/route.ts",
  // A10 store-URL preview (ADR-055); crawls themselves are unit-tested (no network in e2e).
  "app/api/preview/route.ts",
  "app/api/preview/[key]/route.ts",
];

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

test("POST /api/concierge streams NDJSON (mock fixture, keyless) with a draft brief and grounded suggestions", async ({ request }) => {
  const res = await request.post("/api/concierge", {
    data: { messages: [{ role: "user", content: "Anniversary gift for my wife. She loves minimal, delicate pieces and mostly wears gold. Budget around $300." }] },
  });
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("application/x-ndjson");
  const lines = (await res.text()).split("\n").filter(Boolean);
  for (const line of lines) {
    // Concierge suggestions may carry public catalog product images, never anything else.
    const leaks = scanGiverResponse(line, res.headers(), { allowProductImagePrefixes: ["/catalog/"] });
    expect(leaks, line).toEqual([]);
  }
  const events = lines.map((l) => JSON.parse(l) as { type: string; [k: string]: unknown });
  expect(events[0]).toEqual({ type: "start", source: "mock" });
  expect(events.some((e) => e.type === "text")).toBe(true);
  expect(events.filter((e) => e.type === "tool").map((e) => e.name)).toContain("create_fit_request");
  const final = events.at(-1) as { type: string; brief: { mode: string; budgetMax: number }; suggestions: Array<{ fromPrice: number }> };
  expect(final.type).toBe("final");
  expect(final.brief.mode).toBe("help_me_choose");
  expect(final.suggestions.length).toBeGreaterThan(0);
  for (const s of final.suggestions) expect(s.fromPrice).toBeLessThanOrEqual(final.brief.budgetMax);
});

test("POST /api/concierge rejects bad bodies with bare error codes", async ({ request }) => {
  for (const data of [{}, { messages: [] }, { messages: [{ role: "assistant", content: "hi" }] }, { messages: [{ role: "user", content: "" }] }]) {
    const res = await request.post("/api/concierge", { data });
    expect(res.status()).toBe(400);
    expect(await expectNoLeaks(res)).toEqual({ error: "invalid_request" });
  }
  const long = await request.post("/api/concierge", { data: { messages: [{ role: "user", content: "x".repeat(1501) }] } });
  expect(long.status()).toBe(400);
  expect(await expectNoLeaks(long)).toEqual({ error: "message_too_long" });
});

test("POST /api/widget/send-card and /api/widget/notify: own request only, bare codes, no address or token echoed", async ({ request }) => {
  const headers = { "X-Forwarded-For": "203.0.113.47" };
  const created = await request.post("/api/fit/requests", { headers, data: { mode: "help_me_choose", occasion: "birthday", budgetMax: 300, currency: "USD", shortlistIds: [] } });
  expect(created.status()).toBe(201);
  const c = (await expectNoLeaks(created)) as { giverToken: string; recipientPath: string };
  const recipientToken = c.recipientPath.split("/").pop()!;

  for (const [data, status, error] of [
    [{}, 400, "invalid_request"],
    [{ giverToken: c.giverToken, recipientToken, to: "nope", lang: "en" }, 400, "invalid_email"],
    [{ giverToken: "A".repeat(43), recipientToken, to: "a@example.com", lang: "en" }, 404, "not_found"],
    [{ giverToken: c.giverToken, recipientToken: "B".repeat(43), to: "a@example.com", lang: "en" }, 404, "not_found"],
  ] as const) {
    const res = await request.post("/api/widget/send-card", { headers, data });
    expect(res.status(), JSON.stringify(data)).toBe(status);
    expect(await expectNoLeaks(res)).toEqual({ error });
  }

  const sent = await request.post("/api/widget/send-card", { headers, data: { giverToken: c.giverToken, recipientToken, to: "someone@example.com", lang: "vi", message: "Chúc mừng sinh nhật!" } });
  expect(sent.status()).toBe(200);
  const sentText = await sent.text();
  expect(JSON.parse(sentText)).toEqual({ sent: true, delivery: "logged" });
  expect(sentText).not.toMatch(/someone@example\.com|[A-Za-z0-9_-]{40,}/);

  const saved = await request.post("/api/widget/notify", { headers, data: { giverToken: c.giverToken, email: "giver@example.com", lang: "en" } });
  expect(saved.status()).toBe(200);
  expect(await expectNoLeaks(saved)).toEqual({ saved: true });
  const unknown = await request.post("/api/widget/notify", { headers, data: { giverToken: "C".repeat(43), email: "giver@example.com", lang: "en" } });
  expect(unknown.status()).toBe(404);
  expect(await expectNoLeaks(unknown)).toEqual({ error: "not_found" });
});

test("POST /api/voice/tts (mock) returns labelled audio only; /api/voice/stt refuses bad input with bare codes", async ({ request }) => {
  const session = "8b0a6b3e-3c1f-4f8e-9d2a-1f4c5e6a7b8c";
  const tts = await request.post("/api/voice/tts", { headers: { "x-voice-session": session }, data: { text: "Here are three ideas for her birthday.", lang: "en" } });
  expect(tts.status()).toBe(200);
  expect(tts.headers()["content-type"]).toMatch(/^audio\//);
  expect(tts.headers()["x-voice-engine"]).toBe("mock");
  expect((await tts.body()).byteLength).toBeGreaterThan(1000);
  // No session header → bare code; nothing echoed back.
  const noSession = await request.post("/api/voice/tts", { data: { text: "hello", lang: "en" } });
  expect(noSession.status()).toBe(400);
  expect(await expectNoLeaks(noSession)).toEqual({ error: "bad_session" });
  const tooLong = await request.post("/api/voice/tts", { headers: { "x-voice-session": session }, data: { text: "x".repeat(401), lang: "en" } });
  expect(tooLong.status()).toBe(400);
  expect(await expectNoLeaks(tooLong)).toEqual({ error: "text_too_long" });
  // Not audio at all → bad_audio; the body is never echoed.
  const stt = await request.post("/api/voice/stt", { headers: { "x-voice-session": session, "x-voice-lang": "en", "content-type": "audio/webm" }, data: Buffer.from("not really audio") });
  expect(stt.status()).toBe(400);
  expect(await expectNoLeaks(stt)).toEqual({ error: "bad_audio" });
});

test("POST /api/preview and GET /api/preview/<key>: SSRF refusals with bare codes, status without products or URLs", async ({ request }) => {
  const headers = { "X-Forwarded-For": "203.0.113.48" };
  for (const [data, error] of [
    [{}, "invalid_url"],
    [{ url: "http://shop.example" }, "blocked_url"],
    [{ url: "https://127.0.0.1/" }, "blocked_url"],
    [{ url: "https://169.254.169.254/latest/meta-data" }, "blocked_url"],
    [{ url: "https://shop.example:8443/" }, "blocked_url"],
  ] as const) {
    const res = await request.post("/api/preview", { headers, data });
    expect(res.status(), JSON.stringify(data)).toBe(400);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error });
    expect(text).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  }
  const unknown = await request.get(`/api/preview/${"Z".repeat(22)}`, { headers });
  expect(unknown.status()).toBe(404);
  expect(await expectNoLeaks(unknown)).toEqual({ error: "not_found" });

  // A ready fixture preview (A6's e2e seed; nothing crawled): counts only, no products, no URLs.
  const seeded = await request.post("/api/preview/seed", { headers: { ...headers, Authorization: `Bearer ${process.env.E2E_CRON_SECRET}` }, data: { kind: "jewelry" } });
  expect(seeded.status()).toBe(201);
  const { key } = (await seeded.json()) as { key: string };
  const status = await request.get(`/api/preview/${key}`, { headers });
  expect(status.status()).toBe(200);
  const body = (await expectNoLeaks(status)) as Record<string, unknown>;
  expect(body).toMatchObject({ state: "ready", domain: "lumen-jewelry.example", productCount: 10 });
  expect(JSON.stringify(body)).not.toMatch(/https?:\/\/|"products"/);
  // Without the secret the seed route does not exist.
  expect((await request.post("/api/preview/seed", { headers, data: {} })).status()).toBe(404);
});

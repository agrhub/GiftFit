/**
 * A16: the owner-only recording switch and the public 0-unit flows, in the mock REHEARSAL setup: a server with
 * YOUCAM_MOCK=1 + YOUCAM_RECORDING=on + GIFTFIT_RECORDING_TOKEN (0 units, no YouCam network). Public visitors get
 * exactly what production gives them (hearts-only, demo-mode copy); the owner's browser gets the try-on flow on
 * fixtures. Runs only when E2E_RECORDING_TOKEN is set (the token the server was started with); the default
 * Playwright server (recording off) skips it. Screenshots: E2E_SHOTS_DIR (default test-results/a16-shots).
 */
import path from "node:path";
import { devices, expect, test, type APIRequestContext, type BrowserContext, type FrameLocator, type Page } from "@playwright/test";
import { startDemoStore, type DemoStore } from "../support/demo-store";
import { recipientCapture } from "../support/recipient-ui";

const TOKEN = process.env.E2E_RECORDING_TOKEN ?? "";
const SHOTS = process.env.E2E_SHOTS_DIR ?? path.join("test-results", "a16-shots");
const STORE_PORT = Number(process.env.A16_DEMO_STORE_PORT ?? 4362);
const NO_TRYON = /\b(undertones?|skin|face[- ]?shapes?|faces?|try[- ]?ons?|tried (it |them )?on|selfies?|photos?|estimates?d?|low[- ]confidence)\b/i;

test.skip(!TOKEN, "needs a server started with YOUCAM_RECORDING=on and E2E_RECORDING_TOKEN");
test.describe.configure({ mode: "serial", timeout: 240_000 });

let store: DemoStore | undefined;
test.beforeAll(async ({ baseURL }) => {
  if (TOKEN) store = await startDemoStore(STORE_PORT, new URL(baseURL!).origin);
});
test.afterAll(() => store?.stop());

const shot = (page: Page, name: string) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });

async function seedPreview(request: APIRequestContext): Promise<{ key: string; previewPath: string }> {
  const res = await request.post("/api/preview/seed", { headers: { Authorization: `Bearer ${process.env.E2E_CRON_SECRET}` }, data: { kind: "jewelry" } });
  expect(res.status()).toBe(201);
  return res.json();
}

/** Makes this browser context the owner's recording browser (#t= → HttpOnly gf_rec cookie). */
async function becomeOwner(ctx: BrowserContext, name?: string): Promise<void> {
  const p = await ctx.newPage();
  await p.goto(`/owner/recording#t=${TOKEN}`);
  await expect(p.getByTestId("recording-status")).toContainText("Owner session active", { timeout: 30_000 });
  expect(p.url()).not.toContain(TOKEN); // the fragment is stripped from the address bar
  if (name) await shot(p, name);
  await p.close();
}

/** Widget giver flow on a page that embeds giftfit.js: chat → brief → create → e-card. Returns the share link. */
async function widgetGift(g: Page, message: string, name: string): Promise<{ frame: FrameLocator; link: string; created: Record<string, unknown> }> {
  const widget = g.locator("giftfit-widget");
  await expect(widget).toHaveAttribute("data-ready", "", { timeout: 90_000 });
  const frame = g.frameLocator("giftfit-widget iframe");
  await frame.getByRole("button", { name: "Open the gift assistant" }).click();
  const input = frame.getByLabel("Your message");
  await input.fill(message);
  await input.press("Enter");
  await expect(frame.getByRole("list", { name: "Suggested pieces" })).toBeVisible({ timeout: 60_000 });
  await frame.getByTestId("widget-use-brief").click();
  await shot(g, `${name}-brief`);
  const created = g.waitForResponse((r) => r.url().endsWith("/api/fit/requests") && r.request().method() === "POST");
  await frame.getByTestId("widget-create").click();
  const res = await created;
  expect(res.status()).toBe(201);
  await expect(frame.getByTestId("widget-card-step")).toBeVisible({ timeout: 30_000 });
  await shot(g, `${name}-ecard`);
  return { frame, link: await frame.getByTestId("widget-share-link").inputValue(), created: await res.json() };
}

test("health probe: recording on, but this mock server can never pay", async ({ request }) => {
  const h = await (await request.get("/api/health")).json();
  expect(h).toMatchObject({ mock: true, recording: "on", youcamPaid: false, publicTryOn: "off" });
});

test("owner rehearsal on a store-URL preview: widget gift → e-card → mixed try-on (eligible + not-eligible) → hearts → finish → Fit Report", async ({ browser, baseURL, request }) => {
  const s = await seedPreview(request);
  const giver = await browser.newContext({ ...devices["Desktop Chrome"], baseURL, extraHTTPHeaders: { "X-Forwarded-For": "203.0.113.81" } });
  const recipient = await browser.newContext({ ...devices["Pixel 7"], baseURL });
  try {
    await becomeOwner(giver, "01-owner-recording-session");
    await becomeOwner(recipient);
    const g = await giver.newPage();
    await g.goto(`${s.previewPath}/p/1001`);
    const { frame, created } = await widgetGift(g, "Birthday gift for my sister, earrings under $300", "02-owner-preview");
    // The owner's gift offers a try-on: try-on copy on the brief and the e-card.
    await expect(frame.getByTestId("widget-no-tryon")).toHaveCount(0);
    await expect(frame.getByTestId("widget-ecard")).toContainText(/Try a few pieces on/i);
    expect(created.tryOn).toBeUndefined();

    // A gift that surely mixes an eligible piece (1001, packshot) and a not-eligible one (1007, model shot).
    const mixed = await giver.request.post("/api/fit/requests", { data: { storeId: `preview:${s.key}`, mode: "i_have_ideas", occasion: "birthday", budgetMax: 300, currency: "USD", shortlistIds: [`${s.key}~pv-0-1001`, `${s.key}~pv-6-1007`] } });
    expect(mixed.status()).toBe(201);
    const m = (await mixed.json()) as { recipientPath: string; giverReportPath: string; tryOnPartial?: boolean };
    expect(m.tryOnPartial).toBe(true);

    const r = await recipient.newPage();
    await r.goto(m.recipientPath);
    await expect(r.getByTestId("mixed-tryon-consent")).toContainText("can be tried on", { timeout: 30_000 });
    await shot(r, "03-recipient-consent-mixed");
    await recipientCapture(r);
    const notTried = r.getByTestId("not-tried-on-note");
    await expect(notTried.first()).toBeVisible();
    await expect(r.getByTestId("tryon-image").first()).toBeVisible({ timeout: 30_000 });
    await shot(r, "04-recipient-carousel-mixed");
    const cards = r.getByTestId("carousel-item");
    await cards.nth(0).getByTestId("heart").click();
    await cards.nth(1).getByTestId("heart").click();
    await r.getByTestId("send-hearts").click();
    await expect(r.getByTestId("undertone-screen")).toBeVisible({ timeout: 30_000 });
    await r.getByTestId("finish").click();
    await expect(r.getByTestId("done-screen")).toBeVisible({ timeout: 30_000 });
    await shot(r, "05-recipient-done");

    await g.goto(m.giverReportPath);
    await expect(g.getByTestId("fit-report-item").first()).toBeVisible({ timeout: 60_000 });
    await expect(g.getByTestId("not-tried-on-badge")).toHaveCount(1);
    await expect(g.getByTestId("mixed-tryon-note")).toBeVisible();
    await expect(g.getByTestId("photos-seen-counter")).toContainText("0");
    await shot(g, "06-giver-report-mixed");
    const rep = await (await giver.request.post("/api/fit/report", { data: { giverToken: m.giverReportPath.split("/").pop() } })).json();
    const untried = rep.results.find((x: { tryOn?: boolean }) => x.tryOn === false);
    expect(Object.keys(untried.breakdown).sort()).toEqual(["budgetOccasion", "hearts"]);
    for (const t of [...untried.reasons, untried.caution ?? ""]) expect(t).not.toMatch(NO_TRYON);
  } finally {
    await giver.close();
    await recipient.close();
  }
});

test("public demo store: giver flow works, e-card says no photo; recipient is hearts-only in demo mode (0 units)", async ({ browser, baseURL }) => {
  const giver = await browser.newContext({ ...devices["Desktop Chrome"], baseURL, extraHTTPHeaders: { "X-Forwarded-For": "203.0.113.82" } });
  const recipient = await browser.newContext({ ...devices["Pixel 7"], baseURL });
  try {
    const g = await giver.newPage();
    await g.setViewportSize({ width: 1280, height: 720 });
    await g.goto(`${store!.url}/p/halo-drop-earrings`);
    const { frame, link, created } = await widgetGift(g, "Anniversary gift for my wife, gold earrings, around $300", "07-public-demo-store");
    expect(created.tryOn).toBe(false);
    await expect(frame.getByTestId("widget-ecard")).toContainText("No photo is needed");
    await expect(frame.getByTestId("widget-ecard")).not.toContainText(/camera/i);

    const token = link.split("/").pop()!;
    const capture = await recipient.request.post("/api/recipient/capture", { headers: { Authorization: `Bearer ${token}` }, multipart: { selfie: { name: "s.jpg", mimeType: "image/jpeg", buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) } } });
    expect(capture.status()).toBe(409);
    expect(await capture.json()).toEqual({ error: "tryon_off" });

    const r = await recipient.newPage();
    await r.goto(new URL(link).pathname);
    const note = r.getByTestId("no-tryon-consent");
    await expect(note).toContainText("Demo mode: try-ons are pre-recorded and no photo is sent", { timeout: 30_000 });
    await expect(note.getByTestId("judge-demo-link")).toHaveAttribute("href", "/demo");
    await shot(r, "08-public-recipient-consent");
    await r.getByTestId("consent-accept").click();
    await expect(r.getByTestId("no-tryon-note")).toContainText("Demo mode");
    await expect(r.getByTestId("selfie-input")).toHaveCount(0);
    await r.getByTestId("carousel-item").first().getByTestId("heart").click();
    await shot(r, "09-public-recipient-hearts");
    await r.getByTestId("send-hearts").click();
    await expect(r.getByTestId("done-screen")).toBeVisible({ timeout: 30_000 });

    const reportHref = (await frame.getByTestId("widget-report-link").getAttribute("href"))!;
    await g.goto(new URL(reportHref).pathname);
    await expect(g.getByTestId("fit-report-item").first()).toBeVisible({ timeout: 60_000 });
    await expect(g.getByTestId("not-tried-on-badge")).toHaveCount(0);
    expect(await g.locator("main").innerText()).not.toMatch(/undertone|face shape|tried on/i);
    await shot(g, "10-public-giver-report");
  } finally {
    await giver.close();
    await recipient.close();
  }
});

test("public preview: hearts-only with the preview note; capture refused", async ({ request, browser, baseURL }) => {
  const s = await seedPreview(request);
  const c = await (await request.post("/api/fit/requests", { headers: { "X-Forwarded-For": "203.0.113.83" }, data: { storeId: `preview:${s.key}`, mode: "help_me_choose", occasion: "birthday", budgetMax: 300, currency: "USD", shortlistIds: [], categories: ["earring"] } })).json();
  expect(c.tryOn).toBe(false);
  const ctx = await browser.newContext({ ...devices["Pixel 7"], baseURL });
  try {
    const r = await ctx.newPage();
    await r.goto(c.recipientPath);
    await expect(r.getByTestId("no-tryon-consent")).toHaveAttribute("data-note", "preview_off", { timeout: 30_000 });
    await shot(r, "11-public-preview-consent");
  } finally {
    await ctx.close();
  }
});

test("judge demo still works: /demo → pre-recorded try-ons → Fit Report", async ({ page }) => {
  await page.goto("/demo");
  await page.getByTestId("try-judge-demo").click();
  const r = page.getByTestId("demo-recipient-link");
  await expect(r).toBeVisible({ timeout: 30_000 });
  const recipientPath = (await r.getAttribute("href"))!;
  const giverPath = (await page.getByTestId("demo-giver-link").getAttribute("href"))!;
  await page.goto(recipientPath);
  await expect(page.getByTestId("carousel-item").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("tryon-image").first()).toBeVisible({ timeout: 30_000 });
  await shot(page, "12-judge-demo-recipient");
  await page.goto(giverPath);
  await expect(page.getByTestId("fit-report")).toBeVisible({ timeout: 30_000 });
  await shot(page, "13-judge-demo-report");
});

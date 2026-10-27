/**
 * Store-URL previews, the bookmarklet and Admin v0 (owner: A6, ADR-055), on fixture previews seeded
 * through POST /api/preview/seed (PREVIEW_FIXTURE_SEED=1 + Bearer CRON_SECRET in playwright.config.ts;
 * fictional .example stores, nothing crawled). Mock Concierge (keyless), no YouCam.
 */
import { createServer, type Server } from "node:http";
import { devices, expect, test, type APIRequestContext, type BrowserContext } from "@playwright/test";
import { scanGiverResponse, type Leak } from "../support/giver-leaks";

const HOST_PORT = 4361;
const HOST = `http://127.0.0.1:${HOST_PORT}`;
let host: Server | undefined;

test.describe.configure({ mode: "serial", timeout: 150_000 });
test.use({ extraHTTPHeaders: { "X-Forwarded-For": "203.0.113.55" } });

interface Seeded {
  key: string;
  previewPath: string;
  ownerPath: string;
}

async function seed(request: APIRequestContext, kind: "jewelry" | "generic", state?: string): Promise<Seeded> {
  const res = await request.post("/api/preview/seed", { headers: { Authorization: `Bearer ${process.env.E2E_CRON_SECRET}` }, data: { kind, ...(state ? { state } : {}) } });
  expect(res.status()).toBe(201);
  return (await res.json()) as Seeded;
}

function watchLeaks(ctx: BrowserContext, appOrigin: string): Leak[] {
  const leaks: Leak[] = [];
  ctx.on("response", async (res) => {
    if (!/\/api\/(concierge|fit\/|widget\/)/.test(res.url())) return;
    const body = await res.text().catch(() => "");
    for (const line of body.split("\n").filter(Boolean)) for (const l of scanGiverResponse(line, res.headers(), { allowProductImagePrefixes: ["/catalog/"], allowProductImageUrls: [`${appOrigin}/catalog/`] })) leaks.push({ ...l, path: `${res.url()} ${l.path}` });
  });
  return leaks;
}

test.beforeAll(async () => {
  // A third-party "merchant" page: "/" has no CSP, "/strict" only allows its own scripts.
  host = createServer((req, res) => {
    const strict = req.url?.startsWith("/strict");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...(strict ? { "Content-Security-Policy": "script-src 'self'; frame-src 'self'" } : {}) });
    res.end(`<!doctype html><html lang="en"><head><title>Merchant</title></head><body><h1>Aria Gold Hoops</h1><p>Merchant page</p></body></html>`);
  });
  await new Promise<void>((r) => host!.listen(HOST_PORT, "127.0.0.1", () => r()));
});
test.afterAll(() => host?.close());

test("preview store: banner, noindex, no forms, View on links, JSON-LD product pages, states, 404", async ({ page, request }) => {
  const s = await seed(request, "jewelry");
  const res = await page.goto(s.previewPath);
  expect(res?.status()).toBe(200);
  expect(res?.headers()["x-robots-tag"]).toBe("noindex, nofollow");
  await expect(page.getByTestId("preview-banner")).toHaveText("Preview generated from lumen-jewelry.example by GiftFit — not affiliated with lumen-jewelry.example.");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  await expect(page.getByTestId("preview-store-name")).toHaveText("Lumen Fine Jewelry");
  await expect(page.getByTestId("preview-expires")).toContainText("deleted in about 24 h");
  await expect(page.getByTestId("preview-product")).toHaveCount(10);
  expect(await page.locator("form, input[type=password], input[name*=card i]").count()).toBe(0);
  for (const img of await page.locator("[data-testid=preview-grid] img").all()) {
    await expect(img).toHaveAttribute("referrerpolicy", "no-referrer");
    await expect(img).toHaveAttribute("loading", "lazy");
  }
  await expect(page.getByTestId("bookmarklet")).toHaveAttribute("href", /^javascript:/);

  await page.getByTestId("preview-product").first().click();
  await expect(page.getByTestId("preview-pdp")).toBeVisible({ timeout: 30_000 });
  const ld = JSON.parse((await page.locator('script[type="application/ld+json"]').textContent()) ?? "{}");
  expect(ld).toMatchObject({ "@type": "Product", name: "Aria Gold Hoops", sku: "1001", offers: { price: "180.00", priceCurrency: "USD" } });
  const viewOn = page.getByTestId("view-on");
  await expect(viewOn).toHaveAttribute("href", "https://lumen-jewelry.example/products/1001");
  await expect(viewOn).toHaveAttribute("rel", "noopener noreferrer nofollow");
  await expect(viewOn).toHaveText("View on lumen-jewelry.example");
  expect(await page.locator("form").count()).toBe(0);

  expect((await page.goto(`/s/${"Z".repeat(22)}`))?.status()).toBe(404);
  const refused = await seed(request, "jewelry", "refused");
  await page.goto(refused.previewPath);
  await expect(page.getByTestId("preview-reason")).toContainText("fewer than 3 products");
  const crawling = await seed(request, "jewelry", "crawling");
  await page.goto(crawling.previewPath);
  await expect(page.getByTestId("preview-building")).toBeVisible();
  // The widget frame refuses a preview that is not ready.
  await page.goto(`/w?store=preview:${crawling.key}&parent=${encodeURIComponent("https://shop.example")}`);
  await expect(page.getByTestId("widget-not-allowed")).toBeVisible();
});

test("jewelry preview: widget grounded on the preview → hearts-only Fit Request, YouCam refused", async ({ browser, baseURL, request }) => {
  const appOrigin = new URL(baseURL!).origin;
  const s = await seed(request, "jewelry");
  const giver = await browser.newContext({ ...devices["Desktop Chrome"], baseURL, extraHTTPHeaders: { "X-Forwarded-For": "203.0.113.56" } });
  const recipient = await browser.newContext({ ...devices["Pixel 7"], baseURL });
  const leaks = watchLeaks(giver, appOrigin);
  try {
    const g = await giver.newPage();
    await g.goto(`${s.previewPath}/p/1001`);
    const widget = g.locator("giftfit-widget");
    await expect(widget).toHaveAttribute("data-ready", "", { timeout: 60_000 });
    const frame = g.frameLocator("giftfit-widget iframe");
    await expect(frame.getByTestId("widget-tip")).toContainText("Gift this?", { timeout: 30_000 });
    await frame.getByRole("button", { name: "Open the gift assistant" }).click();
    await expect(frame.getByTestId("widget-intro")).toContainText("Aria Gold Hoops");
    const input = frame.getByLabel("Your message");
    await input.fill("Birthday gift for my sister, earrings under $300");
    const concierge = g.waitForRequest((r) => r.url().endsWith("/api/concierge"));
    await input.press("Enter");
    expect((await concierge).postDataJSON()).toMatchObject({ store: `preview:${s.key}` });
    await expect(frame.getByRole("list", { name: "Suggested pieces" })).toBeVisible({ timeout: 30_000 });
    await frame.getByTestId("widget-use-brief").click();
    await expect(frame.getByTestId("widget-no-tryon")).toContainText("Try-on isn't enabled for previews");
    const created = g.waitForResponse((r) => r.url().endsWith("/api/fit/requests") && r.request().method() === "POST");
    await frame.getByTestId("widget-create").click();
    const res = await created;
    expect(res.status()).toBe(201);
    expect(res.request().postDataJSON()).toMatchObject({ storeId: `preview:${s.key}`, mode: "help_me_choose" });
    await expect(frame.getByTestId("widget-card-step")).toBeVisible({ timeout: 30_000 });
    // No try-on for previews: the e-card never promises one (A3, copy accuracy).
    await expect(frame.getByTestId("widget-ecard")).toContainText("No photo is needed");
    await expect(frame.getByTestId("widget-ecard")).not.toContainText(/camera|try a few pieces on/i);
    expect((await res.json()).tryOn).toBe(false);
    const link = await frame.getByTestId("widget-share-link").inputValue();
    const recipientToken = link.split("/").pop()!;

    // Never a YouCam call for a preview request, even if a client tries.
    const capture = await request.post("/api/recipient/capture", { headers: { Authorization: `Bearer ${recipientToken}` }, multipart: { selfie: { name: "s.jpg", mimeType: "image/jpeg", buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) } } });
    expect(capture.status()).toBe(409);
    expect(await capture.json()).toMatchObject({ error: "tryon_disabled_preview" });

    const r = await recipient.newPage();
    await r.goto(new URL(link).pathname);
    await expect(r.getByTestId("no-tryon-consent")).toBeVisible({ timeout: 30_000 });
    await expect(r.getByTestId("gift-header-store")).toHaveText("for Lumen Fine Jewelry");
    await expect(r.getByTestId("consent-screen")).not.toContainText(/Try on \d+ pieces|A private try-on|They will never see your photos/);
    await r.getByTestId("consent-accept").click();
    await expect(r.getByTestId("no-tryon-note")).toBeVisible({ timeout: 30_000 });
    await r.getByTestId("carousel-item").first().getByTestId("heart").click();
    await r.getByTestId("send-hearts").click();
    await expect(r.getByTestId("done-screen")).toBeVisible({ timeout: 30_000 });
    await expect(r.getByTestId("done-screen")).not.toContainText(/photos are deleted/i);

    const reportHref = (await frame.getByTestId("widget-report-link").getAttribute("href"))!;
    const report = await g.request.post("/api/fit/report", { data: { giverToken: reportHref.split("/").pop() } });
    const rep = (await report.json()) as { status: string; tryOn?: boolean; storeName?: string; recipientLabels?: unknown; results: Array<{ breakdown: Record<string, number>; reasons: string[]; caution?: string }>; tasteSummary?: { text: string } };
    expect(rep).toMatchObject({ status: "completed", tryOn: false, storeName: "Lumen Fine Jewelry" });
    expect(rep.recipientLabels).toBeUndefined();
    // No undertone / face-shape factor and no try-on claim anywhere (no photo was ever taken).
    const NO_TRYON = /\b(undertones?|skin|face[- ]?shapes?|faces?|try[- ]?ons?|tried (it |them )?on|selfies?|photos?|estimates?d?|low[- ]confidence)\b/i;
    for (const x of rep.results) {
      expect(Object.keys(x.breakdown).sort()).toEqual(["budgetOccasion", "hearts"]);
      for (const t of [...x.reasons, x.caution ?? ""]) expect(t).not.toMatch(NO_TRYON);
    }
    expect(rep.tasteSummary?.text ?? "").not.toMatch(NO_TRYON);
    await g.goto(new URL(reportHref).pathname);
    await expect(g.getByTestId("fit-report-item").first()).toBeVisible({ timeout: 30_000 });
    await expect(g.getByText("Pieces shown")).toBeVisible();
    await expect(g.getByTestId("gift-header-store")).toHaveText("for Lumen Fine Jewelry");
    await expect(g.getByTestId("disclaimer")).toHaveText("Scores come from their hearts, your budget and the occasion. Not a sizing guarantee.");
    expect(await g.locator("main").innerText()).not.toMatch(/undertone|face shape|try-on|tried on|decoy|Aurum/i);

    // A second gift link from the same preview whose recipient hasn't started yet.
    const second = await g.request.post("/api/fit/requests", { data: { storeId: `preview:${s.key}`, mode: "help_me_choose", occasion: "birthday", budgetMax: 300, currency: "USD", shortlistIds: [], categories: ["earring"] } });
    expect(second.status()).toBe(201);
    const secondLink = ((await second.json()) as { recipientPath: string }).recipientPath;

    // The preview is deleted: the giver's report still names the pieces, with merchant images and links.
    const del = await request.delete("/api/preview/seed", { headers: { Authorization: `Bearer ${process.env.E2E_CRON_SECRET}` }, data: { key: s.key } });
    expect(del.status()).toBe(204);
    await g.goto(new URL(reportHref).pathname);
    await expect(g.getByTestId("fit-report")).toBeVisible({ timeout: 30_000 });
    await expect(g.getByTestId("report-preview-expired")).toContainText("This preview has expired");
    const items = g.getByTestId("fit-report-item");
    expect(await items.count()).toBeGreaterThan(0);
    const names = await items.locator("h3").allTextContents();
    expect(names.every((n) => /Hoops|Studs|Drops|Huggies|Earrings|Teardrops/.test(n))).toBe(true);
    await expect(items.first().getByTestId("report-product-image")).toHaveAttribute("src", new RegExp(`^${appOrigin.replace(/[.:/]/g, "\\$&")}/catalog/`));
    await expect(items.first().getByTestId("buy-button")).toHaveAttribute("rel", "noopener noreferrer nofollow");
    await expect(items.first().getByTestId("buy-button")).toHaveAttribute("href", /^https:\/\/lumen-jewelry\.example\/products\//);
    await expect(g.getByTestId("photos-seen-counter")).toContainText("0");

    // A gift link whose preview is gone: the recipient sees a clear expired-preview state.
    const r2 = await recipient.newPage();
    await r2.goto(secondLink);
    await expect(r2.getByTestId("preview-expired-screen")).toContainText("This preview has expired", { timeout: 30_000 });
    expect(leaks, JSON.stringify(leaks, null, 1)).toEqual([]);
  } finally {
    await giver.close();
    await recipient.close();
  }
});

test("non-jewelry preview: product suggestions only, no gift brief", async ({ page, request, baseURL }) => {
  const s = await seed(request, "generic");
  const leaks = watchLeaks(page.context(), new URL(baseURL!).origin);
  await page.goto(s.previewPath);
  await expect(page.locator("giftfit-widget")).toHaveAttribute("data-ready", "", { timeout: 60_000 });
  const frame = page.frameLocator("giftfit-widget iframe");
  await frame.getByRole("button", { name: "Open the gift assistant" }).click();
  const input = frame.getByLabel("Your message");
  await input.fill("A tea gift for my dad under $50");
  await input.press("Enter");
  const picks = frame.getByTestId("widget-product-suggestions");
  await expect(picks).toBeVisible({ timeout: 30_000 });
  await expect(picks.getByRole("link", { name: "View product" }).first()).toHaveAttribute("href", /^https:\/\/teahouse\.example\/products\//);
  await expect(frame.getByTestId("widget-use-brief")).toHaveCount(0);
  expect(leaks).toEqual([]);
});

test("Admin v0: #t= owner link → scoped cookie, ?t= never accepted, 403 otherwise, remove product, settings applied by the widget", async ({ browser, baseURL, request }) => {
  const s = await seed(request, "jewelry");
  const ctx = await browser.newContext({ baseURL });
  const page = await ctx.newPage();
  try {
    const denied = await page.goto(`/admin/${s.key}`);
    expect(denied?.status()).toBe(403);
    await expect(page.getByTestId("admin-forbidden")).toBeVisible();
    expect((await page.goto(`/admin/${s.key}?t=${"x".repeat(43)}`))?.status()).toBe(403);
    // Even the real token is refused in the query string (it would reach request logs / Referer).
    const ownerToken = new URL(s.ownerPath, baseURL).hash.replace(/^#t=/, "");
    expect(ownerToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await page.goto(`/admin/${s.key}?t=${ownerToken}`))?.status()).toBe(403);
    expect((await ctx.cookies()).find((c) => c.name === "gf_owner")).toBeUndefined();

    await page.goto(s.ownerPath);
    await expect(page).toHaveURL(new RegExp(`/admin/${s.key}$`));
    await expect(page.getByTestId("preview-admin")).toBeVisible({ timeout: 30_000 });
    const cookie = (await ctx.cookies()).find((c) => c.name === "gf_owner")!;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Strict", path: `/admin/${s.key}` });
    expect(await page.content()).not.toContain(cookie.value);
    await expect(page.getByTestId("admin-snippet")).toHaveText(new RegExp(`data-store="preview:${s.key}"`));

    // Remove a product: it leaves the preview store.
    await page.getByTestId("admin-product").nth(1).getByTestId("admin-remove").click();
    await expect(page.getByTestId("admin-message")).toContainText("Product removed", { timeout: 30_000 });
    const store = await ctx.newPage();
    await store.goto(s.previewPath);
    await expect(store.getByTestId("preview-product")).toHaveCount(9, { timeout: 30_000 });

    // Settings: a too-light accent is refused; valid settings reach the widget.
    await page.getByTestId("admin-accent").fill("#ffff00");
    await page.getByTestId("admin-save").click();
    await expect(page.getByTestId("admin-error")).toContainText("too light", { timeout: 30_000 });
    await page.getByTestId("admin-character-mascot").check();
    await page.getByTestId("admin-lang-en").uncheck();
    await page.getByTestId("admin-default-lang").selectOption("vi");
    await page.getByTestId("admin-accent").fill("#1f6f5c");
    await page.getByTestId("admin-greeting").fill("Chào bạn! Mình giúp bạn chọn quà nhé.");
    await page.getByTestId("admin-save").click();
    await expect(page.getByTestId("admin-message")).toContainText("Settings saved", { timeout: 30_000 });

    const w = await ctx.newPage();
    await w.goto(`/w?store=preview:${s.key}`);
    await expect(w.getByTestId("widget-intro")).toHaveText("Chào bạn! Mình giúp bạn chọn quà nhé.", { timeout: 30_000 });
    await expect(w.locator("header[data-accent='#1f6f5c']")).toHaveCount(1);
    await expect(w.getByRole("button", { name: "Gửi" })).toBeVisible();

    // A fresh browser opens it from the owner link (#t= fragment) alone.
    const ctx2 = await browser.newContext({ baseURL });
    const p2 = await ctx2.newPage();
    await p2.goto(s.ownerPath);
    await expect(p2.getByTestId("preview-admin")).toBeVisible({ timeout: 30_000 });
    await ctx2.close();
  } finally {
    await ctx.close();
  }
});

test("bookmarklet: injects exactly one script on a merchant page; a strict CSP gets a friendly notice", async ({ page, request }) => {
  const s = await seed(request, "jewelry");
  await page.goto(s.previewPath);
  const href = (await page.getByTestId("bookmarklet").getAttribute("href"))!;
  const source = decodeURIComponent(href.slice("javascript:".length));

  await page.goto(`${HOST}/`);
  await page.evaluate(source);
  await page.evaluate(source); // a second click must not add another script
  await expect(page.locator('script[src$="/giftfit.js"]')).toHaveCount(1);
  await expect(page.locator('script[src$="/giftfit.js"]')).toHaveAttribute("data-store", `preview:${s.key}`);
  await expect(page.locator("giftfit-widget")).toHaveAttribute("data-ready", "", { timeout: 60_000 });

  await page.goto(`${HOST}/strict`);
  await page.evaluate(source);
  const note = page.locator("#giftfit-bookmarklet-note");
  await expect(note).toBeVisible({ timeout: 15_000 });
  await expect(note.getByRole("link", { name: "Open your preview store" })).toHaveAttribute("href", new RegExp(`/s/${s.key}$`));
  await expect(page.locator("giftfit-widget")).toHaveCount(0);
});

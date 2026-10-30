/**
 * The GiftFit home and the single storefront (owner: A6, P8.2b).
 *
 * The main origin is the GiftFit home; the only store is the demo store (a second origin, here
 * 127.0.0.1:4340, which playwright.config.ts passes to the app as GIFTFIT_DEMO_STORE_URL).
 *   - / renders the landing (en/vi), CTAs, the snippet, the judge-demo link and credits, and, after the
 *     code window's Run, the widget launcher (no product, so no "Gift this?" tip; more in landing.spec.ts);
 *   - old storefront paths answer 308 to the demo store, and every Aurum design lands on a real page;
 *   - the seeded judge demo still runs /demo → /r/… → /g/….
 */
import { expect, test } from "@playwright/test";
import rawCatalog from "../../../data/aurum/catalog.json";
import { startDemoStore, type DemoStore } from "../support/demo-store";

const STORE_PORT = 4340;
const STORE = `http://127.0.0.1:${STORE_PORT}`;
const catalog = rawCatalog as unknown as Array<{ id: string; attributes: { sku: string; slug: string } }>;
let store: DemoStore | undefined;

// The home page loads the Live2D character (WebGL); generous timeouts for a busy CI host.
test.describe.configure({ mode: "serial", timeout: 120_000 });

test.beforeAll(async ({ baseURL }) => {
  store = await startDemoStore(STORE_PORT, new URL(baseURL!).origin);
});
test.afterAll(() => store?.stop());

test("/ is the GiftFit home: what it is, 3 steps, CTAs, snippet, judge demo, credits, and the assistant on Run", async ({ page, baseURL }) => {
  const appOrigin = new URL(baseURL!).origin;
  const res = await page.goto("/");
  expect(res?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("The gift assistant for any store");
  await expect(page.getByTestId("how-steps").locator("li")).toHaveCount(3);
  await expect(page.getByTestId("cta-demo-store")).toHaveAttribute("href", STORE);
  await expect(page.getByTestId("cta-merchants")).toHaveAttribute("href", "/merchants");
  await expect(page.getByTestId("code-snippet")).toHaveText(`<script src="${appOrigin}/giftfit.js" data-store="aurum" async></script>`);
  await expect(page.getByTestId("link-judge-demo")).toHaveAttribute("href", "/demo");
  await expect(page.getByTestId("site-credits")).toContainText("Live2D Inc.");
  await expect(page.getByTestId("site-credits")).toContainText("Open RAIL-M");
  await expect(page.getByTestId("ai-note")).toContainText("AI-generated");
  // Nothing of the old storefront is left on the home page.
  expect(await page.content()).not.toMatch(/Add to bag|Shop the Halo Drop|href="\/p\/|href="\/c\//);

  // The landing loads no widget until Run (P8.4); then Mark-kun greets from the app's own origin, with no product tip.
  await expect(page.locator("giftfit-widget")).toHaveCount(0);
  await page.getByTestId("code-run").click();
  const host = page.locator("giftfit-widget");
  await expect(host).toHaveAttribute("data-ready", "", { timeout: 60_000 });
  await page.waitForTimeout(1500);
  await expect(host).toHaveAttribute("data-mode", "launcher");
  await expect(page.frameLocator("giftfit-widget iframe").getByTestId("widget-tip")).toHaveCount(0);

  // The primary CTA opens the demo store.
  await page.getByTestId("cta-demo-store").click();
  await expect(page).toHaveURL(`${STORE}/`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Fine jewelry, gifted right");
});

test("Vietnamese by ?lang=vi or Accept-Language; merchants placeholder", async ({ page, browser, baseURL }) => {
  await page.goto("/?lang=vi");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Trợ lý quà tặng cho mọi cửa hàng");
  await expect(page.getByTestId("cta-demo-store")).toHaveText("Mở cửa hàng demo");
  const vi = await browser.newContext({ baseURL, locale: "vi-VN", extraHTTPHeaders: { "Accept-Language": "vi-VN,vi;q=0.9" } });
  const p2 = await vi.newPage();
  await p2.goto("/");
  await expect(p2.getByTestId("cta-merchants")).toHaveText("Dành cho cửa hàng");
  await vi.close();

  await page.goto("/merchants");
  await expect(page.getByTestId("merchants")).toContainText("Add the gift assistant to your store with one script tag");
  await expect(page.getByTestId("site-snippet")).toContainText("/giftfit.js");
});

test("old storefront paths answer 308 to the demo store", async ({ request }) => {
  const halo = catalog.find((s) => s.attributes.slug === "halo-drop-earrings")!;
  const cases: Array<[string, string]> = [
    ["/p/halo-drop-earrings", `${STORE}/p/halo-drop-earrings`],
    [`/p/${halo.id}`, `${STORE}/p/halo-drop-earrings`],
    ["/p/AUR-EAR-028", `${STORE}/p/halo-drop-earrings`],
    ["/p/not-a-design", `${STORE}/`],
    ["/c/rings", `${STORE}/c/rings`],
    ["/c/hats", `${STORE}/`],
    ["/cart", `${STORE}/`],
    ["/plugin-demo/reverie-pear-pendant", `${STORE}/p/reverie-pear-pendant`],
  ];
  for (const [path, location] of cases) {
    const res = await request.get(path, { maxRedirects: 0 });
    expect(res.status(), path).toBe(308);
    expect(res.headers()["location"], path).toBe(location);
  }
  // "/" itself is the home page, not a redirect.
  expect((await request.get("/", { maxRedirects: 0 })).status()).toBe(200);
});

test("every Aurum design and category redirects to a page that exists on the demo store", async ({ request }) => {
  test.setTimeout(120_000);
  const paths = [...catalog.map((s) => `/p/${s.id}`), ...["earrings", "necklaces", "rings", "bracelets", "watches"].map((c) => `/c/${c}`)];
  for (const path of paths) {
    const res = await request.get(path, { maxRedirects: 0 });
    const location = res.headers()["location"];
    expect(location, path).not.toBe(`${STORE}/`);
    const page = await fetch(location);
    expect(page.status, location).toBe(200);
  }
});

test("service routes stay on the main origin; the judge demo still runs /demo → /r → /g", async ({ page, request }) => {
  for (const path of ["/giftfit.js", "/w?store=aurum", "/embed?store=aurum&sku=halo-drop-earrings", "/catalog/aurum/photo/aur-ear-028.jpg", "/api/fit/weights", "/concierge-demo", "/widget-character-demo", "/retailer"]) {
    const res = await request.get(path, { maxRedirects: 0 });
    expect(res.status(), path).toBe(200);
  }
  await page.goto("/demo");
  await page.getByTestId("try-judge-demo").click();
  const r = page.getByTestId("demo-recipient-link");
  await expect(r).toBeVisible({ timeout: 30_000 });
  const recipientPath = (await r.getAttribute("href"))!;
  const giverPath = (await page.getByTestId("demo-giver-link").getAttribute("href"))!;
  expect(recipientPath).toMatch(/^\/r\/[A-Za-z0-9_-]{20,}$/);
  expect(giverPath).toMatch(/^\/g\/[A-Za-z0-9_-]{20,}/);
  await page.goto(recipientPath);
  await expect(page.getByTestId("carousel-item").first()).toBeVisible({ timeout: 30_000 });
  await page.goto(giverPath);
  await expect(page.getByTestId("fit-report")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("photos-seen-counter")).toContainText("0");
});

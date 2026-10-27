/**
 * Two-context end-to-end gift flow through the UI (owner: A8), mock mode, production build.
 *
 * Giver (desktop viewport) creates an "I have ideas" Fit Request from the Halo Drop PDP of the demo store
 * (a second origin, P8.2b: the only storefront) via its "Gift it right" button and the Giver Panel overlay.
 * Recipient (Pixel 7 context, separate cookies) opens /r/<token>, consents, uploads the placeholder
 * selfie through the file fallback, hearts 2 items and finishes. Giver opens /g/<token>.
 *
 * Privacy checks on the giver side:
 *   - every JSON response the giver context receives passes the independent leak scanner;
 *   - the /g/ page has no <img> outside the public catalog, no hex in its text, no try-on URL in its
 *     HTML, and shows "Photos seen by the giver: 0";
 *   - a try-on URL the recipient saw does not open with the giver's cookies.
 */
import { devices, expect, test, type BrowserContext } from "@playwright/test";
import { startDemoStore, type DemoStore } from "../support/demo-store";
import { scanGiverResponse, type Leak } from "../support/giver-leaks";
import { recipientCapture, tryonUrls } from "../support/recipient-ui";

const CATALOG_PREFIXES = ["/catalog/"] as const;
const TRYON_URL = /\/api\/recipient\/tryon|\/api\/youcam\/mock-asset|^data:image|^blob:/i;
const HEX = /#[0-9a-f]{6}(?:[0-9a-f]{2})?(?![0-9a-z])/i;

/** Collects leaks from every JSON response the giver context receives. */
function watchGiver(ctx: BrowserContext): Leak[] {
  const leaks: Leak[] = [];
  ctx.on("response", async (res) => {
    const type = res.headers()["content-type"] ?? "";
    if (!type.includes("json")) return;
    const body = await res.text().catch(() => "");
    for (const l of scanGiverResponse(body, res.headers(), { allowProductImagePrefixes: CATALOG_PREFIXES })) leaks.push({ ...l, path: `${res.url()} ${l.path}` });
  });
  return leaks;
}

test.describe("gift flow: giver and recipient in two contexts", () => {
  test.setTimeout(180_000);
  let store: DemoStore | undefined;
  test.beforeAll(async ({ baseURL }) => {
    store = await startDemoStore(Number(process.env.DEMO_STORE_FLOW_PORT ?? 4351), new URL(baseURL!).origin);
  });
  test.afterAll(() => store?.stop());

  test("giver never receives an image URL, hex value or face attribute", async ({ browser, baseURL }) => {
    const giver = await browser.newContext({ ...devices["Desktop Chrome"], baseURL });
    const recipient = await browser.newContext({ ...devices["Pixel 7"], baseURL });
    const leaks = watchGiver(giver);
    try {
      // 1. Giver: demo-store PDP -> Gift it right (overlay frame on the app origin) -> occasion, budget, a second piece -> send.
      const g = await giver.newPage();
      await g.goto(`${store!.url}/p/halo-drop-earrings`);
      await g.locator("giftfit-button").getByRole("button", { name: "Gift it right" }).click();
      const panel = g.frameLocator("giftfit-overlay iframe");
      await expect(panel.getByRole("dialog")).toBeVisible({ timeout: 60_000 });
      // "Help me choose" is the default (ADR-045); this flow is the giver's own picks.
      await panel.getByTestId("mode-i_have_ideas").check({ force: true });
      await panel.getByTestId("occasion-anniversary").check({ force: true });
      await panel.getByTestId("budget-300").check({ force: true });
      await expect(panel.getByTestId("shortlist").locator("li")).toHaveCount(1);
      const add = panel.getByTestId("add-to-shortlist").first();
      const second = (await add.getAttribute("aria-label"))!.replace(/^Add (.+) to shortlist$/, "$1");
      await add.click();
      await expect(panel.getByTestId("shortlist-count")).toContainText("2 of");
      await panel.getByTestId("send-fit-request").click();
      await expect(panel.getByTestId("fit-request-sent")).toBeVisible({ timeout: 30_000 });
      const recipientLink = await panel.getByTestId("recipient-link").inputValue();
      const reportPath = await panel.getByTestId("giver-report-link").getAttribute("href");
      // The store page itself never sees the links.
      expect(await g.content()).not.toMatch(/\/r\/[A-Za-z0-9_-]{20,}|\/g\/[A-Za-z0-9_-]{20,}/);
      expect(recipientLink).toMatch(/\/r\/[^/]+$/);
      expect(reportPath).toMatch(/^\/g\/[^/]+$/);

      // 2. Recipient: consent, selfie upload, 2 hearts, finish.
      const r = await recipient.newPage();
      await r.goto(new URL(recipientLink).pathname);
      await recipientCapture(r);
      const seen = await tryonUrls(r);
      expect(seen.length).toBeGreaterThan(0);
      await expect(r.getByTestId("carousel-item")).toHaveCount(6);
      // The test (not the giver) knows the shortlist titles, so it hearts exactly those two pieces.
      // Heart buttons name the metal shown ("Heart Halo Drop Earrings, yellow gold", ADR-032): match the prefix.
      for (const title of ["Halo Drop Earrings", second]) await r.getByRole("button", { name: `Heart ${title}` }).first().click();
      await expect(r.getByTestId("send-hearts")).toContainText("(2)");
      await r.getByTestId("send-hearts").click();
      await expect(r.getByTestId("undertone-screen")).toBeVisible({ timeout: 30_000 });
      await r.getByTestId("finish").click();
      await expect(r.getByTestId("done-screen")).toBeVisible({ timeout: 30_000 });
      await expect(r.getByTestId("photos-stored")).toContainText("0");

      // 3. Giver: report page.
      const docRes = await g.goto(reportPath!);
      const html = (await docRes?.text()) ?? "";
      for (const re of [/\/api\/recipient\/tryon/i, /\/api\/youcam\/mock-asset/i, /data:image\//i, /blob\.vercel-storage\.com/i]) expect(html, `giver HTML matches ${re}`).not.toMatch(re);
      await expect(g.getByTestId("fit-report")).toBeVisible({ timeout: 30_000 });
      await expect(g.getByTestId("photos-seen-counter")).toContainText("Photos seen by the giver: 0");
      await expect(g.getByTestId("fit-report-item").first()).toBeVisible();
      await expect(g.getByTestId("hearted-badge")).toHaveCount(2);
      await expect(g.getByTestId("hearted-count")).toHaveText("2");
      const imgs = await g.locator("img").evaluateAll((els) => els.map((e) => (e as HTMLImageElement).currentSrc || e.getAttribute("src") || ""));
      for (const src of imgs) {
        expect(src, "recipient image on a giver page").not.toMatch(TRYON_URL);
        const u = new URL(src, baseURL);
        const inner = u.pathname === "/_next/image" ? (u.searchParams.get("url") ?? "") : u.pathname;
        expect(CATALOG_PREFIXES.some((p) => inner.startsWith(p)), `non-catalog <img> on giver page: ${src}`).toBe(true);
      }
      expect(await g.locator("body").innerText()).not.toMatch(HEX);
      expect(await g.locator("picture, video, canvas").count()).toBe(0);

      // 4. A try-on URL the recipient saw does not open with the giver's cookies.
      for (const u of seen.slice(0, 2)) expect((await giver.request.get(u)).status()).toBeGreaterThanOrEqual(400);

      expect(leaks, JSON.stringify(leaks, null, 1)).toEqual([]);
    } finally {
      await giver.close();
      await recipient.close();
    }
  });
});

/**
 * Script tag on a static cross-origin page (owner: A6; A8 granted tests/e2e/plugin/).
 *
 * Starts packages/plugin/demo/serve-host.mjs on 127.0.0.1:4310 (a different origin from the app),
 * loads a framework-free product page with one <script src="<app>/giftfit.js"> tag and checks:
 *   - the "Gift it right" button is injected (shadow root) and keeps its own styles against hostile host CSS;
 *   - clicking opens the Giver Panel in an iframe served by the app origin;
 *   - a Fit Request can be sent from inside the iframe, and the host only receives a bare
 *     "giftfit:sent" event (no token, no id);
 *   - closing the panel removes the overlay;
 *   - a product that is not in the catalog gets no button.
 * Also checks that the old same-origin demo PDP (/plugin-demo/<slug>) now 308s to the demo store's page.
 *
 * Needs a project matching plugin/** in playwright.config.ts (A8), e.g.
 *   { name: "plugin", testMatch: "plugin/**\/*.spec.ts", use: { ...devices["Desktop Chrome"] } }
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { expect, test } from "@playwright/test";

const HOST_PORT = Number(process.env.PLUGIN_HOST_PORT ?? 4310);
const HOST = `http://127.0.0.1:${HOST_PORT}`;
let server: ChildProcess | undefined;

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ baseURL }) => {
  server = spawn(process.execPath, [path.join("packages", "plugin", "demo", "serve-host.mjs"), String(HOST_PORT)], {
    env: { ...process.env, GIFTFIT_ORIGIN: new URL(baseURL!).origin },
    stdio: "ignore",
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(HOST)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("plugin host did not start");
});

test.afterAll(() => {
  server?.kill();
});

test("script tag adds Gift it right on a cross-origin product page and opens the Giver Panel", async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const appOrigin = new URL(baseURL!).origin;
  expect(new URL(HOST).origin).not.toBe(appOrigin);

  await page.goto(HOST);
  const button = page.getByRole("button", { name: "Gift it right" });
  await expect(button).toBeVisible({ timeout: 30_000 });
  // Host CSS paints every button blue and uppercase; ours stays the dark pill.
  const look = await button.evaluate((el) => {
    const s = getComputedStyle(el);
    return { bg: s.backgroundColor, transform: s.textTransform };
  });
  expect(look).toEqual({ bg: "rgb(31, 26, 23)", transform: "none" });

  await button.click();
  const frameEl = page.locator("giftfit-overlay iframe");
  await expect(frameEl).toHaveAttribute("src", new RegExp(`^${appOrigin.replace(/[.:/]/g, "\\$&")}/embed\\?`));
  const frame = page.frameLocator("giftfit-overlay iframe");
  await expect(frame.getByRole("dialog")).toBeVisible({ timeout: 60_000 });
  // "Help me choose" is the default (ADR-045); the product page's piece is the giver's pick.
  await frame.getByTestId("mode-i_have_ideas").check({ force: true });
  await expect(frame.getByTestId("shortlist")).toContainText("Halo Drop");

  await frame.getByTestId("occasion-anniversary").check({ force: true });
  await frame.getByTestId("budget-300").check({ force: true });
  await frame.getByTestId("send-fit-request").click();
  await expect(frame.getByTestId("fit-request-sent")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("host-events")).toContainText("giftfit:sent");
  // The host page never sees the link or tokens.
  expect(await page.content()).not.toMatch(/\/r\/[A-Za-z0-9_-]{20,}|\/g\/[A-Za-z0-9_-]{20,}/);

  await page.keyboard.press("Escape");
  await expect(page.locator("giftfit-overlay")).toHaveCount(0);
  await expect(page.getByTestId("host-events")).toContainText("giftfit:close");
});

test("no button when the product is not in the catalog", async ({ page }) => {
  const lookup = page.waitForResponse((r) => r.url().includes("/api/retailer/lookup"));
  await page.goto(`${HOST}/?sku=NOT-A-SKU&name=Unknown%20Thing`);
  expect(await (await lookup).json()).toMatchObject({ found: false });
  await expect(page.locator("giftfit-button")).toHaveCount(0);
});

test("the old /plugin-demo PDP redirects (308) to the demo store's page for that design", async ({ request }) => {
  const res = await request.get("/plugin-demo/halo-drop-earrings", { maxRedirects: 0 });
  expect(res.status()).toBe(308);
  expect(res.headers()["location"]).toMatch(/\/p\/halo-drop-earrings$/);
});

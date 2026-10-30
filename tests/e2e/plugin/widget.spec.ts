/**
 * Embeddable gift assistant on a second origin (owner: A6, ADR-046).
 *
 * Starts the demo store (server/demo-store/server.mjs) on 127.0.0.1:4320, a different origin from the app,
 * whose product pages carry JSON-LD for real Aurum items and one <script src="<app>/giftfit.js"> tag:
 *   launcher appears (shadow root + iframe, immune to the store's CSS) → "Gift this?" tip → panel →
 *   Gift Concierge in mock mode (keyless fixture replay) → brief → Fit Request → themed e-card,
 *   copy/QR/WhatsApp/Messenger/Zalo, "Send by email" (console provider), "notify me".
 * The host page only ever receives giftfit:sent / giftfit:close, never a link or token.
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { scanGiverResponse } from "../support/giver-leaks";

const STORE_PORT = Number(process.env.DEMO_STORE_PORT ?? 4320);
const STORE = `http://127.0.0.1:${STORE_PORT}`;
const EXAMPLE = "Anniversary gift for my wife. She loves minimal, delicate pieces and mostly wears gold. Budget around $300.";
let server: ChildProcess | undefined;

test.describe.configure({ mode: "serial" });
// Own rate-limit bucket (the app trusts the last X-Forwarded-For hop), so other specs' requests don't count.
test.use({ extraHTTPHeaders: { "X-Forwarded-For": "203.0.113.46" } });

test.beforeAll(async ({ baseURL }) => {
  server = spawn(process.execPath, [path.join("server", "demo-store", "server.mjs")], {
    env: { ...process.env, GIFTFIT_ORIGIN: new URL(baseURL!).origin, PORT: String(STORE_PORT), HOST: "127.0.0.1" },
    stdio: "ignore",
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(STORE)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("demo store did not start");
});

test.afterAll(() => {
  server?.kill();
});

function watchLeaks(page: Page): string[] {
  const leaks: string[] = [];
  page.on("response", async (res) => {
    const url = res.url();
    if (!/\/api\/(widget|concierge|fit\/requests)/.test(url)) return;
    const body = await res.text().catch(() => "");
    for (const line of body.split("\n").filter(Boolean)) {
      for (const l of scanGiverResponse(line, res.headers(), { allowProductImagePrefixes: ["/catalog/"] })) leaks.push(`${url} ${l.kind} ${l.path} ${l.detail}`);
    }
  });
  return leaks;
}

test("demo store PDP: launcher → Gift this? → Concierge → brief → Fit Request → e-card and share", async ({ page, baseURL }) => {
  test.setTimeout(150_000);
  const appOrigin = new URL(baseURL!).origin;
  expect(new URL(STORE).origin).not.toBe(appOrigin);
  const leaks = watchLeaks(page);
  // The window size the demo video is recorded at: the panel is 680 px tall, so the card step scrolls.
  await page.setViewportSize({ width: 1280, height: 720 });

  await page.goto(`${STORE}/p/halo-drop-earrings`);
  const host = page.locator("giftfit-widget");
  await expect(host).toHaveAttribute("data-ready", "", { timeout: 60_000 });
  const iframe = host.locator("iframe");
  await expect(iframe).toHaveAttribute("src", new RegExp(`^${appOrigin.replace(/[.:/]/g, "\\$&")}/w\\?`));
  // The store paints every iframe with a red border; ours lives in a shadow root and keeps none.
  expect(await iframe.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe("0px");

  const frame = page.frameLocator("giftfit-widget iframe");
  await expect(frame.getByTestId("widget-tip")).toContainText("Gift this?", { timeout: 30_000 });
  await expect(host).toHaveAttribute("data-mode", "tip");

  await frame.getByRole("button", { name: "Open the gift assistant" }).click();
  await expect(host).toHaveAttribute("data-mode", "panel");
  await expect(frame.getByTestId("widget-intro")).toContainText("Halo Drop Earrings");

  const input = frame.getByLabel("Your message");
  await input.fill(EXAMPLE);
  await input.press("Enter");
  await expect(frame.getByRole("list", { name: "Suggested pieces" })).toBeVisible({ timeout: 30_000 });
  await frame.getByTestId("widget-use-brief").click();

  await expect(frame.getByTestId("widget-brief")).toContainText("Up to $300");
  // On a matched PDP the giver may gift this piece instead ("I have ideas"); default stays Help me choose.
  await expect(frame.getByTestId("widget-mode-ideas")).toBeVisible();
  await expect(frame.getByTestId("widget-mode-help")).toBeChecked();
  const created = page.waitForResponse((r) => r.url().endsWith("/api/fit/requests") && r.request().method() === "POST");
  await frame.getByTestId("widget-create").click();
  const createdRes = await created;
  expect(createdRes.status()).toBe(201);
  expect(createdRes.request().postDataJSON()).toMatchObject({ mode: "help_me_choose", occasion: "anniversary", budgetMax: 300 });

  await expect(frame.getByTestId("widget-card-step")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("host-events")).toContainText("giftfit:sent");

  const ecard = frame.getByTestId("widget-ecard");
  await expect(ecard).toHaveAttribute("data-occasion", "anniversary");
  await expect(ecard).toContainText("Happy anniversary");
  // The e-card keeps its natural height (it used to collapse to its 6 px border) and the step scrolls.
  expect((await ecard.boundingBox())!.height).toBeGreaterThan(150);
  // Occasion-aware default message until the giver edits it.
  await expect(frame.getByTestId("widget-card-message")).toHaveValue("Happy anniversary, love. Pick the ones you like!");
  await frame.getByTestId("widget-card-message").fill("Pick the ones you love!");
  await expect(ecard).toContainText("Pick the ones you love!");
  await frame.getByTestId("widget-card-lang").selectOption("vi");
  await expect(ecard).toContainText("Chúc mừng kỷ niệm");

  const link = await frame.getByTestId("widget-share-link").inputValue();
  expect(link).toMatch(new RegExp(`^${appOrigin.replace(/[.:/]/g, "\\$&")}/r/[A-Za-z0-9_-]{40,}$`));
  const wa = await frame.getByTestId("widget-share-whatsapp").getAttribute("href");
  expect(wa).toMatch(/^https:\/\/wa\.me\/\?text=/);
  expect(decodeURIComponent(wa!.split("text=")[1])).toContain(link);
  expect(decodeURIComponent(wa!.split("text=")[1])).toContain("Pick the ones you love!");
  expect(await frame.getByTestId("widget-share-messenger").getAttribute("href")).toBe(`fb-messenger://share/?link=${encodeURIComponent(link)}`);
  await expect(frame.getByTestId("widget-share-zalo")).toBeVisible();
  await frame.getByRole("button", { name: "QR code" }).click();
  await expect(frame.getByTestId("qr-code")).toBeVisible();
  await expect(frame.getByTestId("widget-report-link")).toHaveAttribute("href", /\/g\/[A-Za-z0-9_-]{40,}$/);

  // Send by email: the console provider answers (EMAIL_SEND_ENABLED off / mock mode), nothing is sent.
  await frame.getByTestId("widget-email-to").fill("recipient@example.com");
  const sent = page.waitForResponse((r) => r.url().endsWith("/api/widget/send-card"));
  await frame.getByTestId("widget-email-send").click();
  expect((await sent).status()).toBe(200);
  await expect(frame.getByTestId("widget-email-result")).toContainText("switched off");

  await frame.getByTestId("widget-notify-email").fill("giver@example.com");
  await frame.getByTestId("widget-notify-save").click();
  await expect(frame.getByTestId("widget-notify-result")).toContainText("We'll email you once");

  // The host page never sees a gift link, a token or an address.
  const hostHtml = await page.content();
  expect(hostHtml).not.toMatch(/\/r\/[A-Za-z0-9_-]{20,}|\/g\/[A-Za-z0-9_-]{20,}|recipient@example\.com|giver@example\.com/);

  await frame.getByTestId("widget-close").click();
  await expect(host).toHaveAttribute("data-mode", "launcher");
  await expect(page.getByTestId("host-events")).toContainText("giftfit:close");
  expect(leaks).toEqual([]);
});

test("Vietnamese product page: the widget speaks Vietnamese; a non-product page gets no tip", async ({ page }) => {
  await page.goto(`${STORE}/p/reverie-pear-pendant`);
  const frame = page.frameLocator("giftfit-widget iframe");
  await expect(frame.getByTestId("widget-tip")).toContainText("Tặng món này?", { timeout: 60_000 });
  await frame.getByRole("button", { name: "Mở trợ lý quà tặng" }).click();
  await expect(frame.getByTestId("widget-intro")).toContainText("Reverie Pear Pendant");
  await expect(frame.getByRole("button", { name: "Tặng món này" })).toBeVisible();

  await page.goto(`${STORE}/about`);
  await expect(page.locator("giftfit-widget")).toHaveAttribute("data-ready", "", { timeout: 60_000 });
  await page.waitForTimeout(1500);
  await expect(page.locator("giftfit-widget")).toHaveAttribute("data-mode", "launcher");
  await expect(page.frameLocator("giftfit-widget iframe").getByTestId("widget-tip")).toHaveCount(0);
});

test("the widget frame refuses a parent that is not an exact origin", async ({ page }) => {
  await page.goto(`/w?store=aurum&parent=${encodeURIComponent("https://evil.example/path")}`);
  await expect(page.getByTestId("widget-not-allowed")).toBeVisible();
  const res = await page.request.get("/w?store=aurum");
  expect(res.headers()["content-security-policy"]).toMatch(/frame-ancestors/);
  expect(res.headers()["x-frame-options"]).toBeUndefined();
});

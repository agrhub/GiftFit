/**
 * The P8.4 landing (owner: A4, ADR-055): Run mounts the real widget, phone widths never scroll
 * sideways, Quick start tabs, and the store-URL preview form against its in-memory mock
 * (`?previewmock=1`, no site is contacted).
 */
import { expect, test, type Page } from "@playwright/test";

// Run loads the Live2D character (WebGL); generous timeouts for a busy CI host.
test.describe.configure({ timeout: 120_000 });

async function noSideScroll(page: Page) {
  return page.evaluate(() => ({ scroll: document.scrollingElement!.scrollWidth, inner: window.innerWidth }));
}

test("Run mounts giftfit.js once; the launcher appears (Mark-kun or the SVG mascot); Run again opens the chat", async ({ page, baseURL }) => {
  await page.goto("/");
  await expect(page.locator('script[src$="/giftfit.js"]')).toHaveCount(0);
  await expect(page.locator("giftfit-widget")).toHaveCount(0);

  await page.getByTestId("code-run").click();
  await expect(page.locator('script[src$="/giftfit.js"]')).toHaveCount(1);
  await expect(page.locator('script[src$="/giftfit.js"]')).toHaveAttribute("src", `${new URL(baseURL!).origin}/giftfit.js`);
  const host = page.locator("giftfit-widget");
  await expect(host).toHaveAttribute("data-ready", "", { timeout: 60_000 });
  await expect(page.getByTestId("code-run-status")).toContainText("Mark-kun is here");
  const frame = page.frameLocator("giftfit-widget iframe");
  await expect(frame.getByTestId("live2d-canvas").or(frame.getByTestId("mascot-art")).first()).toBeVisible({ timeout: 30_000 });
  // The widget's frame stays transparent on the dark page: the dark scheme is scoped to the landing's subtree.
  expect(await page.evaluate(() => getComputedStyle(document.querySelector("giftfit-widget")!).colorScheme)).not.toContain("dark");
  expect(await page.evaluate(() => document.querySelector('meta[name="color-scheme"]')?.getAttribute("content") ?? "")).not.toContain("dark");
  // Bottom-right corner.
  const box = (await host.boundingBox())!;
  const vp = page.viewportSize()!;
  expect(box.x + box.width).toBeGreaterThan(vp.width - 40);
  expect(box.y + box.height).toBeGreaterThan(vp.height - 40);

  await page.getByTestId("code-run").click();
  await expect(host).toHaveAttribute("data-mode", "panel", { timeout: 15_000 });
  await expect(page.locator('script[src$="/giftfit.js"]')).toHaveCount(1);
  await expect(page.getByTestId("code-run-status")).toHaveText("Chat opened in the bottom-right corner.");
});

for (const width of [320, 375, 390]) {
  test(`phone ${width} px: no horizontal overflow (en + vi), tap targets ≥ 44 px`, async ({ page, browser, baseURL }) => {
    await page.setViewportSize({ width, height: 800 });
    // The site's language comes from the browser (Accept-Language): English here, Vietnamese in `vi`.
    const vi = await (await browser.newContext({ baseURL, viewport: { width, height: 800 }, extraHTTPHeaders: { "Accept-Language": "vi-VN,vi;q=0.9" } })).newPage();
    for (const [p, path] of [[page, "/"], [vi, "/"], [page, "/merchants"], [vi, "/merchants"]] as const) {
      await p.goto(path);
      const { scroll, inner } = await noSideScroll(p);
      expect(scroll, path).toBeLessThanOrEqual(inner);
    }
    await vi.context().close();
    await page.goto("/");
    // Every visible button and link in the landing is at least 44 px tall (inline text links excepted).
    const small = await page.getByTestId("landing").evaluate((root) =>
      [...root.querySelectorAll<HTMLElement>("button, a.inline-flex, [role=tab]")]
        .filter((el) => el.offsetParent !== null)
        .map((el) => ({ h: el.getBoundingClientRect().height, t: el.textContent?.trim().slice(0, 30) }))
        .filter((x) => x.h < 44),
    );
    expect(small).toEqual([]);
  });
}

test("Quick start tabs switch panels; the code scrolls inside its own box", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/");
  await page.getByRole("tab", { name: "Shopify" }).click();
  await expect(page.getByTestId("docs-panel-shopify")).toBeVisible();
  await expect(page.getByTestId("docs-panel-html")).toBeHidden();
  // Shopify themes set <html lang> to the store's language, which the widget reads: no data-lang needed.
  await expect(page.getByTestId("docs-code-shopify")).toContainText('data-store="aurum"');
  await expect(page.getByTestId("docs-code-shopify")).toContainText("</body>");
  await expect(page.getByTestId("docs-code-shopify")).not.toContainText("data-lang");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("docs-panel-woo")).toBeVisible();
  const pre = await page.getByTestId("docs-code-woo").evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, ox: getComputedStyle(el).overflowX }));
  expect(pre.ox).toBe("auto");
  expect(pre.sw).toBeGreaterThan(pre.cw);
  expect((await noSideScroll(page)).scroll).toBeLessThanOrEqual(375);
});

test("store-URL preview (?previewmock=1): validation, progress, ready with Open and Manage", async ({ page }) => {
  await page.goto("/?previewmock=1");
  await page.getByTestId("cta-try").click();
  await expect(page.locator("#try")).toBeInViewport();
  await page.getByTestId("preview-url").fill("http://shop.example.com");
  await page.getByTestId("preview-submit").click();
  await expect(page.getByTestId("preview-error")).toContainText("https://");
  await page.getByTestId("preview-url").fill("https://shop.example.com");
  await page.getByTestId("preview-submit").click();
  await expect(page.getByTestId("preview-ready")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("preview-progress")).toHaveText("Your preview is ready: 12 products.");
  await expect(page.getByTestId("preview-open")).toHaveAttribute("href", /^\/s\/mock/);
  await expect(page.getByTestId("preview-manage")).toHaveAttribute("href", /^\/s\/mock.+\/admin/);
  await expect(page.getByTestId("preview-owner-note")).toContainText("shown only once");

  await page.getByTestId("preview-url").fill("https://few.example");
  await page.getByTestId("preview-submit").click();
  // The refusal arrives through the same polling as "ready", so it gets the same time.
  await expect(page.getByTestId("preview-refused")).toContainText("at least 3", { timeout: 15_000 });
});

test("prefers-reduced-motion: the landing switches its motion off", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ baseURL, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.goto("/");
  await expect(page.getByTestId("landing")).toHaveAttribute("data-motion", "reduce");
  await expect(page.getByTestId("landing")).toHaveClass(/gf-motion-reduce/);
  expect(await page.locator(".gf-gradient-text").first().evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  await ctx.close();
});

test("/merchants: three paths, preview and console links, GiftFitPreviewBot facts and opt-out", async ({ page, browser, baseURL }) => {
  await page.goto("/merchants");
  await expect(page.getByTestId("merchant-paths").locator("li")).toHaveCount(3);
  await expect(page.getByTestId("merchants-preview")).toHaveAttribute("href", "/#try");
  await expect(page.getByTestId("merchants-console")).toHaveAttribute("href", "/retailer");
  const bot = page.getByTestId("merchants-bot");
  await expect(page.getByTestId("bot-ua")).toHaveText(/^GiftFitPreviewBot\/1\.0 \(\+https:\/\/.+\/merchants\)$/);
  await expect(bot).toContainText("30 requests per preview");
  await expect(bot).toContainText("deleted after 24 hours");
  await expect(page.getByTestId("bot-robots")).toHaveText(["User-agent: GiftFitPreviewBot", "Disallow: /"].join("\n"));
  await expect(page.getByTestId("bot-contact")).toHaveAttribute("href", "https://github.com/agrhub/GiftFit/issues");
  // A Vietnamese browser: the page follows navigator.language too, not only the Accept-Language header.
  const vi = await (await browser.newContext({ baseURL, locale: "vi-VN", extraHTTPHeaders: { "Accept-Language": "vi-VN,vi;q=0.9" } })).newPage();
  await vi.goto("/merchants");
  await expect(vi.getByTestId("merchants-bot")).toContainText("Để từ chối");
  await expect(vi.getByTestId("merchants-preview")).toHaveAttribute("href", "/#try");
  await vi.context().close();
});

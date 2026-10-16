/** Shared recipient UI steps for the browser e2e specs (owner: A8). */
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page } from "@playwright/test";

const SELFIE = path.join(process.cwd(), "fixtures", "youcam", "images", "placeholder-selfie.png");

/** Consent, selfie via the file fallback, optional hand step skipped, until the try-on carousel shows. */
export async function recipientCapture(page: Page): Promise<void> {
  await expect(page.getByTestId("consent-screen")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("consent-accept").click();
  await page.getByTestId("selfie-input").setInputFiles({ name: "selfie.png", mimeType: "image/png", buffer: readFileSync(SELFIE) });
  await page.getByTestId("use-selfie").click();
  const skipHand = page.getByTestId("skip-hand");
  const tryon = page.getByTestId("tryon-screen");
  await expect(skipHand.or(tryon)).toBeVisible({ timeout: 60_000 });
  if (await skipHand.isVisible()) await skipHand.click();
  await expect(tryon).toBeVisible({ timeout: 60_000 });
}

/**
 * Signed try-on image URLs rendered in the carousel. The try-on screen can show product images
 * first and swap in try-ons a moment later (lazy-loaded step, reload restore), so wait for them.
 */
export async function tryonUrls(page: Page, timeoutMs = 30_000): Promise<string[]> {
  const read = async () =>
    (await page.getByTestId("carousel-item").locator("img").evaluateAll((els) => els.map((e) => e.getAttribute("src") ?? ""))).filter((s) =>
      /\/api\/recipient\/tryon/.test(s),
    );
  await expect.poll(async () => (await read()).length, { timeout: timeoutMs }).toBeGreaterThan(0);
  return read();
}

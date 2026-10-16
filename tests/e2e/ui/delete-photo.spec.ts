/**
 * "Delete my photo now" through the UI (R0, ADR-036 clarified), mock mode, production build.
 * After one tap: every face-derived image the recipient saw (try-on renders) no longer resolves, even
 * with the recipient's own session cookie; the carousel shows product photos only; picks are kept.
 */
import { devices, expect, test } from "@playwright/test";
import { recipientCapture, tryonUrls } from "../support/recipient-ui";

const SHORTLIST = [
  "dca42809-a2e1-5b50-8339-240170c69845", // Halo Drop Earrings (AUR-EAR-028)
  "74066662-deab-5925-b51f-4f39e11da0e3", // Reverie Pear Pendant (AUR-NEC-037)
];

test.describe("recipient deletes their photos mid-flow", () => {
  test.setTimeout(150_000);

  test("every try-on image is gone after one tap; picks stay", async ({ browser, baseURL, request }) => {
    const created = await request.post("/api/fit/requests", {
      data: { occasion: "birthday", budgetMax: 300, currency: "USD", shortlistIds: SHORTLIST },
    });
    expect(created.status()).toBe(201);
    const { recipientPath } = (await created.json()) as { recipientPath: string };

    const ctx = await browser.newContext({ ...devices["Pixel 7"], baseURL });
    try {
      const r = await ctx.newPage();
      await r.goto(recipientPath);
      await recipientCapture(r);
      const seen = await tryonUrls(r);
      expect(seen.length).toBeGreaterThan(0);
      expect((await ctx.request.get(seen[0])).status()).toBe(200);

      const del = r.getByTestId("delete-photo-now");
      await expect(del).toBeVisible();
      const call = r.waitForResponse((res) => res.url().endsWith("/api/recipient/delete-photo"));
      await del.click();
      expect((await call).status()).toBe(200);
      // The note is shown and also announced via an aria-live region, so it appears twice.
      await expect(r.getByText("Your photos are deleted. Your picks are saved.").first()).toBeVisible({ timeout: 30_000 });

      // No face-derived image resolves any more, even with the recipient's own cookie.
      for (const u of seen) expect((await ctx.request.get(u)).status(), u).toBeGreaterThanOrEqual(400);

      // The page holds no try-on image, before and after a reload.
      const tryonSrcs = async () =>
        (await r.getByTestId("carousel-item").locator("img").evaluateAll((els) => els.map((e) => e.getAttribute("src") ?? ""))).filter((s) =>
          /\/api\/recipient\/tryon/.test(s),
        );
      await expect.poll(tryonSrcs).toEqual([]);
      await r.reload();
      await expect(r.getByTestId("carousel-item").first()).toBeVisible({ timeout: 30_000 });
      await expect.poll(tryonSrcs).toEqual([]);
    } finally {
      await ctx.close();
    }
  });
});

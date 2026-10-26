/**
 * "Help me choose" (ADR-045), the Giver Panel's default path, through the UI in mock mode (A3).
 * Giver: PDP → Gift it right → occasion, budget cap, two kinds of piece → send (no shortlist).
 * Recipient: consent, selfie, 6 curated pieces, hearts two, finishes.
 * Giver: the report shows the taste summary and "Not tried on" picks, with no image elements, no
 * hex, and every JSON response passes the independent leak scanner.
 */
import { devices, expect, test } from "@playwright/test";
import { scanGiverResponse, type Leak } from "../support/giver-leaks";
import { recipientCapture } from "../support/recipient-ui";

const HEX = /#[0-9a-f]{6}(?:[0-9a-f]{2})?(?![0-9a-z])/i;

test.describe("help me choose: giver, recipient, report", () => {
  test.setTimeout(180_000);

  test("curated request → hearts → taste summary and not-tried picks", async ({ browser, baseURL }) => {
    const giver = await browser.newContext({ ...devices["Desktop Chrome"], baseURL });
    const recipient = await browser.newContext({ ...devices["Pixel 7"], baseURL });
    const leaks: Leak[] = [];
    giver.on("response", async (res) => {
      if (!(res.headers()["content-type"] ?? "").includes("json")) return;
      const body = await res.text().catch(() => "");
      for (const l of scanGiverResponse(body, res.headers(), { allowProductImagePrefixes: ["/catalog/"] })) leaks.push({ ...l, path: `${res.url()} ${l.path}` });
    });
    try {
      const g = await giver.newPage();
      await g.goto("/p/halo-drop-earrings");
      await g.getByTestId("gift-it-right").first().click();
      await expect(g.getByTestId("mode-help_me_choose")).toBeChecked();
      await expect(g.getByTestId("shortlist")).toHaveCount(0);
      await g.locator("label", { has: g.getByTestId("occasion-birthday") }).click();
      await g.locator("label", { has: g.getByTestId("budget-300") }).click();
      // Earrings and necklaces are the default chips; hand items stay opt-in.
      for (const c of ["earring", "necklace"]) await expect(g.getByTestId(`category-${c}`)).toBeChecked();
      for (const c of ["ring", "bracelet", "watch"]) await expect(g.getByTestId(`category-${c}`)).not.toBeChecked();
      const created = g.waitForResponse((r) => r.url().endsWith("/api/fit/requests") && r.request().method() === "POST");
      await g.getByTestId("send-fit-request").click();
      const createdBody = JSON.parse((await created).request().postData() ?? "{}");
      expect(createdBody).toMatchObject({ mode: "help_me_choose", budgetMax: 300, categories: ["earring", "necklace"] });
      await expect(g.getByTestId("fit-request-sent")).toBeVisible({ timeout: 30_000 });
      await expect(g.getByTestId("curated-note")).toContainText("6 pieces picked by GiftFit");
      const recipientLink = await g.getByTestId("recipient-link").inputValue();
      const reportPath = await g.getByTestId("giver-report-link").getAttribute("href");

      const r = await recipient.newPage();
      await r.goto(new URL(recipientLink).pathname);
      await recipientCapture(r);
      await expect(r.getByTestId("carousel-item")).toHaveCount(6);
      for (const i of [0, 1]) await r.getByTestId("carousel-item").nth(i).getByTestId("heart").click();
      await expect(r.getByTestId("send-hearts")).toContainText("(2)");
      await r.getByTestId("send-hearts").click();
      await expect(r.getByTestId("undertone-screen")).toBeVisible({ timeout: 30_000 });
      await r.getByTestId("finish").click();
      await expect(r.getByTestId("done-screen")).toBeVisible({ timeout: 30_000 });

      await g.goto(reportPath!);
      await expect(g.getByTestId("fit-report")).toBeVisible({ timeout: 30_000 });
      await expect(g.getByTestId("fit-report-item")).toHaveCount(6, { timeout: 30_000 });
      await expect(g.getByTestId("hearted-count")).toHaveText("2");
      await expect(g.getByTestId("taste-summary-text")).toContainText("They hearted 2 of 6 pieces");
      await expect(g.getByTestId("taste-summary-source")).toContainText("hearted"); // template in keyless e2e
      const picks = g.getByTestId("not-tried-item");
      expect(await picks.count()).toBeGreaterThanOrEqual(2);
      expect(await picks.count()).toBeLessThanOrEqual(3);
      for (const label of await g.getByTestId("not-tried-label").allTextContents()) expect(label).toBe("Not tried on");
      await expect(g.getByTestId("photos-seen-counter")).toContainText("Photos seen by the giver: 0");
      expect(await g.locator("picture, video, canvas").count()).toBe(0);
      const imgs = await g.locator("img").evaluateAll((els) => els.map((e) => e.getAttribute("src") ?? ""));
      for (const src of imgs) expect(src, "recipient image on a giver page").not.toMatch(/\/api\/recipient\/tryon|mock-asset|^data:image|^blob:/i);
      expect(await g.locator("body").innerText()).not.toMatch(HEX);
      expect(leaks, JSON.stringify(leaks, null, 1)).toEqual([]);
    } finally {
      await giver.close();
      await recipient.close();
    }
  });
});

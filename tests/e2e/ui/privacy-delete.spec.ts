/**
 * Recipient "Delete everything" through the UI (owner: A8), mock mode, production build.
 *
 * The giver creates the Fit Request through the P3 creator route (the panel itself is covered by
 * gift-flow.spec.ts). The recipient, on a Pixel 7 context, captures with the placeholder selfie and,
 * from the try-on screen, taps "Delete everything". Afterwards: the deleted screen shows, each try-on
 * URL the recipient saw is dead, the recipient link and routes refuse the token, the gf_recipient
 * cookie is gone, and the giver's page holds no recipient data.
 */
import { devices, expect, test } from "@playwright/test";
import { scanGiverResponse } from "../support/giver-leaks";
import { recipientCapture, tryonUrls } from "../support/recipient-ui";

const SHORTLIST = [
  "dca42809-a2e1-5b50-8339-240170c69845", // Halo Drop Earrings (AUR-EAR-028)
  "74066662-deab-5925-b51f-4f39e11da0e3", // Reverie Pear Pendant (AUR-NEC-037)
];

test.describe("recipient deletes everything from the UI", () => {
  test.setTimeout(150_000);

  test("all recipient data and links are dead after one tap", async ({ browser, baseURL, request }) => {
    const created = await request.post("/api/fit/requests", {
      data: { occasion: "birthday", budgetMin: 150, budgetMax: 600, currency: "USD", shortlistIds: SHORTLIST },
    });
    expect(created.status()).toBe(201);
    const { giverToken, recipientPath, giverReportPath } = (await created.json()) as { giverToken: string; recipientPath: string; giverReportPath: string };
    const recipientToken = recipientPath.split("/").pop()!;

    const ctx = await browser.newContext({ ...devices["Pixel 7"], baseURL });
    try {
      const r = await ctx.newPage();
      await r.goto(recipientPath);
      await recipientCapture(r);
      const seen = await tryonUrls(r);
      expect(seen.length).toBeGreaterThan(0);
      expect((await ctx.request.get(seen[0])).status()).toBe(200);
      expect((await ctx.cookies()).some((c) => c.name === "gf_recipient")).toBe(true);

      // One tap, from the privacy panel on the try-on screen.
      await r.getByTestId("tryon-screen").locator("summary").click();
      const del = r.getByTestId("delete-everything").locator("button");
      await expect(del).toBeVisible();
      const deleteCall = r.waitForResponse((res) => res.url().endsWith("/api/recipient/delete"));
      await del.click();
      expect((await deleteCall).status()).toBe(200);
      await expect(r.getByTestId("deleted-screen")).toBeVisible({ timeout: 30_000 });

      // Try-on URLs, recipient routes and the cookie are all gone.
      for (const u of seen) expect((await ctx.request.get(u)).status(), u).toBeGreaterThanOrEqual(400);
      const auth = { authorization: `Bearer ${recipientToken}` };
      expect((await ctx.request.post("/api/recipient/session", { headers: auth })).status()).toBeGreaterThanOrEqual(400);
      expect((await ctx.request.get("/api/recipient/undertone", { headers: auth })).status()).toBeGreaterThanOrEqual(400);
      expect((await ctx.request.get("/api/recipient/capture", { headers: auth })).status()).toBeGreaterThanOrEqual(400);
      expect((await ctx.cookies()).some((c) => c.name === "gf_recipient")).toBe(false);
      await r.reload();
      await expect(r.getByTestId("consent-screen")).toHaveCount(0);

      // Giver side: nothing about the recipient, in the API or on the page.
      const rep = await request.post("/api/fit/report", { data: { giverToken } });
      expect(scanGiverResponse(await rep.text(), rep.headers())).toEqual([]);
      const giver = await browser.newContext({ ...devices["Desktop Chrome"], baseURL });
      const g = await giver.newPage();
      const html = (await (await g.goto(giverReportPath))?.text()) ?? "";
      expect(html).not.toMatch(/\/api\/recipient\/tryon|\/api\/youcam\/mock-asset|data:image\//i);
      await expect(g.getByTestId("report-gone").or(g.getByTestId("fit-report"))).toBeVisible({ timeout: 30_000 });
      await expect(g.getByTestId("hearted-badge")).toHaveCount(0);
      await giver.close();
    } finally {
      await ctx.close();
    }
  });
});

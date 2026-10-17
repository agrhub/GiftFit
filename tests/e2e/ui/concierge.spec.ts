/**
 * Gift Concierge demo page in mock mode (owner: A7): keyless replay of a recorded Claude conversation
 * through the real route, tools and grounding. Keyboard only: type, Enter, Tab to "Use this brief".
 */
import { expect, test } from "@playwright/test";
import { scanGiverResponse } from "../support/giver-leaks";

test("concierge demo: keyboard chat → grounded suggestions → Use this brief", async ({ page }) => {
  const leaks: string[] = [];
  page.on("response", async (res) => {
    if (!res.url().includes("/api/concierge")) return;
    const body = await res.text().catch(() => "");
    for (const line of body.split("\n").filter(Boolean)) {
      for (const l of scanGiverResponse(line, res.headers(), { allowProductImagePrefixes: ["/catalog/"] })) leaks.push(`${l.kind} ${l.path} ${l.detail}`);
    }
  });

  await page.goto("/concierge-demo");
  await expect(page.getByRole("heading", { name: "Gift concierge", level: 1 })).toBeVisible();

  const input = page.getByLabel("Your message");
  await input.fill("Anniversary gift for my wife. She loves minimal, delicate pieces and mostly wears gold. Budget around $300.");
  await input.press("Enter");

  const log = page.getByRole("log", { name: "Conversation" });
  const cards = log.getByRole("list", { name: "Suggested pieces" });
  await expect(cards).toBeVisible({ timeout: 15_000 });
  expect(await cards.getByRole("listitem").count()).toBeGreaterThan(0);
  await expect(log.getByText(/How I searched \(\d steps?\)/)).toBeVisible();
  await expect(log.getByText("Up to $300", { exact: true })).toBeVisible();

  const use = log.getByRole("button", { name: "Use this brief" });
  await use.focus();
  await page.keyboard.press("Enter");
  await expect(log.getByRole("status")).toContainText("nothing has been sent");
  const brief = JSON.parse((await page.getByTestId("concierge-brief").textContent()) ?? "{}");
  expect(brief).toMatchObject({ mode: "help_me_choose", occasion: "anniversary", budgetMax: 300, currency: "USD" });

  // Follow-up in Vietnamese replays the second fixture; history is sent along.
  await input.fill("Mình muốn tặng mẹ quà sinh nhật, khoảng 2 triệu. Mẹ thích kiểu cổ điển, sang trọng.");
  await input.press("Enter");
  await expect(log.getByRole("button", { name: "Use this brief" })).toHaveCount(2, { timeout: 15_000 });

  expect(leaks).toEqual([]);
});

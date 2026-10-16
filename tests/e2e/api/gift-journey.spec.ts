/**
 * End-to-end mock Fit Request over HTTP against the production build (R0, P3 merge).
 * giver creates → recipient session / consent / capture / hearts / done → giver report.
 * Every giver response goes through the independent leak scanner.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, request as playwrightRequest, test, type APIResponse } from "@playwright/test";
import { scanGiverResponse } from "../support/giver-leaks";

test.describe.configure({ mode: "serial" });

const SHORTLIST = [
  "dca42809-a2e1-5b50-8339-240170c69845", // Halo Drop Earrings (AUR-EAR-028)
  "74066662-deab-5925-b51f-4f39e11da0e3", // Reverie Pear Pendant (AUR-NEC-037)
  "e5c65c24-744d-5861-9f52-4edd091329bb", // Chime Bell Drop Earrings (AUR-EAR-034)
];
const SELFIE = path.join(process.cwd(), "fixtures", "youcam", "images", "placeholder-selfie.png");

async function giverJson(res: APIResponse): Promise<Record<string, unknown>> {
  const text = await res.text();
  expect(scanGiverResponse(text, res.headers()), `giver leak from ${res.url()}`).toEqual([]);
  return JSON.parse(text) as Record<string, unknown>;
}

test("a full mock Fit Request keeps every photo away from the giver", async ({ request, baseURL }) => {
  // Giver creates the request; decoys are chosen server-side and never returned.
  const created = await request.post("/api/fit/requests", {
    data: { occasion: "anniversary", budgetMin: 150, budgetMax: 300, currency: "USD", shortlistIds: SHORTLIST },
  });
  expect(created.status()).toBe(201);
  const c = await giverJson(created);
  expect(c.carouselSize).toBe(6);
  expect(Object.keys(c).join(",")).not.toMatch(/decoy/i);
  const giverToken = c.giverToken as string;
  const recipientToken = (c.recipientPath as string).split("/").pop()!;

  const waiting = await giverJson(await request.post("/api/fit/report", { data: { giverToken } }));
  expect(waiting.status).toBe("waiting");

  // The giver token never opens a recipient route.
  const crossed = await request.post("/api/recipient/session", { headers: { authorization: `Bearer ${giverToken}` } });
  expect(crossed.status()).toBeGreaterThanOrEqual(400);

  // Recipient: open link, consent.
  const auth = { authorization: `Bearer ${recipientToken}` };
  const session = await (await request.post("/api/recipient/session", { headers: auth })).json();
  expect(session.status).toBe("awaiting_consent");
  expect(session.items).toHaveLength(6);
  for (const item of session.items) expect(SHORTLIST).not.toContain(item.itemId);
  expect(JSON.stringify(session.items)).not.toMatch(/shortlist|decoy/i);
  expect((await request.post("/api/recipient/consent", { headers: auth, data: { accepted: true } })).status()).toBe(200);

  // Capture (mock YouCam): try-ons are signed and recipient-only.
  const capture = await request.post("/api/recipient/capture", {
    headers: auth,
    multipart: { selfie: { name: "selfie.png", mimeType: "image/png", buffer: readFileSync(SELFIE) } },
  });
  expect(capture.status()).toBe(200);
  const cap = await capture.json();
  const ready = cap.tryons.filter((t: { status: string }) => t.status === "ready");
  expect(ready.length).toBeGreaterThan(0);
  expect(cap.undertone.label).toMatch(/estimate/i);
  expect((await request.get(ready[0].imageUrl, { headers: auth })).status()).toBe(200);
  // A fresh context has no gf_recipient cookie: the signed URL alone must not open the image.
  const stranger = await playwrightRequest.newContext({ baseURL });
  expect((await stranger.get(ready[0].imageUrl)).status()).toBeGreaterThanOrEqual(400);
  await stranger.dispose();

  // Reload restores the same view.
  expect((await request.get("/api/recipient/capture", { headers: auth })).status()).toBe(200);

  // Hearts and done.
  const hearts = await request.post("/api/recipient/hearts", { headers: auth, data: { itemIds: ready.slice(0, 2).map((t: { itemId: string }) => t.itemId) } });
  expect(hearts.status()).toBe(200);
  const done = await (await request.post("/api/recipient/done", { headers: auth })).json();
  expect(done).toMatchObject({ photosDeleted: true, photosStored: 0 });

  // Giver report: scores, reasons and labels only.
  const report = await giverJson(await request.post("/api/fit/report", { data: { giverToken } }));
  expect(report.status).toBe("completed");
  expect(report.results as unknown[]).toHaveLength(SHORTLIST.length);
  const labels = report.recipientLabels as { undertone?: string } | undefined;
  expect(labels?.undertone ?? "").toMatch(/estimate/i);
});

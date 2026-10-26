/**
 * Dynamic giver-leak probe for the widget routes (owner: A6), through the real route modules and the
 * process-wide deps (privacy repos, contact store, e-mail sender), plus the Done hook end to end.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as donePOST } from "@/app/api/recipient/done/route";
import { POST as notifyPOST } from "@/app/api/widget/notify/route";
import { POST as sendCardPOST } from "@/app/api/widget/send-card/route";
import type { NormalizedMessage } from "@/lib/email/address";
import { setEmailSender } from "@/lib/email";
import { setEmailRateLimiter } from "@/lib/email/rate-limit";
import { createConsoleSender } from "@/lib/email/providers/console";
import { findGiverLeaks } from "@/lib/privacy/giver-guard";
import { setPrivacyDeps } from "@/lib/privacy/runtime";
import { newFitRequestTokens } from "@/lib/privacy/tokens";
import { makeStack, type TestStack } from "@/lib/privacy/__tests__/helpers";
import { MemoryContactStore, setContactStore } from "@/lib/widget/contacts";

let stack: TestStack;
let contacts: MemoryContactStore;
let outbox: NormalizedMessage[];

beforeEach(() => {
  stack = makeStack();
  // The widget routes compare expiry with the real clock; keep the stack clock on "now".
  stack.clock.now = new Date();
  setPrivacyDeps(stack.deps);
  contacts = new MemoryContactStore();
  setContactStore(contacts);
  outbox = [];
  setEmailSender(createConsoleSender({ outbox, log: () => undefined }));
  setEmailRateLimiter(undefined);
});
afterEach(() => {
  setPrivacyDeps(undefined);
  setContactStore(undefined);
  setEmailSender(undefined);
});

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://giftfit.example${url}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

async function seed() {
  const t = newFitRequestTokens();
  const request = await stack.repos.fitRequests.create({ storeId: null, giverTokenHash: t.giverTokenHash, recipientTokenHash: t.recipientTokenHash, occasion: "wedding", budgetMin: null, budgetMax: 400, currency: "USD", shortlistIds: ["a"], decoyIds: [] });
  return { request, ...t };
}

describe("widget giver routes (dynamic probe)", () => {
  it("every response passes the giver guard and echoes no address or token", async () => {
    const r = await seed();
    const responses = [
      await sendCardPOST(post("/api/widget/send-card", { giverToken: r.giverToken, recipientToken: r.recipientToken, to: "x@example.com", lang: "en", message: "#c68e6b https://x.blob.vercel-storage.com/tryon/1.png" })),
      await sendCardPOST(post("/api/widget/send-card", { giverToken: r.giverToken, recipientToken: "nope", to: "x@example.com", lang: "en" })),
      await sendCardPOST(post("/api/widget/send-card", "not json")),
      await notifyPOST(post("/api/widget/notify", { giverToken: r.giverToken, email: "me@example.com", lang: "vi" })),
      await notifyPOST(post("/api/widget/notify", { giverToken: r.giverToken, email: "bad", lang: "vi" })),
    ];
    expect(responses.map((x) => x.status)).toEqual([200, 404, 400, 200, 400]);
    for (const res of responses) {
      const text = await res.text();
      expect(findGiverLeaks(JSON.parse(text))).toEqual([]);
      expect(text).not.toMatch(/@example\.com|[A-Za-z0-9_-]{40,}/);
      expect(res.headers.get("cache-control")).toContain("no-store");
    }
    expect(outbox).toHaveLength(1);
  });

  it("Done sends the giver one report-ready note through the real recipient route", async () => {
    const r = await seed();
    await stack.repos.fitRequests.setStatus(r.request.id, "consented");
    await notifyPOST(post("/api/widget/notify", { giverToken: r.giverToken, email: "me@example.com", lang: "vi" }));
    const done = await donePOST(post("/api/recipient/done", {}, { Authorization: `Bearer ${r.recipientToken}` }));
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ photosDeleted: true, photosStored: 0 });
    expect(outbox).toHaveLength(1);
    expect(outbox[0].to).toEqual(["me@example.com"]);
    expect(outbox[0].text).toContain(`/g/${r.giverToken}`);
    expect(contacts.all()).toHaveLength(0);
  });
});

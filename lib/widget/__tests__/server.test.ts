import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConsoleSender } from "@/lib/email/providers/console";
import type { NormalizedMessage } from "@/lib/email/address";
import { MemoryEmailRateLimiter } from "@/lib/email/rate-limit";
import type { EmailSender } from "@/lib/email/types";
import { deleteEverything, purgeExpired } from "@/lib/privacy/delete-everything";
import { newFitRequestTokens } from "@/lib/privacy/tokens";
import { FakeFirestore } from "@/lib/store/__tests__/fake-firestore";
import { makeStack, type TestStack } from "@/lib/privacy/__tests__/helpers";
import { CONTACTS_COLLECTION, FirestoreContactStore, MemoryContactStore, newContactRecord, openContact, sealContact, setContactStore } from "../contacts";
import { FirestoreEmailRateLimiter } from "../email-limits";
import { handleNotifyMe, handleSendCard, notifyGiverReportReady, type WidgetServerDeps } from "../server";

const H = 3600_000;
let stack: TestStack;
let contacts: MemoryContactStore;
let outbox: NormalizedMessage[];
let sender: EmailSender;
let limiter: MemoryEmailRateLimiter;
let deps: WidgetServerDeps;

beforeEach(() => {
  stack = makeStack();
  contacts = new MemoryContactStore();
  outbox = [];
  sender = createConsoleSender({ outbox, log: () => undefined });
  limiter = new MemoryEmailRateLimiter();
  deps = { repos: async () => stack.repos, contacts: () => contacts, sender: () => sender, limiter: () => limiter, now: stack.deps.now };
  setContactStore(contacts);
});
afterEach(() => setContactStore(undefined));

async function newRequest(occasion = "anniversary") {
  const tokens = newFitRequestTokens();
  const request = await stack.repos.fitRequests.create({ storeId: null, giverTokenHash: tokens.giverTokenHash, recipientTokenHash: tokens.recipientTokenHash, occasion, budgetMin: null, budgetMax: 300, currency: "USD", shortlistIds: ["a", "b"], decoyIds: [] });
  return { request, ...tokens };
}

function post(path: string, body: unknown, ip = "203.0.113.7"): Request {
  return new Request(`https://giftfit.example${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": ip }, body: JSON.stringify(body) });
}

const card = (r: Awaited<ReturnType<typeof newRequest>>, extra: Record<string, unknown> = {}) => ({ giverToken: r.giverToken, recipientToken: r.recipientToken, to: "mai@example.com", lang: "vi", message: "Chúc mừng kỷ niệm!", giverName: "Nam", ...extra });

describe("POST /api/widget/send-card", () => {
  it("sends the themed card with the recipient link and keeps only a sealed, request-scoped record", async () => {
    const r = await newRequest();
    const res = await handleSendCard(post("/api/widget/send-card", card(r)), deps);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ sent: true, delivery: "logged" });
    expect(text).not.toContain("mai@example.com");
    expect(text).not.toContain(r.giverToken);

    expect(outbox).toHaveLength(1);
    expect(outbox[0].to).toEqual(["mai@example.com"]);
    expect(outbox[0].subject).toContain("Nam");
    expect(outbox[0].text).toContain(`https://giftfit.example/r/${r.recipientToken}`);
    expect(outbox[0].text).toContain("Chúc mừng kỷ niệm!");

    const rows = contacts.all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ fitRequestId: r.request.id, kind: "recipient_card" });
    expect(rows[0].expiresAt.getTime()).toBe(r.request.expiresAt.getTime());
    expect(JSON.stringify(rows[0])).not.toContain("mai@example.com");
    expect(openContact(rows[0].sealed)).toEqual({ email: "mai@example.com", lang: "vi" });
  });

  it("validates input and never acts as a token oracle", async () => {
    const r = await newRequest();
    const other = await newRequest();
    const cases: Array<[unknown, number, string]> = [
      [{ nope: 1 }, 400, "invalid_request"],
      [card(r, { to: "not-an-address" }), 400, "invalid_email"],
      [card(r, { to: "a@b.c\r\nBcc: x@y.z" }), 400, "invalid_email"],
      [card(r, { giverToken: "A".repeat(43) }), 404, "not_found"],
      [card(r, { giverToken: "short" }), 404, "not_found"],
      [card(r, { recipientToken: other.recipientToken }), 404, "not_found"],
    ];
    for (const [body, status, error] of cases) {
      const res = await handleSendCard(post("/api/widget/send-card", body), deps);
      expect(res.status, JSON.stringify(body)).toBe(status);
      expect(await res.json()).toEqual({ error });
    }
    expect(outbox).toHaveLength(0);
  });

  it("refuses expired and deleted requests", async () => {
    const r = await newRequest();
    stack.clock.advance(73 * H);
    expect((await handleSendCard(post("/api/widget/send-card", card(r)), deps)).status).toBe(410);
    const d = await newRequest();
    await stack.repos.fitRequests.setStatus(d.request.id, "deleted");
    expect((await handleSendCard(post("/api/widget/send-card", card(d)), deps)).status).toBe(410);
  });

  it("enforces the per-giver and per-IP e-mail limits (429 + Retry-After, nothing sent)", async () => {
    const r = await newRequest();
    for (let i = 0; i < 5; i++) expect((await handleSendCard(post("/api/widget/send-card", card(r), `198.51.100.${i}`), deps)).status).toBe(200);
    const sixth = await handleSendCard(post("/api/widget/send-card", card(r), "198.51.100.99"), deps);
    expect(sixth.status).toBe(429);
    expect(Number(sixth.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(outbox).toHaveLength(5);
    // At most 5 recipient records per request.
    expect(contacts.all().filter((c) => c.fitRequestId === r.request.id)).toHaveLength(5);

    // Per IP: 10 / hour across different givers.
    let ok = 0;
    for (let i = 0; i < 11; i++) {
      const g = await newRequest();
      if ((await handleSendCard(post("/api/widget/send-card", card(g), "192.0.2.1"), deps)).status === 200) ok++;
    }
    expect(ok).toBe(10);
  });

  it("a provider failure is a 502 without a record", async () => {
    const r = await newRequest();
    sender = {
      provider: "smtp",
      send: async () => {
        throw Object.assign(new Error("boom"), { code: "ECONNECTION" });
      },
    };
    const res = await handleSendCard(post("/api/widget/send-card", card(r)), deps);
    expect(res.status).toBe(502);
    expect(contacts.all()).toHaveLength(0);
  });
});

describe("contact records live exactly as long as the request", () => {
  it("expired rows are invisible and dropped on read", async () => {
    const r = await newRequest();
    await handleSendCard(post("/api/widget/send-card", card(r)), deps);
    expect(await contacts.list(r.request.id, stack.deps.now())).toHaveLength(1);
    stack.clock.advance(72 * H + 1);
    expect(await contacts.list(r.request.id, stack.deps.now())).toEqual([]);
    expect(contacts.all()).toHaveLength(0);
  });

  it("Delete everything and the 72 h purge remove them", async () => {
    const a = await newRequest();
    const b = await newRequest();
    await handleSendCard(post("/api/widget/send-card", card(a)), deps);
    await handleSendCard(post("/api/widget/send-card", card(b)), deps);
    await handleNotifyMe(post("/api/widget/notify", { giverToken: b.giverToken, email: "nam@example.com", lang: "en" }), deps);
    expect(contacts.all()).toHaveLength(3);
    await deleteEverything(stack.deps, a.request.id, "recipient_request");
    expect(contacts.all().map((c) => c.fitRequestId)).toEqual([b.request.id, b.request.id]);
    stack.clock.advance(73 * H);
    await purgeExpired(stack.deps);
    expect(contacts.all()).toHaveLength(0);
  });

  it("sealing is authenticated and bound to the secret", () => {
    const s = sealContact({ email: "a@example.com", lang: "en" }, "x".repeat(40));
    expect(s).not.toContain("example");
    expect(openContact(s, "x".repeat(40))).toEqual({ email: "a@example.com", lang: "en" });
    expect(openContact(s, "y".repeat(40))).toBeNull();
    const parts = s.split(".");
    parts[2] = parts[2].slice(0, -2) + (parts[2].endsWith("A") ? "BB" : "AA");
    expect(openContact(parts.join("."), "x".repeat(40))).toBeNull();
  });
});

describe("POST /api/widget/notify and the Done hook", () => {
  it("stores one address per request, sends one report-ready e-mail at Done, then forgets it", async () => {
    const r = await newRequest("birthday");
    for (const email of ["old@example.com", "nam@example.com"]) {
      const res = await handleNotifyMe(post("/api/widget/notify", { giverToken: r.giverToken, email, lang: "en", giverName: "Nam" }), deps);
      expect(await res.json()).toEqual({ saved: true });
    }
    const rows = contacts.all();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain(r.giverToken);

    const req = new Request("https://giftfit.example/api/recipient/done", { method: "POST" });
    expect(await notifyGiverReportReady(r.request, req, deps)).toBe(1);
    expect(outbox).toHaveLength(1);
    expect(outbox[0].to).toEqual(["nam@example.com"]);
    expect(outbox[0].text).toContain(`https://giftfit.example/g/${r.giverToken}`);
    expect(contacts.all()).toHaveLength(0);
    // Idempotent: a second Done sends nothing.
    expect(await notifyGiverReportReady(r.request, req, deps)).toBe(0);
  });

  it("answers ready for a completed request and validates input", async () => {
    const r = await newRequest();
    await stack.repos.fitRequests.setStatus(r.request.id, "completed");
    expect(await (await handleNotifyMe(post("/api/widget/notify", { giverToken: r.giverToken, email: "a@example.com", lang: "en" }), deps)).json()).toEqual({ saved: false, ready: true });
    expect((await handleNotifyMe(post("/api/widget/notify", { giverToken: r.giverToken, email: "nope", lang: "en" }), deps)).status).toBe(400);
    expect((await handleNotifyMe(post("/api/widget/notify", { giverToken: "Z".repeat(43), email: "a@example.com", lang: "en" }), deps)).status).toBe(404);
    expect(contacts.all()).toHaveLength(0);
  });

  it("never throws into Done, even when the store fails", async () => {
    const broken = { ...deps, contacts: () => ({ ...contacts, list: async () => Promise.reject(new Error("down")) }) as unknown as MemoryContactStore };
    await expect(notifyGiverReportReady({ id: "x", occasion: null }, new Request("https://g.example/"), broken)).resolves.toBe(0);
  });
});

describe("Firestore adapters", () => {
  it("contact store: sealed docs only, query by request, TTL field, delete", async () => {
    const db = new FakeFirestore();
    const store = new FirestoreContactStore(async () => db);
    const now = new Date("2026-10-26T00:00:00Z");
    const rec = newContactRecord({ fitRequestId: "req-1", kind: "giver_notify", payload: { email: "x@example.com", lang: "en", giverToken: "t".repeat(43) }, now, expiresAt: new Date(now.getTime() + 72 * H) });
    await store.put(rec);
    await store.put(newContactRecord({ fitRequestId: "req-2", kind: "recipient_card", payload: { email: "y@example.com", lang: "vi" }, now, expiresAt: new Date(now.getTime() + H) }));
    const raw = JSON.stringify(db.docs(CONTACTS_COLLECTION));
    expect(raw).not.toContain("example.com");
    expect(raw).toContain("expiresAt");
    expect((await store.list("req-1", now)).map((r) => r.id)).toEqual([rec.id]);
    expect(await store.list("req-1", now, "recipient_card")).toEqual([]);
    expect(await store.list("req-2", new Date(now.getTime() + 2 * H))).toEqual([]);
    expect(await store.deleteForRequest("req-1")).toBe(1);
    expect(Object.keys(db.docs(CONTACTS_COLLECTION))).toHaveLength(0);
  });

  it("e-mail limiter: both keys in one transaction, all-or-nothing", async () => {
    const db = new FakeFirestore();
    const lim = new FirestoreEmailRateLimiter(async () => db, { email_giver: [{ limit: 2, windowMs: H }], email_ip: [{ limit: 3, windowMs: H }] });
    const t = Date.parse("2026-10-26T10:10:00Z");
    expect(await lim.take({ giverKey: "g1", ipKey: "ip" }, t)).toEqual({ ok: true });
    expect(await lim.take({ giverKey: "g1", ipKey: "ip" }, t)).toEqual({ ok: true });
    const third = await lim.take({ giverKey: "g1", ipKey: "ip" }, t);
    expect(third).toMatchObject({ ok: false, scope: "email_giver" });
    // The refused send did not burn the IP bucket: one more from another giver still fits.
    expect(await lim.take({ giverKey: "g2", ipKey: "ip" }, t)).toEqual({ ok: true });
    expect(await lim.take({ giverKey: "g3", ipKey: "ip" }, t)).toMatchObject({ ok: false, scope: "email_ip" });
    expect(await lim.take({ giverKey: "g1", ipKey: "ip" }, t + H)).toEqual({ ok: true });
  });
});

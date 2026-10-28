/**
 * The giver's language end to end (ADR-057), through the real handlers with the console sender (nothing
 * leaves the process): the gift card mailed by send-card, the "your Fit Report is ready" note that notify
 * saves and Done sends, and the share text, each in all ten widget languages, English for any other.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConsoleSender } from "@/lib/email/providers/console";
import type { NormalizedMessage } from "@/lib/email/address";
import { EMAIL_COPY, HEADLINES } from "@/lib/email/copy";
import { MemoryEmailRateLimiter } from "@/lib/email/rate-limit";
import { normalizeLang } from "@/lib/email/templates";
import { LOCALES, t, type Locale } from "@/lib/i18n";
import { makeStack, type TestStack } from "@/lib/privacy/__tests__/helpers";
import { newFitRequestTokens } from "@/lib/privacy/tokens";
import { MemoryContactStore, openContact, setContactStore } from "../contacts";
import { handleNotifyMe, handleSendCard, notifyGiverReportReady, type WidgetServerDeps } from "../server";
import { cardTheme, shareLinks, shareText } from "../share";

const BASE = "https://giftfit.example";
let stack: TestStack;
let contacts: MemoryContactStore;
let outbox: NormalizedMessage[];
let deps: WidgetServerDeps;

beforeEach(() => {
  stack = makeStack();
  contacts = new MemoryContactStore();
  outbox = [];
  const sender = createConsoleSender({ outbox, log: () => undefined });
  const limiter = new MemoryEmailRateLimiter();
  deps = { repos: async () => stack.repos, contacts: () => contacts, sender: () => sender, limiter: () => limiter, now: stack.deps.now };
  setContactStore(contacts);
});
afterEach(() => setContactStore(undefined));

async function newRequest() {
  const tokens = newFitRequestTokens();
  const request = await stack.repos.fitRequests.create({ storeId: null, giverTokenHash: tokens.giverTokenHash, recipientTokenHash: tokens.recipientTokenHash, occasion: "birthday", budgetMin: null, budgetMax: 300, currency: "USD", shortlistIds: ["a", "b"], decoyIds: [] });
  return { request, ...tokens };
}
const post = (path: string, body: unknown) => new Request(`${BASE}${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.21" }, body: JSON.stringify(body) });

/** [what the widget sends, the language the mail must be in] */
const CASES: Array<[unknown, Locale]> = [...LOCALES.map((l) => [l, l] as [Locale, Locale]), ["ja-JP", "ja"], ["pt", "en"], ["pt-BR", "en"], ["xx", "en"], [undefined, "en"], [42, "en"]];

describe("send-card: the gift card e-mail is in the card language", () => {
  it.each(CASES)("lang %s → %s: subject, headline, body, CTA and footer", async (sent, lang) => {
    const r = await newRequest();
    const res = await handleSendCard(post("/api/widget/send-card", { giverToken: r.giverToken, recipientToken: r.recipientToken, to: "mai@example.com", lang: sent, giverName: "Nam" }), deps);
    expect(res.status).toBe(200);
    const [mail] = outbox;
    const c = EMAIL_COPY[lang];
    expect(mail.subject).toBe(c.giftSubject("Nam"));
    expect(mail.html).toContain(`<html lang="${lang}">`);
    for (const part of [HEADLINES.birthday[lang], c.giftIntro("Nam", ""), c.giftCta, c.footer, c.footerNoList, c.linkFallback]) {
      expect(mail.text.includes(part) || mail.html.includes(part), `${lang}: ${part}`).toBe(true);
    }
    expect(mail.text).toContain(`${c.giftCta}: ${BASE}/r/${r.recipientToken}`);
    if (lang !== "en") expect(mail.text).not.toContain(EMAIL_COPY.en.footer);
    // The sealed contact keeps the normalized language.
    expect(openContact(contacts.all()[0].sealed)).toMatchObject({ lang });
  });
});

describe("notify → Done: the report-ready note is in the giver's language", () => {
  it.each(CASES)("lang %s → %s: subject, body, CTA and footer", async (sent, lang) => {
    const r = await newRequest();
    expect((await handleNotifyMe(post("/api/widget/notify", { giverToken: r.giverToken, email: "nam@example.com", lang: sent, giverName: "Nam" }), deps)).status).toBe(200);
    expect(await notifyGiverReportReady(r.request, new Request(`${BASE}/api/recipient/done`, { method: "POST" }), deps)).toBe(1);
    const [mail] = outbox;
    const c = EMAIL_COPY[lang];
    expect(mail.subject).toBe(c.reportSubject(""));
    expect(mail.html).toContain(`<html lang="${lang}">`);
    for (const part of [c.reportIntro("Nam", ""), c.reportBody, c.footer, c.footerNoList]) expect(mail.text, `${lang}: ${part}`).toContain(part);
    expect(mail.text).toContain(`${c.reportCta}: ${BASE}/g/${r.giverToken}`);
    if (lang !== "en") expect(mail.subject).not.toBe(EMAIL_COPY.en.reportSubject(""));
  });
});

describe("share text follows the card language", () => {
  const LINK = `${BASE}/r/abc`;
  it.each(LOCALES)("%s: WhatsApp and the copy / native-share text carry the headline and words of that language", (lang) => {
    const links = shareLinks({ lang, occasion: "graduation", message: "♥", link: LINK });
    const expected = t(lang, "share.text", { headline: cardTheme("graduation", lang).headline, message: "♥\n", link: LINK });
    expect(links.text).toBe(expected);
    expect(links.text).toContain(HEADLINES.graduation[lang]);
    expect(decodeURIComponent(links.whatsapp.replace("https://wa.me/?text=", ""))).toBe(expected);
    if (lang !== "en") expect(links.text).not.toBe(shareText({ lang: "en", occasion: "graduation", message: "♥", link: LINK }));
  });

  it("a language outside the ten shares in English (the card language is normalized first)", () => {
    for (const l of ["pt", "it-IT", "zh-TW", ""]) {
      expect(shareText({ lang: normalizeLang(l), occasion: "birthday", link: LINK })).toBe(shareText({ lang: "en", occasion: "birthday", link: LINK }));
    }
  });
});

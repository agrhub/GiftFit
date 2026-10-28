/**
 * Gift-flow languages (ADR-057): e-card headlines, gift and report e-mails, share text and the send-card /
 * notify routes follow the giver's conversation language in all ten widget languages, English otherwise.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConsoleSender } from "@/lib/email/providers/console";
import type { NormalizedMessage } from "@/lib/email/address";
import { MemoryEmailRateLimiter } from "@/lib/email/rate-limit";
import { LOCALES, t } from "@/lib/i18n";
import { makeStack, type TestStack } from "@/lib/privacy/__tests__/helpers";
import { newFitRequestTokens } from "@/lib/privacy/tokens";
import { MemoryContactStore, openContact, setContactStore } from "@/lib/widget/contacts";
import { handleNotifyMe, handleSendCard, type WidgetServerDeps } from "@/lib/widget/server";
import { cardTheme, shareText } from "@/lib/widget/share";
import { secondLocale } from "@/components/gift/expiredLines";
import { EMAIL_COPY, HEADLINES } from "../copy";
import { CARD_LANGS, fitReportReadyEmail, giftCardEmail, normalizeLang, OCCASION_THEMES } from "../templates";

const BASE = "https://giftfit.example";
const LINK = `${BASE}/r/abc`;

describe("card language", () => {
  it("is any of the ten widget languages; everything else is English", () => {
    expect(CARD_LANGS).toEqual(LOCALES);
    for (const l of LOCALES) expect(normalizeLang(l)).toBe(l);
    expect(normalizeLang("ja-JP")).toBe("ja");
    expect(normalizeLang("de_DE")).toBe("de");
    for (const l of ["pt", "it", "zh-TW", "", null, 3]) expect(normalizeLang(l)).toBe("en");
  });

  it("every occasion has a headline in every language, distinct from English", () => {
    for (const [occasion, byLang] of Object.entries(HEADLINES)) {
      for (const l of LOCALES) {
        expect(byLang[l]?.trim(), `${occasion}:${l}`).toBeTruthy();
        if (l !== "en") expect(byLang[l], `${occasion}:${l}`).not.toBe(byLang.en);
      }
      expect(OCCASION_THEMES[occasion as keyof typeof OCCASION_THEMES].headline).toBe(byLang);
    }
    expect(cardTheme("birthday", "ja").headline).toBe("お誕生日おめでとう");
  });
});

describe("e-mails in every language", () => {
  it.each(LOCALES.filter((l) => l !== "en"))("%s: gift card and report e-mails, both try-on modes", (l) => {
    const gift = giftCardEmail({ occasion: "birthday", lang: l, giverName: "Nam", recipientName: "Mai", message: "♥", recipientToken: "tok", baseUrl: BASE });
    const c = EMAIL_COPY[l];
    expect(gift.html).toContain(`lang="${l}"`);
    expect(gift.subject).toBe(c.giftSubject("Nam"));
    expect(gift.subject).not.toBe(EMAIL_COPY.en.giftSubject("Nam"));
    expect(gift.text).toContain(HEADLINES.birthday[l]);
    expect(gift.text).toContain(c.giftBody("Nam"));
    expect(gift.text).toContain(`${c.giftCta}: ${BASE}/r/tok`);
    expect(gift.text).toContain(c.footer);
    // Footers keep the 72-hour expiry.
    expect(c.footer).toContain("72");

    const noTry = giftCardEmail({ occasion: "birthday", lang: l, giverName: "Nam", recipientToken: "tok", baseUrl: BASE, tryOn: false });
    expect(noTry.text).toContain(c.giftBodyNoTryOn("Nam"));
    expect(noTry.text).not.toContain(c.giftBody("Nam"));

    const report = fitReportReadyEmail({ lang: l, giverName: "Nam", recipientName: "Mai", giverToken: "g", baseUrl: BASE });
    expect(report.subject).toBe(c.reportSubject("Mai"));
    expect(report.text).toContain(c.reportBody);
    expect(fitReportReadyEmail({ lang: l, giverToken: "g", baseUrl: BASE, tryOn: false }).text).toContain(c.reportBodyNoTryOn);
  });

  it("names left blank still read (fallback words in that language)", () => {
    for (const l of LOCALES) {
      const c = EMAIL_COPY[l];
      for (const s of [c.giftSubject(""), c.giftIntro("", ""), c.giftBody(""), c.giftMessageLabel(""), c.reportSubject(""), c.reportIntro("", "")]) {
        expect(s.trim().length, l).toBeGreaterThan(3);
        expect(s, l).not.toMatch(/undefined|null|\$\{/);
      }
    }
  });
});

describe("share text", () => {
  it("uses the card language's headline and words", () => {
    expect(shareText({ lang: "es", occasion: "birthday", link: LINK })).toBe(t("es", "share.text", { headline: "Feliz cumpleaños", message: "", link: LINK }));
    expect(shareText({ lang: "ko", occasion: "wedding", message: "축하해!", link: LINK })).toContain("결혼을 축하해요");
  });
});

describe("routes accept the ten languages", () => {
  let stack: TestStack;
  let outbox: NormalizedMessage[];
  let contacts: MemoryContactStore;
  let deps: WidgetServerDeps;
  beforeEach(() => {
    stack = makeStack();
    outbox = [];
    contacts = new MemoryContactStore();
    const sender = createConsoleSender({ outbox, log: () => undefined });
    const limiter = new MemoryEmailRateLimiter();
    deps = { repos: async () => stack.repos, contacts: () => contacts, sender: () => sender, limiter: () => limiter, now: stack.deps.now };
    setContactStore(contacts);
  });
  afterEach(() => setContactStore(undefined));

  async function newRequest() {
    const tokens = newFitRequestTokens();
    await stack.repos.fitRequests.create({ storeId: null, giverTokenHash: tokens.giverTokenHash, recipientTokenHash: tokens.recipientTokenHash, occasion: "birthday", budgetMin: null, budgetMax: 300, currency: "USD", shortlistIds: ["a", "b"], decoyIds: [] });
    return tokens;
  }
  const post = (path: string, body: unknown) => new Request(`${BASE}${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.9" }, body: JSON.stringify(body) });

  it("send-card mails the card in the giver's language; unknown → English", async () => {
    const r = await newRequest();
    expect((await handleSendCard(post("/api/widget/send-card", { giverToken: r.giverToken, recipientToken: r.recipientToken, to: "mai@example.com", lang: "th", giverName: "Nam" }), deps)).status).toBe(200);
    expect(outbox[0].subject).toBe(EMAIL_COPY.th.giftSubject("Nam"));
    expect(openContact(contacts.all()[0].sealed)).toEqual({ email: "mai@example.com", lang: "th" });

    const r2 = await newRequest();
    expect((await handleSendCard(post("/api/widget/send-card", { giverToken: r2.giverToken, recipientToken: r2.recipientToken, to: "lan@example.com", lang: "pt-BR", giverName: "Nam" }), deps)).status).toBe(200);
    expect(outbox[1].subject).toBe(EMAIL_COPY.en.giftSubject("Nam"));
  });

  it("notify keeps the giver's language for the report e-mail", async () => {
    const r = await newRequest();
    const res = await handleNotifyMe(post("/api/widget/notify", { giverToken: r.giverToken, email: "nam@example.com", lang: "de" }), deps);
    expect(res.status).toBe(200);
    expect(openContact(contacts.all()[0].sealed)).toMatchObject({ lang: "de" });
  });
});

describe("expired-preview line on the recipient and report pages", () => {
  it("follows the browser language when it is one of the ten, else stays Vietnamese", () => {
    expect(secondLocale(["ja-JP", "en"])).toBe("ja");
    expect(secondLocale(["de"])).toBe("de");
    expect(secondLocale(["en-US", "ja"])).toBe("vi");
    expect(secondLocale(["pt-BR", "es"])).toBe("es");
    expect(secondLocale(["pt-BR"])).toBe("vi");
    expect(secondLocale([])).toBe("vi");
  });
});

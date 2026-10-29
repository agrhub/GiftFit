/**
 * The gift header is localized in the server HTML (A26): /r/<token> and /g/<token> render it with the
 * locale they decide on the server (Accept-Language + the giver's language; the giver's language), so the
 * first paint has no English "Private" / "for <store>" to flash before hydration.
 */
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Locale } from "@/lib/i18n";
import { rt } from "@/lib/i18n/recipient";

const env = vi.hoisted(() => ({ acceptLanguage: null as string | null, giverLang: undefined as string | undefined }));
vi.mock("next/headers", () => ({ headers: async () => new Headers(env.acceptLanguage ? { "accept-language": env.acceptLanguage } : {}) }));
vi.mock("@/lib/privacy/runtime", () => ({ getPrivacyDeps: async () => ({}) }));
vi.mock("@/lib/privacy/giver-lang", () => ({ giverLangForRecipientToken: async () => env.giverLang }));
vi.mock("@/lib/fit/deps", () => ({ getFitDeps: () => ({ repository: { findByGiverToken: async () => ({ giverLang: env.giverLang }) } }) }));

import GiverReportPage from "../g/[token]/page";
import GiftLayout from "../layout";
import RecipientPage from "../r/[token]/page";

const TOKEN = "t".repeat(43);
const params = Promise.resolve({ token: TOKEN });

/** The page's server HTML inside the (gift) layout, and its <header> alone. */
async function serverHtml(page: typeof RecipientPage | typeof GiverReportPage) {
  const html = renderToString(<GiftLayout>{await page({ params })}</GiftLayout>);
  const header = /<header[\s\S]*?<\/header>/.exec(html)?.[0] ?? "";
  return { html, header };
}

function expectHeaderIn(locale: Locale, { html, header }: { html: string; header: string }) {
  expect(header).toContain(`lang="${locale}"`);
  expect(header).toContain(rt(locale, "header.private"));
  expect(header).not.toMatch(/Private|>for /);
  expect(html.match(/<header/g)).toHaveLength(1); // one header, outside the single main landmark
  expect(html.match(/<main id="main"/g)).toHaveLength(1);
  expect(html.indexOf("</header>")).toBeLessThan(html.indexOf("<main"));
}

beforeEach(() => {
  env.acceptLanguage = null;
  env.giverLang = undefined;
});

describe("gift header in the server HTML", () => {
  it.each<[Locale, string]>([
    ["ja", "ja-JP,ja;q=0.9,en;q=0.5"],
    ["de", "de-DE,de;q=0.9"],
  ])("/r: the recipient's browser language (%s)", async (locale, acceptLanguage) => {
    env.acceptLanguage = acceptLanguage;
    env.giverLang = "en";
    expectHeaderIn(locale, await serverHtml(RecipientPage));
  });

  it.each<Locale>(["ja", "de"])("/r: no supported browser language → the giver's language (%s)", async (locale) => {
    env.acceptLanguage = "pt-BR,pt;q=0.9";
    env.giverLang = locale;
    expectHeaderIn(locale, await serverHtml(RecipientPage));
  });

  it.each<Locale>(["ja", "de"])("/g: the giver's language (%s), whatever the browser says", async (locale) => {
    env.acceptLanguage = "en-US,en;q=0.9";
    env.giverLang = locale;
    expectHeaderIn(locale, await serverHtml(GiverReportPage));
  });

  it("English stays English", async () => {
    env.acceptLanguage = "en-US";
    const { header } = await serverHtml(RecipientPage);
    expect(header).toContain("Private");
    expect(header).toContain('lang="en"');
  });
});

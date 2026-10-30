import type { Metadata } from "next";
import { headers } from "next/headers";
import { cache } from "react";
import { GiftPageShell } from "@/client/gift/GiftPageShell";
import { RecipientFlow } from "@/client/gift/recipient/RecipientFlow";
import { parseAcceptLanguage, recipientLocale, rt } from "@/server/i18n/recipient";
import { giverLangForRecipientToken } from "@/server/privacy/giver-lang";
import { getPrivacyDeps } from "@/server/privacy/runtime";

/**
 * The page language (A21): the recipient's browser language when it is one of the ten UI locales, else
 * the giver's conversation language stored with the Fit Request, else English. Decided here from
 * Accept-Language so the first paint is already in that language.
 */
const pageLocale = cache(async (token: string) => {
  const giverLang = await getPrivacyDeps()
    .then((deps) => giverLangForRecipientToken(token, deps))
    .catch(() => undefined);
  const browserLanguages = parseAcceptLanguage((await headers()).get("accept-language"));
  return { locale: recipientLocale({ browserLanguages, giverLang }), giverLang: giverLang ?? null };
});

// Neutral title: store-URL preview gifts (ADR-055) have no try-on.
export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const { locale } = await pageLocale((await params).token);
  return { title: rt(locale, "meta.title") };
}

export default async function RecipientPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const { locale, giverLang } = await pageLocale(token);
  return (
    <GiftPageShell locale={locale}>
      <div className="mx-auto w-full max-w-md md:max-w-3xl" lang={locale}>
        <RecipientFlow token={token} locale={locale} giverLang={giverLang} />
      </div>
    </GiftPageShell>
  );
}

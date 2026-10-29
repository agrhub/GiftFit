import type { Metadata } from "next";
import { GiftPageShell } from "@/components/gift/GiftPageShell";
import { GiverReport } from "@/components/gift/report/GiverReport";
import { getFitDeps } from "@/lib/fit/deps";
import { type Locale, uiLocaleFor } from "@/lib/i18n";
import { rt } from "@/lib/i18n/report";

/**
 * The report's language, known on the server: the giver's language when the request was made
 * (`giverLang`, one of the ten UI locales, else English). The report API returns the same `lang`; this
 * only spares the first paint (and the tab title) from flashing English. Any lookup failure = English.
 */
async function reportLocale(token: string): Promise<Locale> {
  try {
    const request = await getFitDeps().repository.findByGiverToken(token);
    return uiLocaleFor(request?.giverLang);
  } catch {
    return "en";
  }
}

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const { token } = await params;
  return { title: rt(await reportLocale(token), "meta.title") };
}

export default async function GiverReportPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const locale = await reportLocale(token);
  return (
    <GiftPageShell locale={locale}>
      <div className="pt-4" lang={locale}>
        <GiverReport token={token} locale={locale} />
      </div>
    </GiftPageShell>
  );
}

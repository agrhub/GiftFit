/**
 * /merchants (owner: A4, P8.4): the three ways to add GiftFit, a link to the store-URL preview, and the
 * Retailer Console until GiftFit Admin v0 lands, and what GiftFitPreviewBot does (its user agent links
 * here). Same dark look as the landing.
 */
import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { CodeBlock } from "@/components/site/CodeBlock";
import { btnPrimary, btnSecondary, Credits } from "@/components/site/Landing";
import { LandingRoot } from "@/components/site/LandingRoot";
import { giftfitSnippet } from "@/components/site/snippets";
import { translator, type MessageKey } from "@/lib/i18n";
import { siteLocale } from "@/lib/site/locale";
import { siteOrigin } from "@/lib/site/snippet";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "For merchants" };
// No `colorScheme: "dark"` meta: it would make the widget iframe (a light document) paint opaque.
export const viewport: Viewport = { themeColor: "#090b11" };

const PATHS: Array<[MessageKey, MessageKey]> = [
  ["landing.mPath1Title", "landing.mPath1"],
  ["landing.mPath2Title", "landing.mPath2"],
  ["landing.mPath3Title", "landing.mPath3"],
];

const ISSUES_URL = "https://github.com/agrhub/GiftFit/issues";
/** Same string as lib/ingest/safe-fetch.ts PREVIEW_USER_AGENT (kept literal so this page has no crawler import). */
const PREVIEW_BOT_UA = "GiftFitPreviewBot/1.0 (+https://giftfit-469920173665.us-central1.run.app/merchants)";
const ROBOTS_OPT_OUT = ["User-agent: GiftFitPreviewBot", "Disallow: /"].join("\n");

export default async function MerchantsPage() {
  const locale = siteLocale((await headers()).get("accept-language"));
  const tr = translator(locale);
  const origin = await siteOrigin();
  return (
    <LandingRoot lang={locale} testId="merchants">
      <div className="mx-auto max-w-4xl px-4 pt-4 pb-16 sm:px-6">
        <h1 className="mt-10 text-4xl font-bold tracking-tight sm:text-5xl">
          <span className="gf-gradient-text">{tr("site.merchantsTitle")}</span>
        </h1>
        <p className="mt-5 max-w-2xl text-lg leading-8 text-fog-300">{tr("landing.merchantsLead")}</p>

        <div className="mt-8">
          <CodeBlock code={giftfitSnippet(origin)} label="HTML" copyLabel={tr("site.copy")} copiedLabel={tr("site.copied")} testId="site-snippet" />
          <p className="mt-4 max-w-2xl text-sm leading-6 text-fog-300" data-testid="merchants-langs">
            {tr("landing.mLangs")}
          </p>
        </div>

        <ol className="mt-10 grid gap-4 sm:grid-cols-3" data-testid="merchant-paths">
          {PATHS.map(([title, text], i) => (
            <li key={title} className="rounded-3xl border border-night-700 bg-night-900 p-6">
              <span className="gf-gradient-text text-2xl font-bold">{String(i + 1).padStart(2, "0")}</span>
              <h2 className="mt-3 text-base font-semibold text-fog-100">{tr(title)}</h2>
              <p className="mt-2 text-sm leading-6 text-fog-300">{tr(text)}</p>
            </li>
          ))}
        </ol>
        <p className="mt-6">
          <Link href={"/#docs"} className="inline-flex min-h-11 items-center text-sm text-fog-100 underline decoration-glow-gold underline-offset-4" data-testid="merchants-guides">
            {tr("landing.mGuides")}
          </Link>
        </p>

        <section className="mt-12 rounded-[2rem] border border-night-700 bg-night-900 p-6 sm:p-8" aria-labelledby="m-preview">
          <h2 id="m-preview" className="text-2xl font-semibold text-fog-100">
            {tr("landing.mPreviewTitle")}
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-fog-300">{tr("landing.mPreviewText")}</p>
          <Link href={"/#try"} className={`${btnPrimary} mt-6`} data-testid="merchants-preview">
            {tr("landing.mPreviewLink")}
          </Link>
        </section>

        <section className="mt-8 flex flex-col gap-4 rounded-3xl border border-night-700 p-6 sm:flex-row sm:items-center sm:justify-between" aria-label={tr("site.merchantsConsole")}>
          <p className="text-sm leading-6 text-fog-300">{tr("landing.mAdmin")}</p>
          <Link href="/retailer" className={`${btnSecondary} shrink-0`} data-testid="merchants-console">
            {tr("site.merchantsConsole")}
          </Link>
        </section>

        <section id="bot" className="mt-12 scroll-mt-20 space-y-4" aria-labelledby="bot-title" data-testid="merchants-bot">
          <h2 id="bot-title" className="text-2xl font-semibold text-fog-100">
            {tr("landing.botTitle")}
          </h2>
          <p className="max-w-2xl text-sm leading-6 text-fog-300">{tr("landing.botIntro")}</p>
          <pre className="gf-code rounded-2xl border border-night-700 bg-night-900 p-4 font-mono text-[13px] leading-6 text-fog-100" tabIndex={0} data-testid="bot-ua">
            <code>{PREVIEW_BOT_UA}</code>
          </pre>
          <ul className="max-w-2xl list-disc space-y-2 pl-5 text-sm leading-6 text-fog-300 marker:text-glow-gold">
            <li>{tr("landing.botFetches")}</li>
            <li>{tr("landing.botLimits")}</li>
            <li>{tr("landing.botRetention")}</li>
          </ul>
          <p className="max-w-2xl text-sm leading-6 text-fog-300">{tr("landing.botOptOut")}</p>
          <CodeBlock code={ROBOTS_OPT_OUT} label="robots.txt" copyLabel={tr("site.copy")} copiedLabel={tr("site.copied")} testId="bot-robots" />
          <p className="max-w-2xl text-sm leading-6 text-fog-300">
            {tr("landing.botContact")}{" "}
            <a href={ISSUES_URL} className="inline-flex min-h-11 items-center text-fog-100 underline decoration-glow-gold underline-offset-4" rel="noopener noreferrer" data-testid="bot-contact">
              {tr("landing.botContactLink")}
            </a>
          </p>
        </section>

        <p className="mt-8 text-sm">
          <Link href={"/"} className="inline-flex min-h-11 items-center text-fog-300 underline underline-offset-4 hover:text-fog-100">
            {tr("site.home")}
          </Link>
        </p>
        <div className="mt-12 border-t border-night-700 pt-10">
          <Credits locale={locale} />
        </div>
      </div>
    </LandingRoot>
  );
}

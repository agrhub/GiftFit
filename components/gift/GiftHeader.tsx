"use client";
import { SiteHeader } from "@/components/site/SiteHeader";
import type { Locale } from "@/lib/i18n";
import { rt } from "@/lib/i18n/recipient";
import { UI_MOCK } from "./api";
import { useGiftLocale } from "./giftLocale";
import { useGiftStoreName } from "./giftStore";
import { ShieldIcon } from "./icons";

/**
 * Header for the gift pages: the shared GiftFit header (SiteHeader) with "for <store>" and "Private" in place
 * of the site links: no store navigation (the recipient shouldn't browse prices) and no way out of a private
 * flow that isn't in the page's language. The store is the request's own (the Aurum demo store, or a
 * store-URL preview's name, ADR-055), published by the page once it knows; until then only "GiftFit" shows.
 * Each gift page renders it (A26) with the locale it decided on the server, so the server HTML is already in
 * that language; a locale the page publishes later (giftLocale, A21: navigator.languages, the report's `lang`) takes over.
 */
export function GiftHeader({ locale: serverLocale = "en" }: { locale?: Locale }) {
  const storeName = useGiftStoreName();
  const locale = useGiftLocale(serverLocale);
  return (
    <>
      {UI_MOCK ? <p className="bg-gold-deep px-4 py-1 text-center text-xs font-medium text-white">UI mock mode: placeholder data, no AI calls</p> : null}
      <SiteHeader
        lang={locale}
        wordmarkHref={null}
        label={
          storeName ? (
            <span className="truncate text-[0.65rem] uppercase tracking-[0.24em] text-muted" data-testid="gift-header-store">
              {rt(locale, "header.for", { store: storeName })}
            </span>
          ) : null
        }
        right={
          <p className="flex shrink-0 items-center gap-1 rounded-full border border-sage/30 bg-sage/10 px-2.5 py-1 text-xs font-medium text-sage">
            <ShieldIcon className="h-4 w-4" /> {rt(locale, "header.private")}
          </p>
        }
      />
    </>
  );
}

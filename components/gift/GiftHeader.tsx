"use client";
import type { Locale } from "@/lib/i18n";
import { rt } from "@/lib/i18n/recipient";
import { UI_MOCK } from "./api";
import { useGiftLocale } from "./giftLocale";
import { useGiftStoreName } from "./giftStore";
import { ShieldIcon } from "./icons";

/**
 * Header for the gift pages: "GiftFit for <store>", no store navigation (the recipient shouldn't browse
 * prices). The store is the request's own (the Aurum demo store, or a store-URL preview's name, ADR-055),
 * published by the page once it knows; until then only "GiftFit" shows. Each gift page renders it (A26)
 * with the locale it decided on the server, so the server HTML is already in that language; a locale the
 * page publishes later (giftLocale, A21: navigator.languages, the report's `lang`) takes over.
 */
export function GiftHeader({ locale: serverLocale = "en" }: { locale?: Locale }) {
  const storeName = useGiftStoreName();
  const locale = useGiftLocale(serverLocale);
  return (
    <header className="border-b border-line bg-ivory" lang={locale}>
      {UI_MOCK ? <p className="bg-gold-deep px-4 py-1 text-center text-xs font-medium text-white">UI mock mode: placeholder data, no AI calls</p> : null}
      <div className="mx-auto flex h-14 max-w-3xl items-center justify-between px-4 sm:px-6">
        <p className="flex min-w-0 items-baseline gap-2">
          <span className="font-display text-2xl font-medium tracking-wide text-ink">GiftFit</span>
          {storeName ? (
            <span className="truncate text-[0.65rem] uppercase tracking-[0.24em] text-muted" data-testid="gift-header-store">
              {rt(locale, "header.for", { store: storeName })}
            </span>
          ) : null}
        </p>
        <p className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-sage">
          <ShieldIcon className="h-4 w-4" /> {rt(locale, "header.private")}
        </p>
      </div>
    </header>
  );
}

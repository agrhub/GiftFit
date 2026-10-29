"use client";
/**
 * The gift pages' UI locale for the gift header (A21). Each page renders the header with the locale it
 * decided on the server (A26: so the server HTML is already localized) and, once its client knows better
 * (navigator.languages, the report's own `lang`), publishes it here; the header follows. Until a page
 * publishes, and on the server, the header uses the server-decided locale it was given.
 */
import { useSyncExternalStore } from "react";
import type { Locale } from "@/lib/i18n";

let current: Locale | null = null;
const listeners = new Set<() => void>();

export function setGiftLocale(locale: Locale): void {
  if (locale === current) return;
  current = locale;
  for (const l of listeners) l();
}

/** The published locale, else `serverLocale` (the page's server-decided one; also the server snapshot). */
export function useGiftLocale(serverLocale: Locale = "en"): Locale {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current ?? serverLocale,
    () => serverLocale,
  );
}

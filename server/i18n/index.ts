/**
 * UI i18n for the embeddable widget (owner: A6, ADR-046). Pure and browser-safe.
 *
 *   const locale = detectLocale({ hostLang: "vi-VN", navigatorLanguages: ["en-US"], preferred: "en", allowed: ["en", "vi"] });
 *   t(locale, "chat.introPdp", { title: "Halo Drop Earrings" });
 *
 * Detection order (first supported AND allowed wins): the host page's <html lang>, the browser's
 * languages, the store default (`data-lang`), then the first allowed locale. Each shopper message whose
 * language is clear (detectLanguage, any language) then switches the UI to it when it is one of the ten,
 * else to English (uiLocaleFor). The Concierge replies in the language of the shopper's latest message
 * whatever the UI locale is.
 *
 * Widget locales (ADR-057): en and vi are reviewed; ja, ko, zh (Simplified), th, id, es, fr and de are
 * machine-translated and not yet reviewed by native speakers. They define every WidgetMessageKey; the
 * site, landing and preview-store pages stay en/vi (SITE_LOCALES) and their keys fall back to English.
 */
import { de } from "./de";
import { detectLanguage } from "./detect";
import { en, type MessageKey, type WidgetMessageKey } from "./en";
import { es } from "./es";
import { fr } from "./fr";
import { id } from "./id";
import { ja } from "./ja";
import { ko } from "./ko";
import { th } from "./th";
import { vi } from "./vi";
import { zh } from "./zh";

export type { MessageKey, WidgetMessageKey } from "./en";
export { baseLanguage, conversationLanguage, detectLanguage, languageName, type LanguageCode } from "./detect";

export const LOCALES = ["en", "vi", "ja", "ko", "zh", "th", "id", "es", "fr", "de"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

/** The GiftFit site (landing, merchants, preview-store pages) and its switcher: en/vi only. */
export const SITE_LOCALES = ["en", "vi"] as const satisfies readonly Locale[];
export type SiteLocale = (typeof SITE_LOCALES)[number];

/** Full catalogs for the site locales; widget-only catalogs for the others. */
export const CATALOGS: Record<SiteLocale, Record<MessageKey, string>> & Record<Exclude<Locale, SiteLocale>, Record<WidgetMessageKey, string>> = { en, vi, ja, ko, zh, th, id, es, fr, de };

/** The widget key set (every key but site.*, landing.* and pstore.*). */
export function isWidgetKey(key: string): key is WidgetMessageKey {
  return key in en && !/^(site|landing|pstore)\./.test(key);
}

/** Intl / BCP 47 tag per locale (number formats, browser voices). */
export const INTL_LOCALES: Record<Locale, string> = {
  en: "en-US", vi: "vi-VN", ja: "ja-JP", ko: "ko-KR", zh: "zh-CN", th: "th-TH", id: "id-ID", es: "es-ES", fr: "fr-FR", de: "de-DE",
};

export function isLocale(v: unknown): v is Locale {
  return typeof v === "string" && (LOCALES as readonly string[]).includes(v);
}

/** "vi-VN" → "vi", "EN_us" → "en", "zh-Hans-CN" → "zh"; anything unsupported → undefined. */
export function normalizeLocale(tag: unknown): Locale | undefined {
  if (typeof tag !== "string") return undefined;
  const base = tag.trim().toLowerCase().split(/[-_]/)[0];
  // Traditional Chinese (zh-TW, zh-HK, zh-Hant) is not offered: Simplified only.
  if (base === "zh" && /^zh[-_](hant|tw|hk|mo)\b/i.test(tag.trim())) return undefined;
  return isLocale(base) ? base : undefined;
}

/** "en, vi" / "en vi" / ["vi"] → supported locales in order, deduplicated; empty → all locales. */
export function parseLangList(raw: unknown): Locale[] {
  const parts = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,;]+/) : [];
  const out: Locale[] = [];
  for (const p of parts) {
    const l = normalizeLocale(p);
    if (l && !out.includes(l)) out.push(l);
  }
  return out.length ? out : [...LOCALES];
}

export interface DetectLocaleInput {
  /** The host page's `<html lang>`. */
  hostLang?: string | null;
  /** navigator.languages (or [navigator.language]). */
  navigatorLanguages?: readonly string[] | null;
  /** Store default (`data-lang`). */
  preferred?: string | null;
  /** Store allow-list (`data-langs`); empty = every supported locale. */
  allowed?: readonly Locale[] | null;
}

export function detectLocale(input: DetectLocaleInput): Locale {
  const allowed = input.allowed?.length ? input.allowed : LOCALES;
  const ok = (l: Locale | undefined): l is Locale => l !== undefined && allowed.includes(l);
  const candidates = [input.hostLang, ...(input.navigatorLanguages ?? []), input.preferred].map(normalizeLocale);
  return candidates.find(ok) ?? (ok(DEFAULT_LOCALE) ? DEFAULT_LOCALE : allowed[0]);
}

/**
 * The shopper's message as a widget locale, when its language is clear AND one of the ten (./detect
 * detectLanguage reads any language); undefined otherwise, so the UI never switches to a locale it
 * doesn't have. Callers decide what an unoffered language means (the widget shows English: uiLocaleFor).
 */
export function localeFromText(text: string): Locale | undefined {
  const l = detectLanguage(text);
  return isLocale(l) ? l : undefined;
}

/** The widget locale for any language tag or detected code: itself when it is one of the ten, else English. */
export function uiLocaleFor(lang: string | null | undefined): Locale {
  return normalizeLocale(lang ?? undefined) ?? DEFAULT_LOCALE;
}

/** Interpolates {name} placeholders; unknown placeholders are left as is. */
export function format(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

export function t(locale: Locale, key: MessageKey, vars?: Record<string, string | number>): string {
  const cat = CATALOGS[locale] as Partial<Record<MessageKey, string>> | undefined;
  return format(cat?.[key] ?? en[key], vars);
}

/** A translator bound to one locale (handy for components). */
export function translator(locale: Locale): (key: MessageKey, vars?: Record<string, string | number>) => string {
  return (key, vars) => t(locale, key, vars);
}

/** Price in the locale's number style (INTL_LOCALES); the currency comes from the catalog. */
export function formatMoney(locale: Locale, amount: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat(INTL_LOCALES[locale] ?? "en-US", { style: "currency", currency, maximumFractionDigits: amount % 1 === 0 ? 0 : 2 }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

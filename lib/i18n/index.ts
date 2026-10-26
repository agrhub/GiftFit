/**
 * UI i18n for the embeddable widget (owner: A6, ADR-046). Pure and browser-safe.
 *
 *   const locale = detectLocale({ hostLang: "vi-VN", navigatorLanguages: ["en-US"], preferred: "en", allowed: ["en", "vi"] });
 *   t(locale, "chat.introPdp", { title: "Halo Drop Earrings" });
 *
 * Detection order (first supported AND allowed wins): the host page's <html lang>, the browser's
 * languages, the store default (`data-lang`), then the first allowed locale. Once the shopper writes
 * their first message, `localeFromText` may switch the UI to the language they actually use.
 * The Concierge itself replies in the shopper's language whatever the UI locale is.
 */
import { en, type MessageKey } from "./en";
import { vi } from "./vi";

export type { MessageKey } from "./en";

export const LOCALES = ["en", "vi"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

export const CATALOGS: Record<Locale, Record<MessageKey, string>> = { en, vi };

export function isLocale(v: unknown): v is Locale {
  return typeof v === "string" && (LOCALES as readonly string[]).includes(v);
}

/** "vi-VN" → "vi", "EN_us" → "en"; anything unsupported → undefined. */
export function normalizeLocale(tag: unknown): Locale | undefined {
  if (typeof tag !== "string") return undefined;
  const base = tag.trim().toLowerCase().split(/[-_]/)[0];
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

/** Vietnamese-only letters (tone marks and đ); plain ASCII Vietnamese is caught by common words. */
const VI_LETTERS = /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i;
const VI_WORDS = /(^|[^\p{L}])(toi|minh|tang|qua|cho|me|vo|chong|ban|sinh nhat|khoang|trieu|nghin|em|anh|chi)([^\p{L}]|$)/iu;

/**
 * The language of a shopper's message, when it is clear enough to switch the UI: "vi" for text with
 * Vietnamese letters (or several unaccented Vietnamese words), "en" for plain Latin text, undefined
 * for anything else (too short, other scripts).
 */
export function localeFromText(text: string): Locale | undefined {
  const s = text.normalize("NFC").trim();
  if (s.length < 3) return undefined;
  if (VI_LETTERS.test(s)) return "vi";
  const viWords = s.toLowerCase().split(/\s+/).filter((w) => VI_WORDS.test(w)).length;
  if (viWords >= 2) return "vi";
  if (/^[\p{Script=Latin}\p{N}\p{P}\p{Zs}$€£¥₫]+$/u.test(s)) return "en";
  return undefined;
}

/** Interpolates {name} placeholders; unknown placeholders are left as is. */
export function format(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

export function t(locale: Locale, key: MessageKey, vars?: Record<string, string | number>): string {
  return format(CATALOGS[locale]?.[key] ?? en[key], vars);
}

/** A translator bound to one locale (handy for components). */
export function translator(locale: Locale): (key: MessageKey, vars?: Record<string, string | number>) => string {
  return (key, vars) => t(locale, key, vars);
}

/** Price in the locale's number style (en-US / vi-VN); the currency comes from the catalog. */
export function formatMoney(locale: Locale, amount: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat(locale === "vi" ? "vi-VN" : "en-US", { style: "currency", currency, maximumFractionDigits: amount % 1 === 0 ? 0 : 2 }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

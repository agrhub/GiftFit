/**
 * Fit Report i18n (owner: A22). The giver's report follows the language they used when the Fit Request
 * was made (`StoredFitRequest.giverLang`, mapped with `uiLocaleFor`: one of the ten UI locales, else
 * English). Pure and browser-safe: lib/fit renders the reason, caution and taste templates with it, and
 * the /g page renders the UI.
 *
 * en is the source catalog; vi, ja, ko, zh, th, id, es, fr and de are machine-translated and
 * not yet reviewed by native speakers (as the widget catalogs, ADR-057).
 */
import { INTL_LOCALES, type Locale, format, languageName } from "@/lib/i18n";
import { de } from "./de";
import { en, type ReportMessageKey } from "./en";
import { es } from "./es";
import { fr } from "./fr";
import { id } from "./id";
import { ja } from "./ja";
import { ko } from "./ko";
import { th } from "./th";
import { vi } from "./vi";
import { zh } from "./zh";

export type { ReportMessageKey } from "./en";

export const REPORT_CATALOGS: Record<Locale, Record<ReportMessageKey, string>> = { en, vi, ja, ko, zh, th, id, es, fr, de };

/** One report string, {placeholders} filled; English for a key a catalog lacks. */
export function rt(locale: Locale, key: ReportMessageKey, vars?: Record<string, string | number>): string {
  return format(REPORT_CATALOGS[locale]?.[key] ?? en[key], vars);
}

/** A translator bound to one locale (components). */
export function reportTranslator(locale: Locale): (key: ReportMessageKey, vars?: Record<string, string | number>) => string {
  return (key, vars) => rt(locale, key, vars);
}

/** First letter upper-cased (a no-op for scripts without case), as lib/fit `capitalize` did for English. */
export function sentence(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A sentence built from a template: filled, then sentence-cased. */
export function rs(locale: Locale, key: ReportMessageKey, vars?: Record<string, string | number>): string {
  return sentence(rt(locale, key, vars));
}

/** Sentences joined into a paragraph: no space between Japanese or Chinese sentences. */
export function joinSentences(locale: Locale, parts: readonly string[]): string {
  return parts.join(locale === "ja" || locale === "zh" ? "" : " ");
}

/** "a, b and c" (English keeps the engine's original form, no serial comma); Intl elsewhere. */
export function listOf(locale: Locale, xs: readonly string[]): string {
  if (xs.length <= 1) return xs[0] ?? "";
  if (locale !== "en") {
    try {
      return new Intl.ListFormat(INTL_LOCALES[locale], { style: "long", type: "conjunction" }).format(xs);
    } catch {
      /* fall through */
    }
  }
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

/** The language the model must write in: English name plus BCP-47 code, e.g. { code: "vi", name: "Vietnamese" }. */
export function reportLanguage(locale: Locale): { code: Locale; name: string } {
  return { code: locale, name: languageName(locale) };
}

/** A date and time in the locale's style (the giver's own time zone in the browser). */
export function reportDateTime(locale: Locale, iso: string | Date | undefined, opts: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" }): string | undefined {
  if (!iso) return undefined;
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return undefined;
  try {
    return d.toLocaleString(INTL_LOCALES[locale], opts);
  } catch {
    return d.toISOString();
  }
}

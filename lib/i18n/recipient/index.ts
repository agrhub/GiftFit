/**
 * Recipient page i18n (owner: A21). Pure and browser-safe.
 *
 *   const locale = recipientLocale({ browserLanguages: ["de-DE", "en"], giverLang: "vi" }); // "de"
 *   rt(locale, "intro.tryOn", { count: 6 });
 *
 * Locale rule: the recipient's browser language when it is one of the ten UI locales (any position in
 * Accept-Language / navigator.languages), else the giver's conversation language (stored with the Fit
 * Request, uiLocaleFor), else English. The server decides from Accept-Language so the first paint is
 * already in the right language; the client only corrects it when navigator.languages disagrees.
 *
 * en is reviewed; the other nine are machine-translated and not yet reviewed by native speakers.
 */
import { DEFAULT_LOCALE, format, INTL_LOCALES, normalizeLocale, uiLocaleFor, type Locale } from "..";
import { de } from "./de";
import { en, type RecipientMessageKey } from "./en";
import { es } from "./es";
import { fr } from "./fr";
import { id } from "./id";
import { ja } from "./ja";
import { ko } from "./ko";
import { th } from "./th";
import { vi } from "./vi";
import { zh } from "./zh";

export type { RecipientMessageKey } from "./en";
export { en as recipientEn } from "./en";

export const RECIPIENT_CATALOGS: Record<Locale, Record<RecipientMessageKey, string>> = { en, vi, ja, ko, zh, th, id, es, fr, de };

type Vars = Record<string, string | number>;

export function rt(locale: Locale, key: RecipientMessageKey, vars?: Vars): string {
  return format(RECIPIENT_CATALOGS[locale]?.[key] ?? en[key], vars);
}

type PluralBase<K extends string> = K extends `${infer B}_one` ? B : never;
export type RecipientPluralKey = PluralBase<RecipientMessageKey>;

/** `<base>_one` or `<base>_other` by the locale's plural rules, with {count} filled in. */
export function rtCount(locale: Locale, base: RecipientPluralKey, count: number, vars?: Vars): string {
  let one = count === 1;
  try {
    one = new Intl.PluralRules(INTL_LOCALES[locale]).select(count) === "one";
  } catch {
    // Old engines: English rule.
  }
  return rt(locale, `${base}_${one ? "one" : "other"}` as RecipientMessageKey, { count, ...vars });
}

/** A translator bound to one locale (handy for components). */
export function recipientTranslator(locale: Locale) {
  return Object.assign((key: RecipientMessageKey, vars?: Vars) => rt(locale, key, vars), {
    count: (base: RecipientPluralKey, count: number, vars?: Vars) => rtCount(locale, base, count, vars),
    locale,
  });
}
export type RecipientT = ReturnType<typeof recipientTranslator>;

/** "de-DE,de;q=0.9,en;q=0.5" → ["de-DE", "de", "en"], by q (stable), q=0 dropped. */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((part, i) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((p) => /^\s*q=([\d.]+)\s*$/.exec(p)).find(Boolean);
      return { tag: tag.trim(), q: q ? Number(q[1]) : 1, i };
    })
    .filter((x) => x.tag && x.tag !== "*" && x.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i)
    .map((x) => x.tag);
}

export interface RecipientLocaleInput {
  /** navigator.languages, or the parsed Accept-Language header. */
  browserLanguages?: readonly string[] | null;
  /** The giver's conversation language (StoredFitRequest.giverLang); any BCP-47 tag. */
  giverLang?: string | null;
}

/** Browser language if one of the ten, else the giver's (uiLocaleFor: one of the ten, else English). */
export function recipientLocale(input: RecipientLocaleInput): Locale {
  for (const tag of input.browserLanguages ?? []) {
    const l = normalizeLocale(tag);
    if (l) return l;
  }
  return input.giverLang ? uiLocaleFor(input.giverLang) : DEFAULT_LOCALE;
}

/**
 * The localized form of an English string that comes from shared code or the server (photo checks,
 * metal names, face-shape labels): the key under `prefix` whose English text matches, else the text as is.
 */
export function fromEnglish(locale: Locale, prefix: string, text: string): string {
  if (locale === "en") return text;
  const key = ENGLISH_INDEX.get(`${prefix}|${text}`);
  return key ? rt(locale, key) : text;
}
const ENGLISH_INDEX = new Map<string, RecipientMessageKey>(
  (Object.entries(en) as Array<[RecipientMessageKey, string]>).map(([k, v]) => [`${k.slice(0, k.indexOf(".") + 1)}|${v}`, k]),
);

/** A metal name inside a sentence ("Trying on yellow gold…"): lower-cased where the language does that. */
export function metalInline(locale: Locale, label: string): string {
  const name = fromEnglish(locale, "metal.", label);
  return ["en", "es", "fr", "id", "vi"].includes(locale) ? name.toLocaleLowerCase(INTL_LOCALES[locale]) : name;
}

/** The server's English face-shape label ("Oval face shape (estimate)", "Face shape not detected") localized. */
export function faceShapeText(locale: Locale, label: string): string {
  if (locale === "en") return label;
  if (label === en["faceShape.none"]) return rt(locale, "faceShape.none");
  const m = /^(.+) face shape \(estimate\)$/.exec(label);
  if (!m) return label;
  const word = fromEnglish(locale, "faceShape.", m[1]);
  return word === m[1] ? label : rt(locale, "faceShape.label", { shape: word });
}

/** The link's expiry in the locale ("29 Oct 2026, 14:00 UTC"). */
export function formatExpiry(locale: Locale, expiresAt: Date | string | undefined): string | undefined {
  if (!expiresAt) return undefined;
  const d = typeof expiresAt === "string" ? new Date(expiresAt) : expiresAt;
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toLocaleString(INTL_LOCALES[locale], { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC";
}

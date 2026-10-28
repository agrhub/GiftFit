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
 *
 * Widget locales (ADR-057): en and vi are reviewed; ja, ko, zh (Simplified), th, id, es, fr and de are
 * machine-translated and not yet reviewed by native speakers. They define every WidgetMessageKey; the
 * site, landing and preview-store pages stay en/vi (SITE_LOCALES) and their keys fall back to English.
 */
import { de } from "./de";
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
 * Vietnamese-only letters (ă đ ơ ư and the dotted/hooked tone letters). â ê ô are left out: French
 * uses them too. Plain ASCII Vietnamese is caught by common words.
 */
const VI_LETTERS = /[ăđơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịĩọỏốồổỗộớờởỡợụủũứừửữựỳỵỷỹ]/i;
const VI_WORDS = new Set(["toi", "minh", "tang", "qua", "cho", "me", "vo", "chong", "ban", "sinh", "nhat", "khoang", "trieu", "nghin", "em", "anh", "chi"]);

/**
 * Common, distinctive words per Latin-script language (stop words plus gift vocabulary). Words shared
 * by two candidates (de, la, en, que, un, a, budget…) are left out on purpose.
 */
const LATIN_WORDS: Record<"en" | "id" | "es" | "fr" | "de", ReadonlySet<string>> = {
  en: new Set(["the", "and", "for", "my", "is", "i", "im", "i'm", "to", "of", "with", "her", "his", "him", "she", "he", "gift", "present", "birthday", "anniversary", "under", "want", "looking", "need", "something", "wife", "husband", "mom", "mum", "mother", "sister", "girlfriend", "boyfriend", "what", "can", "you", "please", "help", "earrings", "necklace", "around", "about", "maybe", "some", "this", "that", "would", "like"]),
  id: new Set(["untuk", "yang", "dan", "saya", "aku", "ini", "itu", "ada", "dengan", "hadiah", "kado", "ulang", "tahun", "ibu", "istri", "suami", "adik", "kakak", "pacar", "mau", "ingin", "cari", "mencari", "buat", "anggaran", "sekitar", "ke", "dari", "tidak", "bisa", "apa", "perhiasan", "cincin", "kalung", "anting", "gelang", "juta", "ribu", "dong", "tolong", "bantu"]),
  es: new Set(["el", "los", "las", "una", "para", "mi", "mis", "con", "por", "es", "y", "del", "regalo", "cumpleaños", "aniversario", "esposa", "esposo", "mamá", "madre", "hermana", "novia", "novio", "quiero", "busco", "buscando", "menos", "hasta", "algo", "collar", "pendientes", "aretes", "anillo", "pulsera", "presupuesto", "ayúdame", "ayuda", "dólares", "hola", "gracias", "cuánto"]),
  fr: new Set(["le", "les", "des", "du", "une", "pour", "mon", "ma", "mes", "est", "et", "avec", "je", "cadeau", "anniversaire", "femme", "mari", "mère", "maman", "sœur", "soeur", "copine", "cherche", "moins", "boucles", "oreilles", "collier", "bague", "voudrais", "veux", "offrir", "quelque", "chose", "bonjour", "merci", "aidez", "aide", "noël", "fête"]),
  de: new Set(["der", "die", "das", "und", "für", "mein", "meine", "meiner", "meinen", "ist", "ich", "ein", "eine", "einen", "mit", "geschenk", "geburtstag", "jahrestag", "frau", "mann", "mutter", "mama", "schwester", "freundin", "suche", "unter", "bis", "etwas", "ohrringe", "kette", "halskette", "armband", "möchte", "zum", "zur", "von", "nicht", "hallo", "danke", "hilf", "bitte", "weihnachten"]),
};

/** Letters that point to one Latin-script language. */
const LATIN_HINTS: Array<["es" | "fr" | "de", RegExp]> = [
  ["es", /[ñ¿¡]/i],
  ["fr", /[çœèàùûîï]|\bêtre\b/i],
  ["de", /[ßäö]/i],
];

/**
 * The language of a shopper's message, when it is clear enough to switch the UI; undefined when it
 * is not (too short, mixed, or a language the widget doesn't offer), so the UI stays where it is.
 *   - scripts: Hangul → ko, kana (with or without kanji) → ja, Thai → th, Han without kana → zh;
 *   - Vietnamese letters, or two or more unaccented Vietnamese words → vi;
 *   - other Latin text: a small stop-word count (plus ñ/ç/ß-style letters) for en, id, es, fr, de;
 *     the best score wins, a tie or no hit is undefined.
 */
export function localeFromText(text: string): Locale | undefined {
  const s = text.normalize("NFC").trim();
  const letters = (s.match(/\p{L}/gu) ?? []).length;
  if (letters < 2) return undefined;
  const share = (re: RegExp) => (s.match(re) ?? []).length / letters;
  if (share(/\p{Script=Hangul}/gu) >= 0.3) return "ko";
  const kana = share(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu);
  if (kana > 0 && kana + share(/\p{Script=Han}/gu) >= 0.3) return "ja";
  if (share(/\p{Script=Thai}/gu) >= 0.3) return "th";
  if (share(/\p{Script=Han}/gu) >= 0.3) return "zh";

  if (s.length < 3 || share(/\p{Script=Latin}/gu) < 0.7) return undefined;
  if (VI_LETTERS.test(s)) return "vi";
  const words = s.toLowerCase().replace(/[’‘]/g, "'").split(/[^\p{L}']+/u).filter(Boolean);
  if (words.filter((w) => VI_WORDS.has(w)).length >= 2) return "vi";
  const scores = Object.entries(LATIN_WORDS).map(([l, set]) => [l, words.filter((w) => set.has(w) || w.split("'").some((part) => set.has(part))).length] as [Locale, number]);
  for (const [l, re] of LATIN_HINTS) if (re.test(s)) scores.find(([x]) => x === l)![1] += 2;
  scores.sort((x, y) => y[1] - x[1]);
  const [[best, top], [, second]] = scores;
  return top > 0 && top > second ? best : undefined;
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

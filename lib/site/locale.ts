/**
 * Site locale (owner: A6): `?lang=en|vi` wins, else the browser's Accept-Language, else English. Same
 * catalogs and rules as the widget (lib/i18n detectLocale), limited to SITE_LOCALES (en/vi): the
 * widget's other languages (ADR-057) don't apply to the site, landing or preview-store pages.
 */
import { detectLocale, normalizeLocale, SITE_LOCALES, type SiteLocale } from "@/lib/i18n";

const isSiteLocale = (l: unknown): l is SiteLocale => (SITE_LOCALES as readonly unknown[]).includes(l);

/** "vi-VN,vi;q=0.9,en;q=0.5" → ["vi-VN", "vi", "en"] by descending q. */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((part, i) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      const weight = q ? Number(q.slice(2)) : 1;
      return { tag: tag.trim(), weight: Number.isFinite(weight) ? weight : 0, i };
    })
    .filter((x) => x.tag && x.tag !== "*" && x.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.i - b.i)
    .map((x) => x.tag);
}

export function siteLocale(langParam: unknown, acceptLanguage: string | null | undefined): SiteLocale {
  const forced = normalizeLocale(typeof langParam === "string" ? langParam : undefined);
  if (isSiteLocale(forced)) return forced;
  const l = detectLocale({ navigatorLanguages: parseAcceptLanguage(acceptLanguage), allowed: SITE_LOCALES });
  return isSiteLocale(l) ? l : "en";
}

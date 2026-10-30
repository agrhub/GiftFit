/**
 * HTML → `RenderedPage` (text, images, links, JSON-LD, meta) with cheerio. Used for every tier and for
 * both live Playwright renders and INGEST_FIXTURE=1 snapshots, so both take the same code path.
 */
import * as cheerio from "cheerio";

/** domhandler's AnyNode, without depending on domhandler directly. */
export type AnyNode = Parameters<typeof cheerio.contains>[0];
export type Sel = cheerio.Cheerio<AnyNode>;

export interface RenderedPage {
  url: string;
  /** Post-JavaScript HTML (Tier 3) or the fetched HTML (Tier 2). */
  html: string;
  /** Visible text with one line per block element, scripts and styles removed. */
  text: string;
  /**
   * Visible text of the main product region only (header, footer, nav, aside and "related / you may
   * also like" sections removed). Product-specific fields are grounded against this.
   */
  mainText: string;
  /** Absolute image URLs in document order (deduplicated, no data: URIs, no SVG icons). */
  images: string[];
  /** Absolute same-host link URLs (deduplicated, fragment removed). */
  links: string[];
  /** Parsed `application/ld+json` blocks. */
  jsonLd: unknown[];
  /** `<meta property|name>` values, lower-cased keys (og:title, product:price:amount, …). */
  meta: Record<string, string>;
}

const BLOCKS =
  "p,div,li,tr,td,th,h1,h2,h3,h4,h5,h6,section,article,header,footer,br,dt,dd,table,ul,ol,main,aside,nav,figure,figcaption,button,label,span.line";

export function absolutise(href: string | undefined, base: string): string | null {
  if (!href) return null;
  const h = href.trim();
  if (!h || h.startsWith("data:") || h.startsWith("javascript:") || h.startsWith("mailto:") || h.startsWith("tel:")) return null;
  try {
    const u = new URL(h, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.href;
  } catch {
    return null;
  }
}

/** Largest candidate in a srcset ("a.jpg 400w, b.jpg 800w" → b.jpg). */
export function largestFromSrcset(srcset: string | undefined): string | undefined {
  if (!srcset) return undefined;
  let best: { url: string; size: number } | undefined;
  for (const part of srcset.split(",")) {
    const [url, d] = part.trim().split(/\s+/);
    if (!url) continue;
    const size = d ? parseFloat(d) : 1;
    if (!best || size > best.size) best = { url, size: Number.isFinite(size) ? size : 1 };
  }
  return best?.url;
}

export function visibleText($: cheerio.CheerioAPI, root?: Sel): string {
  const scope: Sel = root ?? ($("body").length ? $("body") : $.root());
  const clone = $(scope).clone();
  clone.find("script,style,noscript,template,svg").remove();
  clone.find(BLOCKS).each((_, el) => {
    $(el).append("\n");
  });
  return clone
    .text()
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

export function imageUrls($: cheerio.CheerioAPI, base: string, root?: Sel): string[] {
  const out: string[] = [];
  const scope: Sel = root ?? $.root();
  $(scope)
    .find("img, source")
    .each((_, el) => {
      const $el = $(el);
      const cand = largestFromSrcset($el.attr("srcset") ?? $el.attr("data-srcset")) ?? $el.attr("src") ?? $el.attr("data-src");
      const abs = absolutise(cand, base);
      if (!abs || /\.svg(\?|$)/i.test(abs)) return;
      if (!out.includes(abs)) out.push(abs);
    });
  return out;
}

export function parseJsonLd($: cheerio.CheerioAPI): unknown[] {
  const out: unknown[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    try {
      out.push(JSON.parse(raw));
    } catch {
      // Malformed JSON-LD is common; skip the block rather than guess.
    }
  });
  return out;
}

const RELATED_RE = /you may also like|related|recommended|similar|recently viewed|complete the look|customers also|more from/i;

/**
 * The main product region of a page. Mutates `$`: removes header, footer, nav, aside and related-product
 * sections first, then returns the first of: schema.org Product microdata, [data-product], main,
 * #product, .product, article, body.
 */
export function mainRegion($: cheerio.CheerioAPI): Sel {
  $("script,style,noscript,template,header,footer,nav,aside,[data-related],.related,.recommendations,[role=complementary]").remove();
  $("section,div").each((_, el) => {
    const heading = $(el).children("h2,h3,h4").first().text();
    if (heading && RELATED_RE.test(heading)) $(el).remove();
  });
  for (const sel of ['[itemtype*="schema.org/Product"]', "[data-product]", "main", "#product", ".product", "article"]) {
    const m = $(sel).first();
    if (m.length) return m;
  }
  return $("body");
}

export function pageFromHtml(html: string, url: string): RenderedPage {
  const $ = cheerio.load(html);
  const host = new URL(url).host;
  const links: string[] = [];
  $("a[href]").each((_, el) => {
    const abs = absolutise($(el).attr("href"), url);
    if (abs && new URL(abs).host === host && !links.includes(abs)) links.push(abs);
  });
  const meta: Record<string, string> = {};
  $("meta[content]").each((_, el) => {
    const key = ($(el).attr("property") ?? $(el).attr("name") ?? $(el).attr("itemprop") ?? "").toLowerCase();
    if (key && !(key in meta)) meta[key] = $(el).attr("content") ?? "";
  });
  const text = visibleText($);
  const images = imageUrls($, url);
  const jsonLd = parseJsonLd($);
  const $main = cheerio.load(html);
  const mainText = visibleText($main, mainRegion($main));
  return { url, html, text, mainText, images, links, jsonLd, meta };
}

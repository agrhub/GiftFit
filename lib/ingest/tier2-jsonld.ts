/**
 * Tier 2: sitemap discovery + schema.org `Product` JSON-LD, with Open Graph product tags as fallback.
 */
import { XMLParser } from "fast-xml-parser";
import type { RenderedPage } from "./html";
import type { PoliteFetcher } from "./politeness";
import type { ExtractedProduct, RawProduct } from "./types";
import { normaliseCurrency, parseAmount } from "./normalise";

export const MAX_SITEMAPS = 25;

const asArray = <T>(v: T | T[] | undefined | null): T[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

export function parseSitemap(xml: string): { urls: string[]; sitemaps: string[] } {
  const doc = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true }).parse(xml) as {
    urlset?: { url?: { loc?: string } | { loc?: string }[] };
    sitemapindex?: { sitemap?: { loc?: string } | { loc?: string }[] };
  };
  const loc = (x: { loc?: string }) => (typeof x.loc === "string" ? x.loc.trim() : "");
  return {
    urls: asArray(doc.urlset?.url).map(loc).filter(Boolean),
    sitemaps: asArray(doc.sitemapindex?.sitemap).map(loc).filter(Boolean),
  };
}

/** Path patterns that usually hold one product (Shopify, WooCommerce, Next.js stores, Magento .html). */
export const PRODUCT_PATH_RE = /\/(products?|p|item|items|shop\/[^/]+)\/[^/?#]+\/?$|\/[^/]+-p\d+\.html?$|\/[a-z0-9-]+-\d{4,}\.html?$/i;

export function isProductUrl(url: string, fromProductSitemap = false): boolean {
  try {
    const u = new URL(url);
    if (fromProductSitemap) return u.pathname !== "/";
    return PRODUCT_PATH_RE.test(u.pathname) && !/\/page\/\d+\/?$/i.test(u.pathname);
  } catch {
    return false;
  }
}

/** Product URLs from robots.txt sitemaps (or /sitemap.xml), following sitemap indexes. */
export async function discoverFromSitemaps(fetcher: PoliteFetcher, storeBase: string, maxUrls = 1_000): Promise<string[]> {
  const host = new URL(storeBase).host;
  const queue = [...(await fetcher.sitemapsFor(storeBase))];
  if (queue.length === 0) queue.push(new URL("/sitemap.xml", storeBase).href);
  const seen = new Set<string>();
  const urls: string[] = [];
  while (queue.length && seen.size < MAX_SITEMAPS && urls.length < maxUrls) {
    const sm = queue.shift()!;
    if (seen.has(sm) || new URL(sm).host !== host) continue;
    seen.add(sm);
    let res;
    try {
      res = await fetcher.get(sm);
    } catch {
      continue;
    }
    if (res.status !== 200) continue;
    const { urls: found, sitemaps } = parseSitemap(res.body);
    queue.push(...sitemaps.filter((s) => !/image|video|blog|post|page|collection|categor/i.test(s) || /product/i.test(s)));
    const productSitemap = /product/i.test(sm);
    for (const u of found) {
      if (!isProductUrl(u, productSitemap) || new URL(u).host !== host || urls.includes(u)) continue;
      if (await fetcher.isAllowed(u)) urls.push(u);
    }
  }
  return urls.slice(0, maxUrls);
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);
const typesOf = (n: Json): string[] => asArray(n["@type"] as string | string[]).map(String);

/** All JSON-LD nodes (top level, arrays and `@graph`). */
export function flattenJsonLd(blocks: unknown[]): Json[] {
  const out: Json[] = [];
  const visit = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (isObj(v)) {
      out.push(v);
      if (Array.isArray(v["@graph"])) v["@graph"].forEach(visit);
    }
  };
  blocks.forEach(visit);
  return out;
}

function offerPrice(offers: unknown): { price: number | null; currency: string | null } {
  for (const o of asArray(offers as Json | Json[])) {
    if (!isObj(o)) continue;
    const spec = isObj(o.priceSpecification) ? o.priceSpecification : undefined;
    const raw = o.price ?? o.lowPrice ?? spec?.price;
    const price = typeof raw === "number" ? raw : typeof raw === "string" ? parseAmount(raw) : null;
    const currency = normaliseCurrency(str(o.priceCurrency) ?? str(spec?.priceCurrency));
    if (price !== null) return { price, currency };
  }
  return { price: null, currency: null };
}

function imagesOf(v: unknown, base: string): string[] {
  const out: string[] = [];
  for (const i of asArray(v as unknown[])) {
    const u = typeof i === "string" ? i : isObj(i) ? str(i.url) ?? str(i.contentUrl) : null;
    if (!u) continue;
    try {
      const abs = new URL(u, base).href;
      if (!out.includes(abs)) out.push(abs);
    } catch {
      /* skip */
    }
  }
  return out;
}

/** schema.org Product (or the first variant of a ProductGroup) → ExtractedProduct, else null. */
export function productFromJsonLd(blocks: unknown[], pageUrl: string): ExtractedProduct | null {
  const nodes = flattenJsonLd(blocks);
  let p = nodes.find((n) => typesOf(n).includes("Product"));
  const group = nodes.find((n) => typesOf(n).includes("ProductGroup"));
  if (!p && group) p = { ...group, ...(asArray(group.hasVariant as Json[])[0] ?? {}) };
  if (!p) return null;
  const { price, currency } = offerPrice(p.offers);
  const brand = isObj(p.brand) ? str(p.brand.name) : str(p.brand);
  const props = asArray(p.additionalProperty as Json[]).filter(isObj);
  const prop = (re: RegExp) => str(props.find((x) => re.test(String(x.name ?? "")))?.value);
  const description = str(p.description);
  return {
    title: str(p.name),
    price,
    currency,
    images: imagesOf(p.image, pageUrl),
    metal: str(p.material) ?? prop(/metal|material/i),
    stone: prop(/stone|gem/i),
    category: str(p.category),
    length: prop(/length/i),
    sku: str(p.sku) ?? str(p.mpn),
    brand,
    description: description ? description.slice(0, 600) : null,
  };
}

/** Open Graph product tags → ExtractedProduct, only when og:type is product. */
export function productFromOpenGraph(page: Pick<RenderedPage, "meta" | "url">): ExtractedProduct | null {
  const m = page.meta;
  if (!/product/i.test(m["og:type"] ?? "")) return null;
  const amount = m["product:price:amount"] ?? m["og:price:amount"];
  const img = m["og:image"] ?? m["og:image:url"];
  return {
    title: m["og:title"] || null,
    price: amount ? parseAmount(amount) : null,
    currency: normaliseCurrency(m["product:price:currency"] ?? m["og:price:currency"]),
    images: img ? imagesOf(img, page.url) : [],
    metal: null,
    stone: null,
    category: null,
    length: null,
    sku: null,
    brand: m["product:brand"] || m["og:site_name"] || null,
    description: m["og:description"] ? m["og:description"].slice(0, 600) : null,
  };
}

export function rawFromTier2(page: RenderedPage): RawProduct | null {
  const p = productFromJsonLd(page.jsonLd, page.url) ?? productFromOpenGraph(page);
  if (!p || !p.title) return null;
  const slug = new URL(page.url).pathname.split("/").filter(Boolean).pop() ?? page.url;
  return { ...p, sourceUrl: page.url, externalId: p.sku ?? slug, tier: 2, tags: [] };
}

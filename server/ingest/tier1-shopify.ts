/**
 * Tier 1: Shopify `/products.json` (public, paginated; docs/ingest-policy.md). Currency comes from
 * `/meta.json` (`currency`) because products.json carries none; if that is unavailable it stays null.
 *
 * Jewelry stores often sell one product in several metals as variants (option "Metal"). Each distinct
 * canonical metal becomes its own SKU (`<productId>:<metal>`), priced at that metal's lowest variant,
 * because try-on and undertone fit differ per metal.
 */
import * as cheerio from "cheerio";
import type { PoliteFetcher } from "./politeness";
import { canonicalMetal } from "./normalise";
import type { RawProduct } from "./types";

export const SHOPIFY_PAGE_LIMIT = 250;
export const SHOPIFY_MAX_PAGES = 40;

export interface ShopifyVariant {
  id: number | string;
  title?: string;
  sku?: string | null;
  price?: string | number | null;
  option1?: string | null;
  option2?: string | null;
  option3?: string | null;
  available?: boolean;
}
export interface ShopifyProduct {
  id: number | string;
  title?: string;
  handle?: string;
  body_html?: string | null;
  vendor?: string | null;
  product_type?: string | null;
  tags?: string[] | string;
  variants?: ShopifyVariant[];
  images?: { src?: string }[];
  options?: { name?: string; position?: number; values?: string[] }[];
}

const htmlToText = (html: string | null | undefined): string | null => {
  if (!html) return null;
  const t = cheerio.load(html).root().text().replace(/\s+/g, " ").trim();
  return t ? t.slice(0, 600) : null;
};

const toTags = (tags: ShopifyProduct["tags"]): string[] =>
  Array.isArray(tags) ? tags : typeof tags === "string" ? tags.split(",").map((t) => t.trim()).filter(Boolean) : [];

const priceOf = (v: ShopifyVariant): number | null => {
  const n = typeof v.price === "number" ? v.price : v.price ? Number(v.price) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const minPrice = (vs: ShopifyVariant[]): number | null => {
  const ps = vs.map(priceOf).filter((p): p is number => p !== null);
  return ps.length ? Math.min(...ps) : null;
};

/** One Shopify product → one RawProduct per distinct canonical metal (or one if no metal option). */
export function parseShopifyProduct(p: ShopifyProduct, storeBase: string, currency: string | null): RawProduct[] {
  const variants = p.variants ?? [];
  const images = (p.images ?? []).map((i) => i.src).filter((s): s is string => Boolean(s));
  const handle = p.handle ?? String(p.id);
  const base: RawProduct = {
    title: p.title?.trim() || null,
    price: minPrice(variants),
    currency: variants.length ? currency : null,
    images,
    metal: null,
    stone: null,
    category: p.product_type?.trim() || null,
    length: null,
    sku: variants[0]?.sku || null,
    brand: p.vendor?.trim() || null,
    description: htmlToText(p.body_html),
    sourceUrl: new URL(`/products/${handle}`, storeBase).href,
    externalId: String(p.id),
    tier: 1,
    tags: toTags(p.tags),
  };
  const metalIdx = (p.options ?? []).findIndex((o) => /metal|material|colou?r|finish/i.test(o.name ?? ""));
  if (metalIdx < 0) return [base];
  const key = (["option1", "option2", "option3"] as const)[metalIdx];
  const groups = new Map<string, { label: string; variants: ShopifyVariant[] }>();
  for (const v of variants) {
    const label = v[key];
    const metal = canonicalMetal(label);
    if (!label || !metal) continue;
    const g = groups.get(metal) ?? { label, variants: [] };
    g.variants.push(v);
    groups.set(metal, g);
  }
  if (groups.size === 0) return [base];
  if (groups.size === 1) {
    const [g] = groups.values();
    return [{ ...base, metal: g.label, price: minPrice(g.variants) }];
  }
  return [...groups.entries()].map(([metal, g]) => ({
    ...base,
    metal: g.label,
    price: minPrice(g.variants),
    sku: g.variants[0]?.sku || null,
    externalId: `${p.id}:${metal}`,
    sourceUrl: new URL(`/products/${handle}?variant=${g.variants[0].id}`, storeBase).href,
  }));
}

export async function shopifyCurrency(fetcher: PoliteFetcher, storeBase: string): Promise<string | null> {
  try {
    const res = await fetcher.get(new URL("/meta.json", storeBase).href);
    if (res.status !== 200) return null;
    const c = (JSON.parse(res.body) as { currency?: unknown }).currency;
    return typeof c === "string" && /^[A-Z]{3}$/.test(c) ? c : null;
  } catch {
    return null;
  }
}

/** Probe used by platform detection: does `/products.json` answer with a products array? */
export async function isShopifyCatalog(fetcher: PoliteFetcher, storeBase: string): Promise<boolean> {
  try {
    const res = await fetcher.get(new URL("/products.json?limit=1", storeBase).href);
    if (res.status !== 200) return false;
    return Array.isArray((JSON.parse(res.body) as { products?: unknown }).products);
  } catch {
    return false;
  }
}

export async function ingestShopify(
  fetcher: PoliteFetcher,
  storeBase: string,
  opts: { maxProducts?: number; onPage?: (page: number, count: number) => void } = {},
): Promise<RawProduct[]> {
  const currency = await shopifyCurrency(fetcher, storeBase);
  const out: RawProduct[] = [];
  for (let page = 1; page <= SHOPIFY_MAX_PAGES; page++) {
    const res = await fetcher.get(new URL(`/products.json?limit=${SHOPIFY_PAGE_LIMIT}&page=${page}`, storeBase).href);
    if (res.status !== 200) break;
    const products = (JSON.parse(res.body) as { products?: ShopifyProduct[] }).products ?? [];
    for (const p of products) out.push(...parseShopifyProduct(p, storeBase, currency));
    opts.onPage?.(page, out.length);
    if (products.length < SHOPIFY_PAGE_LIMIT || (opts.maxProducts && out.length >= opts.maxProducts)) break;
  }
  return opts.maxProducts ? out.slice(0, opts.maxProducts) : out;
}

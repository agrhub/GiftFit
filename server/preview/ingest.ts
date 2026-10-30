/**
 * Store-URL ingest for previews (owner: A10; ADR-055). Discovers products from PUBLIC data only, through
 * the hardened SafeFetcher (server/ingest/safe-fetch.ts: SSRF guards, robots, ≤ 30 fetches):
 *
 *   1. the home page (store name, platform hints, product links);
 *   2. Shopify `/products.json?limit=50` (+ `/meta.json` for name and currency);
 *   3. WooCommerce Store API `/wp-json/wc/store/v1/products?per_page=50`;
 *   4. sitemap.xml (robots.txt sitemaps first) → product pages → JSON-LD Product/Offer, Open Graph.
 *
 * ≤ 50 products, normalised to PreviewProduct; fewer than 3 → `refused` / `not_a_store`. Nothing but the
 * normalised fields leaves this module: no HTML, no long descriptions, images by URL only. Try-on eligibility
 * (A16, server/ingest/tryon-eligibility.ts) reads at most a few image HEADS (first 32 KB, ranged, same budget).
 */
import * as cheerio from "cheerio";
import type { Metal } from "@/server/contracts/giftfit";
import { pageFromHtml } from "@/server/ingest/html";
import { canonicalMetal, inferCategory, normaliseCurrency, tagMap } from "@/server/ingest/normalise";
import { checkUrl, isSafeFetchError, SafeFetcher, type SafeFetcherOptions, type SafeResponse } from "@/server/ingest/safe-fetch";
import { isProductUrl, parseSitemap, productFromJsonLd, productFromOpenGraph } from "@/server/ingest/tier2-jsonld";
import type { ExtractedProduct } from "@/server/ingest/types";
import { classifyProducts, MAX_IMAGE_PROBES, type ImageMeta } from "@/server/ingest/tryon-eligibility";
import type { PreviewPlatform, PreviewProduct, PreviewReason, StoreIngestResult } from "./types";

export const MAX_PREVIEW_PRODUCTS = 50;
export const MIN_PREVIEW_PRODUCTS = 3;
/** The whole crawl (all fetches) must finish within this; what was found by then is kept. */
export const PREVIEW_DEADLINE_MS = 60_000;
const MAX_SITEMAP_FETCHES = 4;
const MAX_CANDIDATE_URLS = 120;
/** Consecutive product pages without a Product before the sitemap path gives up. */
const MAX_PAGE_MISSES = 6;

export interface IngestStoreOptions {
  fetcher?: SafeFetcher;
  fetcherOptions?: SafeFetcherOptions;
  maxProducts?: number;
  deadlineMs?: number;
  now?: () => number;
  onPhase?: (phase: "home" | PreviewPlatform) => void;
  /** Ranged image-head probes for try-on eligibility (default MAX_IMAGE_PROBES; 0 = URL/metadata rules only). */
  imageProbes?: number;
}

// ---------------------------------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------------------------------

const clean = (s: unknown, max: number): string | null => {
  if (typeof s !== "string" && typeof s !== "number") return null;
  const t = String(s).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return t ? (t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t) : null;
};

const htmlText = (html: unknown, max: number): string | null => {
  if (typeof html !== "string" || !html.trim()) return null;
  return clean(cheerio.load(html).root().text(), max);
};

function httpsImages(srcs: unknown[], base: string): string[] {
  const out: string[] = [];
  for (const s of srcs) {
    if (typeof s !== "string" || !s.trim()) continue;
    try {
      const u = new URL(s.trim().startsWith("//") ? `https:${s.trim()}` : s.trim(), base);
      if (u.protocol !== "https:" || u.href.length > 600) continue;
      if (!out.includes(u.href)) out.push(u.href);
    } catch {
      /* skip */
    }
    if (out.length >= 4) break;
  }
  return out;
}

/** A link for the visitor's browser to the merchant's product page (https, same site or subdomain). */
function productLink(raw: unknown, origin: string, fallback: string): string {
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  try {
    const u = new URL(raw.trim(), origin);
    if (u.protocol === "http:") u.protocol = "https:";
    if (u.protocol !== "https:") return fallback;
    const site = new URL(origin).hostname.replace(/^www\./, "");
    if (u.hostname !== site && !u.hostname.endsWith(`.${site}`)) return fallback;
    u.hash = "";
    return u.href;
  } catch {
    return fallback;
  }
}

const STYLE_WORDS = ["minimal", "minimalist", "classic", "statement", "boho", "vintage", "modern", "romantic", "everyday", "dainty", "bold", "elegant"];
function styleOf(...texts: (string | null | undefined)[]): string | null {
  const t = texts.filter(Boolean).join(" ").toLowerCase();
  const w = STYLE_WORDS.find((s) => new RegExp(`\\b${s}\\b`).test(t));
  return w === "minimalist" ? "minimal" : (w ?? null);
}

/** Metal: an explicit statement wins; otherwise only a jewelry title may state it ("Gold sneakers" is not a metal). */
function metalOf(stated: (string | null | undefined)[], title: string, isJewelry: boolean): Metal | null {
  for (const s of stated) {
    const m = canonicalMetal(s);
    if (m) return m;
  }
  return isJewelry ? canonicalMetal(title) : null;
}

const toTags = (tags: unknown): string[] => {
  const list = Array.isArray(tags) ? tags : typeof tags === "string" ? tags.split(",") : [];
  const out: string[] = [];
  for (const t of list) {
    const name = typeof t === "string" ? t : t && typeof t === "object" ? (t as { name?: unknown }).name : null;
    const c = clean(name, 40);
    if (c && !out.includes(c)) out.push(c);
    if (out.length >= 8) break;
  }
  return out;
};

function finish(p: Omit<PreviewProduct, "category" | "metal" | "style"> & { statedMetal: (string | null | undefined)[] }): PreviewProduct {
  const { statedMetal, ...rest } = p;
  const tags = tagMap(rest.tags);
  const category = inferCategory(tags.category, rest.categoryText, rest.title, rest.tags.join(" "));
  return {
    ...rest,
    category,
    metal: metalOf([tags.metal, ...statedMetal], rest.title, category !== null),
    style: clean(tags.style, 30) ?? styleOf(rest.title, rest.tags.join(" "), rest.summary),
  };
}

// ---------------------------------------------------------------------------------------------------
// Store name and platform hints from the home page
// ---------------------------------------------------------------------------------------------------

export function storeNameFromHtml(html: string): string | null {
  const $ = cheerio.load(html);
  const meta = (sel: string) => clean($(sel).first().attr("content"), 80);
  const fromMeta = meta('meta[property="og:site_name"]') ?? meta('meta[name="application-name"]') ?? meta('meta[name="apple-mobile-web-app-title"]');
  if (fromMeta) return fromMeta;
  let ld: string | null = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (ld) return;
    try {
      const data = JSON.parse($(el).contents().text()) as unknown;
      const nodes = (Array.isArray(data) ? data : [data]).flatMap((n) => (n && typeof n === "object" && Array.isArray((n as { "@graph"?: unknown[] })["@graph"]) ? (n as { "@graph": unknown[] })["@graph"] : [n]));
      for (const n of nodes) {
        if (!n || typeof n !== "object") continue;
        const type = String((n as { "@type"?: unknown })["@type"] ?? "");
        if (/^(WebSite|Organization|Store|OnlineStore|JewelryStore|ClothingStore)$/.test(type)) {
          ld = clean((n as { name?: unknown }).name, 80);
          if (ld) return;
        }
      }
    } catch {
      /* malformed JSON-LD */
    }
  });
  if (ld) return ld;
  const title = clean($("title").first().text(), 200);
  if (!title) return null;
  return clean(title.split(/\s+[|–—·-]\s+/)[0], 80);
}

interface HomeInfo {
  storeName: string | null;
  shopify: boolean;
  woo: boolean;
  productLinks: string[];
}

function homeInfo(res: SafeResponse): HomeInfo {
  const html = res.body;
  const h = res.headers;
  const shopify = /cdn\.shopify\.com|Shopify\.theme|\.myshopify\.com|shopify-section/i.test(html) || Boolean(h["x-shopid"] || h["x-shopify-stage"] || /shopify/i.test(h["powered-by"] ?? ""));
  const woo = /woocommerce|wc-block-|\/wp-content\/plugins\/woocommerce/i.test(html);
  let productLinks: string[] = [];
  try {
    productLinks = pageFromHtml(html, res.url).links.filter((l) => isProductUrl(l));
  } catch {
    /* unparsable home page */
  }
  return { storeName: storeNameFromHtml(html), shopify, woo, productLinks };
}

// ---------------------------------------------------------------------------------------------------
// Tier: Shopify
// ---------------------------------------------------------------------------------------------------

interface ShopifyVariantLite {
  price?: string | number | null;
  available?: boolean;
  option1?: string | null;
  option2?: string | null;
  option3?: string | null;
}
interface ShopifyProductLite {
  id?: number | string;
  title?: string;
  handle?: string;
  body_html?: string | null;
  product_type?: string | null;
  tags?: string[] | string;
  variants?: ShopifyVariantLite[];
  images?: { src?: string; width?: number; height?: number; alt?: string | null; position?: number }[];
  options?: { name?: string }[];
}

const posInt = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v > 0 && v < 100_000 ? v : undefined);

/** Image metadata the store's JSON states for free (try-on eligibility, A16); URLs normalised like `images`. */
function imageMetaOf(list: { src?: unknown; width?: unknown; height?: unknown; alt?: unknown; position?: unknown; srcset?: unknown }[] | undefined, base: string): ImageMeta[] {
  const out: ImageMeta[] = [];
  for (const [i, img] of (list ?? []).slice(0, 4).entries()) {
    const url = httpsImages([img?.src], base)[0];
    if (!url) continue;
    let width = posInt(img.width);
    let height = posInt(img.height);
    // WooCommerce: the largest "-<w>x<h>.<ext>" size in the srcset.
    if ((!width || !height) && typeof img.srcset === "string") {
      for (const m of img.srcset.matchAll(/-(\d{2,5})x(\d{2,5})\.(?:jpe?g|png|webp)\b/gi)) {
        const w = Number(m[1]);
        if (!width || w > width) [width, height] = [w, Number(m[2])];
      }
    }
    out.push({ url, ...(width && height ? { width, height } : {}), ...(typeof img.alt === "string" && img.alt.trim() ? { alt: img.alt.trim().slice(0, 160) } : {}), position: posInt(img.position) ?? i + 1 });
  }
  return out;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
};

export function fromShopify(p: ShopifyProductLite, origin: string, currency: string | null): PreviewProduct | null {
  const title = clean(p.title, 140);
  if (!title) return null;
  const variants = Array.isArray(p.variants) ? p.variants : [];
  const prices = variants.map((v) => num(v.price)).filter((x): x is number => x !== null);
  const handle = typeof p.handle === "string" && /^[\p{L}\p{N}_.~-]+$/u.test(p.handle) ? p.handle : null;
  const metalIdx = (p.options ?? []).findIndex((o) => /metal|material/i.test(o?.name ?? ""));
  const optKey = metalIdx >= 0 && metalIdx < 3 ? (["option1", "option2", "option3"] as const)[metalIdx] : null;
  const withAvail = variants.filter((v) => typeof v.available === "boolean");
  return finish({
    id: String(p.id ?? handle ?? title).slice(0, 80),
    title,
    url: handle ? `${origin}/products/${encodeURIComponent(handle)}` : origin,
    images: httpsImages((p.images ?? []).map((i) => i?.src), origin),
    imageMeta: imageMetaOf(p.images, origin),
    price: prices.length ? Math.min(...prices) : null,
    currency: prices.length ? currency : null,
    categoryText: clean(p.product_type, 60),
    tags: toTags(p.tags),
    summary: htmlText(p.body_html, 160),
    available: withAvail.length ? withAvail.some((v) => v.available) : null,
    statedMetal: optKey ? variants.map((v) => v[optKey]) : [],
  });
}

async function viaShopify(f: SafeFetcher, origin: string, max: number): Promise<{ products: PreviewProduct[]; name: string | null } | null> {
  const res = await f.get(`${origin}/products.json?limit=${Math.min(50, max)}`, "json");
  if (res.status !== 200) return null;
  let products: ShopifyProductLite[];
  try {
    const data = JSON.parse(res.body) as { products?: unknown };
    if (!Array.isArray(data.products)) return null;
    products = data.products as ShopifyProductLite[];
  } catch {
    return null;
  }
  let currency: string | null = null;
  let name: string | null = null;
  if (products.length && f.remaining > 0) {
    try {
      const meta = await f.get(`${origin}/meta.json`, "json");
      if (meta.status === 200) {
        const m = JSON.parse(meta.body) as { currency?: unknown; name?: unknown };
        currency = typeof m.currency === "string" && /^[A-Z]{3}$/.test(m.currency) ? m.currency : null;
        name = clean(m.name, 80);
      }
    } catch {
      /* currency stays unknown */
    }
  }
  return { products: products.map((p) => fromShopify(p, origin, currency)).filter((p): p is PreviewProduct => p !== null), name };
}

// ---------------------------------------------------------------------------------------------------
// Tier: WooCommerce Store API
// ---------------------------------------------------------------------------------------------------

interface WooProductLite {
  id?: number | string;
  name?: string;
  permalink?: string;
  sku?: string;
  short_description?: string;
  description?: string;
  prices?: { price?: string | number; currency_code?: string; currency_minor_unit?: number };
  images?: { src?: string; alt?: string; srcset?: string }[];
  categories?: { name?: string }[];
  tags?: { name?: string }[];
  is_in_stock?: boolean;
  attributes?: { name?: string; terms?: { name?: string }[] }[];
}

export function fromWoo(p: WooProductLite, origin: string): PreviewProduct | null {
  const title = htmlText(p.name, 140);
  if (!title) return null;
  const minor = Number.isInteger(p.prices?.currency_minor_unit) ? Number(p.prices?.currency_minor_unit) : 2;
  const raw = num(p.prices?.price);
  const price = raw === null ? null : Math.round((raw / 10 ** Math.min(4, Math.max(0, minor))) * 100) / 100;
  const metalAttr = (p.attributes ?? []).find((a) => /metal|material/i.test(a?.name ?? ""));
  return finish({
    id: String(p.id ?? p.sku ?? title).slice(0, 80),
    title,
    url: productLink(p.permalink, origin, origin),
    images: httpsImages((p.images ?? []).map((i) => i?.src), origin),
    imageMeta: imageMetaOf(p.images, origin),
    price,
    currency: price === null ? null : normaliseCurrency(p.prices?.currency_code),
    categoryText: clean((p.categories ?? [])[0]?.name ? htmlText(p.categories![0].name, 60) : null, 60),
    tags: toTags(p.tags),
    summary: htmlText(p.short_description, 160) ?? htmlText(p.description, 160),
    available: typeof p.is_in_stock === "boolean" ? p.is_in_stock : null,
    statedMetal: (metalAttr?.terms ?? []).map((t) => t?.name),
  });
}

async function viaWoo(f: SafeFetcher, origin: string, max: number): Promise<PreviewProduct[] | null> {
  const res = await f.get(`${origin}/wp-json/wc/store/v1/products?per_page=${Math.min(50, max)}`, "json");
  if (res.status !== 200) return null;
  try {
    const data = JSON.parse(res.body) as unknown;
    if (!Array.isArray(data)) return null;
    return (data as WooProductLite[]).map((p) => fromWoo(p, origin)).filter((p): p is PreviewProduct => p !== null);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------
// Tier: sitemap + JSON-LD / Open Graph product pages
// ---------------------------------------------------------------------------------------------------

export function fromExtracted(p: ExtractedProduct, pageUrl: string, origin: string): PreviewProduct | null {
  const title = clean(p.title, 140);
  if (!title) return null;
  const slug = new URL(pageUrl).pathname.split("/").filter(Boolean).pop() ?? title;
  return finish({
    id: String(p.sku ?? slug).slice(0, 80),
    title,
    url: productLink(pageUrl, origin, pageUrl),
    images: httpsImages(p.images, pageUrl),
    price: p.price,
    currency: p.price === null ? null : normaliseCurrency(p.currency),
    categoryText: clean(p.category, 60),
    tags: [],
    summary: clean(p.description, 160),
    available: null,
    statedMetal: [p.metal],
  });
}

const SKIP_SITEMAP = /image|video|blog|post|page|categor|collection|tag|author|news|article/i;

async function candidateUrls(f: SafeFetcher, origin: string, homeLinks: string[], isLate: () => boolean): Promise<string[]> {
  const host = new URL(origin).hostname;
  const sameHost = (u: string) => {
    try {
      return new URL(u).hostname === host;
    } catch {
      return false;
    }
  };
  let queue = (await f.sitemapsFor(origin)).filter(sameHost);
  const declared = queue.length > 0;
  if (!declared) queue = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
  const seen = new Set<string>();
  const urls: string[] = [];
  let fetched = 0;
  while (queue.length && fetched < MAX_SITEMAP_FETCHES && urls.length < MAX_CANDIDATE_URLS && f.remaining > 1 && !isLate()) {
    const sm = queue.shift()!;
    if (seen.has(sm)) continue;
    seen.add(sm);
    let res: SafeResponse;
    try {
      fetched++;
      res = await f.get(sm, "xml");
    } catch (err) {
      if (isSafeFetchError(err, "budget_exceeded") || isSafeFetchError(err, "blocked_url")) throw err;
      continue;
    }
    if (res.status !== 200) continue;
    // The fallback /sitemap_index.xml is only tried when /sitemap.xml did not answer.
    if (!declared && sm.endsWith("/sitemap.xml")) queue = queue.filter((q) => !q.endsWith("/sitemap_index.xml"));
    let parsed: { urls: string[]; sitemaps: string[] };
    try {
      parsed = parseSitemap(res.body);
    } catch {
      continue;
    }
    const children = parsed.sitemaps.filter(sameHost).filter((s) => /product/i.test(s) || !SKIP_SITEMAP.test(s));
    children.sort((a, b) => Number(/product/i.test(b)) - Number(/product/i.test(a)));
    queue.unshift(...children.filter((c) => /product/i.test(c)));
    queue.push(...children.filter((c) => !/product/i.test(c)));
    const productSitemap = /product/i.test(sm);
    for (const u of parsed.urls) {
      if (urls.length >= MAX_CANDIDATE_URLS) break;
      if (sameHost(u) && isProductUrl(u, productSitemap) && !urls.includes(u)) urls.push(u);
    }
  }
  for (const l of homeLinks) if (urls.length < MAX_CANDIDATE_URLS && sameHost(l) && !urls.includes(l)) urls.push(l);
  const allowed: string[] = [];
  for (const u of urls) if (await f.isAllowed(u).catch(() => false)) allowed.push(u);
  return allowed;
}

async function viaJsonLd(f: SafeFetcher, origin: string, homeLinks: string[], max: number, isLate: () => boolean): Promise<PreviewProduct[]> {
  const urls = await candidateUrls(f, origin, homeLinks, isLate);
  const out: PreviewProduct[] = [];
  let misses = 0;
  for (const u of urls) {
    if (out.length >= max || f.remaining <= 0 || misses >= MAX_PAGE_MISSES || isLate()) break;
    let res: SafeResponse;
    try {
      res = await f.get(u, "html");
    } catch (err) {
      if (isSafeFetchError(err, "budget_exceeded") || isSafeFetchError(err, "host_stopped")) break;
      if (isSafeFetchError(err, "blocked_url")) throw err;
      misses++;
      continue;
    }
    if (res.status !== 200) {
      misses++;
      continue;
    }
    const page = pageFromHtml(res.body, res.url);
    const extracted = productFromJsonLd(page.jsonLd, page.url) ?? productFromOpenGraph(page);
    const p = extracted ? fromExtracted(extracted, res.url, origin) : null;
    if (!p) {
      misses++;
      continue;
    }
    misses = 0;
    out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------------------------------

function dedupe(products: PreviewProduct[], max: number): PreviewProduct[] {
  const seen = new Set<string>();
  const out: PreviewProduct[] = [];
  for (const p of products) {
    const k = `${p.id}|${p.url}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
    if (out.length >= max) break;
  }
  return out;
}

export function dominantCurrency(products: PreviewProduct[]): string | null {
  const counts = new Map<string, number>();
  for (const p of products) if (p.currency) counts.set(p.currency, (counts.get(p.currency) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/** Ingests a store from its public URL. Never throws for crawl problems: they become `failed` / `refused`. */
export async function ingestStoreUrl(input: string | URL, opts: IngestStoreOptions = {}): Promise<StoreIngestResult> {
  const now = opts.now ?? Date.now;
  const t0 = now();
  const deadline = t0 + (opts.deadlineMs ?? PREVIEW_DEADLINE_MS);
  const isLate = () => now() >= deadline;
  const max = Math.max(1, Math.min(MAX_PREVIEW_PRODUCTS, opts.maxProducts ?? MAX_PREVIEW_PRODUCTS));
  const f = opts.fetcher ?? new SafeFetcher(opts.fetcherOptions);
  const start = checkUrl(input);
  let origin = start.origin;
  let storeName: string | null = null;
  let best: { products: PreviewProduct[]; platform: PreviewPlatform | null } = { products: [], platform: null };
  let robotsBlocked = false;
  let hostStopped = false;
  let failure: PreviewReason | null = null;

  const done = (outcome: StoreIngestResult["outcome"], reason?: PreviewReason): StoreIngestResult => {
    const products = outcome === "ready" ? best.products : [];
    return {
      outcome,
      ...(reason ? { reason } : {}),
      domain: new URL(origin).hostname,
      origin,
      storeName: storeName ?? null,
      platform: outcome === "ready" ? best.platform : null,
      products,
      currency: dominantCurrency(products),
      fetches: f.fetches,
      ms: now() - t0,
    };
  };

  /** Runs one discovery step; returns false when the crawl must stop (budget, deadline, policy). */
  const step = async (fn: () => Promise<void>): Promise<boolean> => {
    if (isLate()) {
      failure ??= "timeout";
      return false;
    }
    try {
      await fn();
      return true;
    } catch (err) {
      if (isSafeFetchError(err, "robots_disallowed")) {
        robotsBlocked = true;
        return true;
      }
      if (isSafeFetchError(err, "blocked_url")) {
        failure = "blocked_url";
        return false;
      }
      if (isSafeFetchError(err, "host_stopped")) {
        hostStopped = true;
        return false;
      }
      if (isSafeFetchError(err, "budget_exceeded")) return false;
      if (isSafeFetchError(err, "timeout") && isLate()) {
        failure ??= "timeout";
        return false;
      }
      return true; // one failed source (404 JSON, bad content type, network blip) is not fatal
    }
  };

  const consider = (products: PreviewProduct[] | null | undefined, platform: PreviewPlatform) => {
    const unique = dedupe(products ?? [], max);
    if (unique.length > best.products.length) best = { products: unique, platform };
    return best.products.length >= MIN_PREVIEW_PRODUCTS;
  };

  let home: HomeInfo = { storeName: null, shopify: false, woo: false, productLinks: [] };
  opts.onPhase?.("home");
  let go = await step(async () => {
    const res = await f.get(`${origin}/`, "html");
    if (res.status === 200) {
      origin = new URL(res.url).origin;
      home = homeInfo(res);
      storeName = home.storeName;
    }
  });

  const order: PreviewPlatform[] = home.shopify ? ["shopify", "jsonld"] : home.woo ? ["woocommerce", "jsonld"] : ["shopify", "woocommerce", "jsonld"];
  for (const platform of order) {
    if (!go || best.products.length >= MIN_PREVIEW_PRODUCTS) break;
    opts.onPhase?.(platform);
    let enough = false;
    go = await step(async () => {
      if (platform === "shopify") {
        const r = await viaShopify(f, origin, max);
        if (r?.name) storeName = r.name;
        enough = consider(r?.products, platform);
      } else if (platform === "woocommerce") {
        enough = consider(await viaWoo(f, origin, max), platform);
      } else {
        enough = consider(await viaJsonLd(f, origin, home.productLinks, max, isLate), platform);
      }
    });
    if (enough) break;
  }

  if (best.products.length >= MIN_PREVIEW_PRODUCTS) {
    // A16: try-on eligibility per product (heuristics; ≤ MAX_IMAGE_PROBES ranged image heads within the budget).
    best.products = await classifyProducts(best.products, {
      probe: async (u) => (await f.getImageHead(u))?.bytes ?? null,
      maxProbes: opts.imageProbes ?? MAX_IMAGE_PROBES,
      shouldStop: () => isLate() || f.remaining < 2,
    });
    return done("ready");
  }
  if (failure === "blocked_url") return done("failed", "blocked_url");
  if (f.answered === 0) return done("failed", failure === "timeout" ? "timeout" : "unreachable");
  if (robotsBlocked && best.products.length === 0) return done("refused", "robots_disallowed");
  if (hostStopped && best.products.length === 0) return done("refused", "site_blocked");
  if (failure === "timeout") return done("failed", "timeout");
  return done("refused", "not_a_store");
}

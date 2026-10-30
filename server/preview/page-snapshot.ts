/**
 * Store-page snapshots for previews (owner: A15; user decision "Chụp lại trang thật"). After a preview's
 * products are ingested, GiftFit copies the merchant's HOME page and the product pages of products the
 * preview shows (≤ MAX_SNAPSHOT_PRODUCT_PAGES), server-side, from HTML only (no browser), through the same
 * hardened SafeFetcher (SSRF guards, DNS pinning, ≤ 3 redirects, robots.txt for GiftFitPreviewBot, size
 * and time caps). Each page is sanitized (page-snapshot-sanitize.ts) and stored (page-snapshot-store.ts);
 * the preview record keeps only the outcome (`PageSnapshotInfo`).
 *
 * Snapshot mode is used only when ALL of these hold, else the neutral template stays and the reason is
 * recorded (shown on the preview page and in Admin v0):
 *   - PREVIEW_SNAPSHOT is not off                                  → else "disabled"
 *   - ≥ 3 jewelry products (earring/necklace/ring/bracelet/watch)   → else "not_jewelry"
 *   - the home page was fetched (200, robots allow it)              → else "robots_disallowed" / "fetch_failed"
 *   - it doesn't look like a login / payment / banking page          → else "sensitive_page"
 *   - the sanitizer reached a stable output                          → else "unstable_markup"
 *   - ≥ 200 visible text characters and ≥ 3 images after stripping   → else "too_little_text" / "no_images"
 *     (a JS-rendered SPA shell fails here)
 *   - ≤ 600 KB of sanitized HTML                                     → else "too_large"
 *   - stored                                                          → else "storage_failed"
 * A product page failing its own checks (sensitive, broken, too large, fetch error) is skipped: its links
 * then open GiftFit's plain product card inside the frame.
 * A home page with no link to any ingested product (carousels built by script) gets the GiftFit-labelled
 * "In this preview" strip at the top of its <main> (withPreviewStrip, page-snapshot-strip.ts).
 */
import type { JewelryCategory } from "@/server/contracts/giftfit";
import { isSafeFetchError, SafeFetcher, type SafeFetcherOptions } from "@/server/ingest/safe-fetch";
import type { Env } from "@/server/store/config";
import { assessSensitivePage, sanitizeSnapshotHtml, SnapshotUnstableError, type SanitizedPage } from "./page-snapshot-sanitize";
import { defaultPageSnapshotStore, HOME_PAGE_ID, productPageId, type PageSnapshotStore } from "./page-snapshot-store";
import { collectionCategory, insertPreviewStrip, PREVIEW_STRIP_ID, previewStripHtml, stripProducts } from "./page-snapshot-strip";
import type { PreviewProduct } from "./types";

export const MIN_JEWELRY_FOR_SNAPSHOT = 3;
export const MAX_SNAPSHOT_PRODUCT_PAGES = 10;
export const MAX_SNAPSHOT_BYTES = 600 * 1024;
export const MIN_HOME_TEXT_CHARS = 200;
export const MIN_HOME_IMAGES = 3;
export const MIN_PRODUCT_TEXT_CHARS = 80;
export const MIN_PRODUCT_IMAGES = 1;
/** robots.txt + home + product pages + a few redirect hops. */
export const SNAPSHOT_FETCH_BUDGET = MAX_SNAPSHOT_PRODUCT_PAGES + 6;
export const SNAPSHOT_DEADLINE_MS = 30_000;

export type SnapshotReason =
  | "disabled"
  | "not_jewelry"
  | "robots_disallowed"
  | "fetch_failed"
  | "sensitive_page"
  | "unstable_markup"
  | "too_little_text"
  | "no_images"
  | "too_large"
  | "storage_failed";

export const SNAPSHOT_REASONS: readonly SnapshotReason[] = [
  "disabled",
  "not_jewelry",
  "robots_disallowed",
  "fetch_failed",
  "sensitive_page",
  "unstable_markup",
  "too_little_text",
  "no_images",
  "too_large",
  "storage_failed",
];

/** Stored on the preview record (`snapshot`). */
export interface PageSnapshotInfo {
  mode: "snapshot" | "template";
  /** Why the neutral template is used (null in snapshot mode). */
  reason: SnapshotReason | null;
  capturedAt: Date;
  /** Store-side ids of the products whose own page was captured. */
  productPages: string[];
  /** Sanitized bytes stored (all pages). */
  bytes: number;
  fetches: number;
}

export function snapshotsEnabled(env: Env = process.env): boolean {
  return !/^(0|off|false|no)$/i.test(env.PREVIEW_SNAPSHOT?.trim() ?? "");
}

/** /s/<key>/snapshot — the snapshot home inside the preview. */
export const snapshotBasePath = (key: string) => `/s/${key}/snapshot`;
/** The id fully percent-encoded (also !'()*), so the sanitizer's internal-link pattern keeps it on re-sanitizing. */
export const snapshotProductPath = (key: string, productId: string) =>
  `${snapshotBasePath(key)}/p/${encodeURIComponent(productId).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
/** The GiftFit strip on the snapshot home (see page-snapshot-strip.ts). */
export const snapshotStripPath = (key: string) => `${snapshotBasePath(key)}#${PREVIEW_STRIP_ID}`;

// ---------------------------------------------------------------------------------------------------
// Link matching
// ---------------------------------------------------------------------------------------------------

const bareHost = (h: string) => h.toLowerCase().replace(/^www\./, "");

function pathKey(u: URL): string {
  let p: string;
  try {
    p = decodeURIComponent(u.pathname);
  } catch {
    p = u.pathname;
  }
  p = p.toLowerCase().replace(/\/+$/, "");
  return p || "/";
}

/** The "/products/<handle>" tail of a Shopify-style path (also under /collections/x/products/…). */
const productsTail = (path: string) => {
  const i = path.lastIndexOf("/products/");
  return i >= 0 ? path.slice(i) : null;
};

/** A leading locale segment ("/en", "/en-us", "/fr_ca", "/zh-hant"), as stores put before every path. */
const LOCALE_PREFIX = /^\/[a-z]{2}(?:[-_][a-z0-9]{2,4})?(?=\/)/;
const withoutLocale = (path: string) => path.replace(LOCALE_PREFIX, "");

/**
 * The product handle of a path: the segment after the last "products"/"product" segment, without an
 * .html ending ("/en/collections/rings/products/aria-hoops/reviews" → "aria-hoops"), else null.
 */
function productHandle(path: string): string | null {
  const segs = path.split("/");
  for (let i = segs.length - 2; i >= 0; i--) {
    if (segs[i] !== "products" && segs[i] !== "product") continue;
    const h = segs[i + 1].replace(/\.html?$/, "");
    return h || null;
  }
  return null;
}

/**
 * Maps merchant link URLs to the preview's internal paths: a product GiftFit shows → its snapshot
 * product page; the store home → the snapshot home; anything else → null (an external link).
 *
 * A link is on the store when its host (without "www.") is the home page's or one of the products'
 * hosts. It is a product GiftFit shows when, query and hash ignored, case-insensitively and without a
 * trailing slash, its path is that product's path, or is it after a leading locale segment, or ends with
 * the same "/products/<handle>" (collection prefixes), or names the same handle after a "products" /
 * "product" segment (locale, collection or trailing segments around it).
 *
 * `stripCategories` (only for a page that carries the GiftFit strip): a collection link naming one of
 * these categories (page-snapshot-strip.ts `collectionCategory`) jumps to the strip instead.
 */
export function snapshotLinkMapper(
  key: string,
  homeUrl: string,
  products: readonly Pick<PreviewProduct, "id" | "url">[],
  onProduct?: (id: string) => void,
  stripCategories?: ReadonlySet<JewelryCategory>,
): (u: URL) => string | null {
  const home = new URL(homeUrl);
  const sites = new Set([bareHost(home.hostname)]);
  const byPath = new Map<string, string>();
  const byLocaleFree = new Map<string, string>();
  const byTail = new Map<string, string>();
  const byHandle = new Map<string, string>();
  const first = (m: Map<string, string>, k: string | null, id: string) => {
    if (k && !m.has(k)) m.set(k, id);
  };
  for (const p of products) {
    let u: URL;
    try {
      u = new URL(p.url);
    } catch {
      continue;
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") continue;
    const k = pathKey(u);
    if (k === "/") continue; // a product without its own page (falls back to the store URL)
    sites.add(bareHost(u.hostname));
    first(byPath, k, p.id);
    first(byLocaleFree, withoutLocale(k), p.id);
    first(byTail, productsTail(k), p.id);
    first(byHandle, productHandle(k), p.id);
  }
  const homeKey = pathKey(home);
  return (u: URL) => {
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (!sites.has(bareHost(u.hostname))) return null;
    const k = pathKey(u);
    const tail = productsTail(k);
    const handle = productHandle(k);
    const id = byPath.get(k) ?? byLocaleFree.get(withoutLocale(k)) ?? (tail ? byTail.get(tail) : undefined) ?? (handle ? byHandle.get(handle) : undefined);
    if (id !== undefined) {
      onProduct?.(id);
      return snapshotProductPath(key, id);
    }
    if (k === "/" || k === homeKey) return snapshotBasePath(key);
    if (stripCategories?.size) {
      const cat = collectionCategory(k);
      if (cat && stripCategories.has(cat)) return snapshotStripPath(key);
    }
    return null;
  };
}

// ---------------------------------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------------------------------

export interface CaptureInput {
  key: string;
  /** https://<host> of the store (after the ingest's redirects). */
  origin: string;
  products: readonly PreviewProduct[];
  /** The preview's expiry: snapshot pages get the same one. */
  expiresAt: Date;
}

export interface CaptureOptions {
  fetcher?: SafeFetcher;
  fetcherOptions?: SafeFetcherOptions;
  store?: PageSnapshotStore;
  env?: Env;
  now?: () => number;
  deadlineMs?: number;
}

type PageCheck = { ok: true; page: SanitizedPage } | { ok: false; reason: SnapshotReason };

function checkPage(html: string, url: string, mapLink: (u: URL) => string | null, key: string, kind: "home" | "product"): PageCheck {
  if (assessSensitivePage(html).sensitive) return { ok: false, reason: "sensitive_page" };
  let page: SanitizedPage;
  try {
    page = sanitizeSnapshotHtml(html, { pageUrl: url, linkFor: mapLink, internalPrefix: snapshotBasePath(key) });
  } catch (err) {
    if (err instanceof SnapshotUnstableError) return { ok: false, reason: "unstable_markup" };
    throw err;
  }
  const minText = kind === "home" ? MIN_HOME_TEXT_CHARS : MIN_PRODUCT_TEXT_CHARS;
  const minImages = kind === "home" ? MIN_HOME_IMAGES : MIN_PRODUCT_IMAGES;
  if (page.textChars < minText) return { ok: false, reason: "too_little_text" };
  if (page.images < minImages) return { ok: false, reason: "no_images" };
  if (page.bytes > MAX_SNAPSHOT_BYTES) return { ok: false, reason: "too_large" };
  return { ok: true, page };
}

const jewelryCount = (products: readonly PreviewProduct[]) => products.filter((p) => p.category !== null).length;

/**
 * A captured page whose links reach none of the ingested products (its carousels are built by script)
 * gets the "In this preview · GiftFit" strip (page-snapshot-strip.ts), and its collection links naming
 * a category the strip shows jump to it. `html` is the page's sanitized copy; the result is sanitized
 * again (same rules, fixpoint). Null when the strip can't be added (no body, unstable, over the cap).
 */
export function withPreviewStrip(html: string, pageUrl: string, key: string, products: readonly PreviewProduct[]): SanitizedPage | null {
  const strip = previewStripHtml(products, (id) => snapshotProductPath(key, id));
  const withStrip = strip ? insertPreviewStrip(html, strip) : null;
  if (!withStrip) return null;
  const categories = new Set(stripProducts(products).flatMap((p) => (p.category ? [p.category] : [])));
  const mapLink = snapshotLinkMapper(key, pageUrl, products, undefined, categories);
  try {
    const page = sanitizeSnapshotHtml(withStrip, { pageUrl, linkFor: mapLink, internalPrefix: snapshotBasePath(key), internalAnchor: PREVIEW_STRIP_ID });
    return page.bytes <= MAX_SNAPSHOT_BYTES ? page : null;
  } catch (err) {
    if (err instanceof SnapshotUnstableError) return null;
    throw err;
  }
}

/**
 * Captures, sanitizes and stores the snapshot pages of a ready preview. Never throws for crawl problems:
 * they become `mode: "template"` with a reason. Previous pages of this preview are always removed first.
 */
export async function capturePageSnapshot(input: CaptureInput, opts: CaptureOptions = {}): Promise<PageSnapshotInfo> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const store = opts.store ?? defaultPageSnapshotStore(env);
  const deadline = now() + (opts.deadlineMs ?? SNAPSHOT_DEADLINE_MS);
  const f = opts.fetcher ?? new SafeFetcher({ ...opts.fetcherOptions, budget: SNAPSHOT_FETCH_BUDGET });
  const template = (reason: SnapshotReason): PageSnapshotInfo => ({ mode: "template", reason, capturedAt: new Date(now()), productPages: [], bytes: 0, fetches: f.fetches });

  await store.deleteFor(input.key).catch(() => undefined);
  if (!snapshotsEnabled(env)) return template("disabled");
  if (jewelryCount(input.products) < MIN_JEWELRY_FOR_SNAPSHOT) return template("not_jewelry");

  // Home page
  let homeUrl: string;
  let homeHtml: string;
  try {
    const res = await f.get(`${input.origin}/`, "html");
    if (res.status !== 200) return template("fetch_failed");
    homeUrl = res.url;
    homeHtml = res.body;
  } catch (err) {
    return template(isSafeFetchError(err, "robots_disallowed") ? "robots_disallowed" : "fetch_failed");
  }
  const linked = new Set<string>();
  const mapLink = snapshotLinkMapper(input.key, homeUrl, input.products);
  const homeMap = snapshotLinkMapper(input.key, homeUrl, input.products, (id) => linked.add(id));
  const home = checkPage(homeHtml, homeUrl, homeMap, input.key, "home");
  if (!home.ok) return template(home.reason);
  // The gates above judged the store's own page; the strip is added only after it passed them.
  const homePage = linked.size === 0 ? (withPreviewStrip(home.page.html, homeUrl, input.key, input.products) ?? home.page) : home.page;

  const createdAt = new Date(now());
  try {
    await store.put({ key: input.key, page: HOME_PAGE_ID, productId: null, url: homeUrl, html: homePage.html, bytes: homePage.bytes, createdAt, expiresAt: input.expiresAt });
  } catch (err) {
    console.error("[preview] snapshot storage failed:", (err as Error).name);
    return template("storage_failed");
  }

  // Product pages: products linked from the home page first, then the rest; same host only.
  const homeHost = new URL(homeUrl).hostname.toLowerCase();
  const candidates = [...input.products]
    .filter((p) => {
      try {
        const u = new URL(p.url);
        return u.protocol === "https:" && u.hostname.toLowerCase() === homeHost && pathKey(u) !== "/";
      } catch {
        return false;
      }
    })
    .sort((a, b) => Number(linked.has(b.id)) - Number(linked.has(a.id)))
    .slice(0, MAX_SNAPSHOT_PRODUCT_PAGES);

  const productPages: string[] = [];
  let bytes = homePage.bytes;
  for (const p of candidates) {
    if (now() >= deadline || f.remaining <= 0) break;
    let html: string;
    let url: string;
    try {
      const res = await f.get(p.url, "html");
      if (res.status !== 200) continue;
      html = res.body;
      url = res.url;
    } catch (err) {
      if (isSafeFetchError(err, "budget_exceeded") || isSafeFetchError(err, "host_stopped") || isSafeFetchError(err, "blocked_url")) break;
      continue;
    }
    const checked = checkPage(html, url, mapLink, input.key, "product");
    if (!checked.ok) continue;
    try {
      await store.put({ key: input.key, page: productPageId(p.id), productId: p.id, url, html: checked.page.html, bytes: checked.page.bytes, createdAt, expiresAt: input.expiresAt });
      productPages.push(p.id);
      bytes += checked.page.bytes;
    } catch {
      break;
    }
  }
  return { mode: "snapshot", reason: null, capturedAt: createdAt, productPages, bytes, fetches: f.fetches };
}

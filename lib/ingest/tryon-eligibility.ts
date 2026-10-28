/**
 * Try-on eligibility of an ingested product (A16; store-URL previews, ADR-055 follow-up). Server-only,
 * deterministic heuristics, never an AI call and never a paid call.
 *
 * What YouCam's jewelry try-on (2d-vto/earring|necklace|ring|bracelet|watch) needs from the PRODUCT image
 * (docs.perfectcorp.com ai_* jewelry pages, summarised in lib/youcam/features.ts and the api matrix §9):
 *   - jpg/jpeg/png, < 10 MB, long side ≤ 4096 px (no documented minimum: we ask ≥ 400 px on the short side,
 *     a thumbnail renders badly);
 *   - ONE product, clear front view (ring/bracelet three-quarter view, watch face upright), unobstructed;
 *     background removal is on by default, so a white or plain packshot is what works;
 *   - not a photo of the piece being worn (model / lifestyle shot): the engine looks for the product, not a person.
 *
 * Signals used, all cheap: the category (earring/necklace/ring/bracelet/watch, else "other"); the image URL's
 * extension; width/height/alt/position when the store's public JSON states them (Shopify products.json,
 * WooCommerce srcset); optionally the first bytes of the image (a small ranged GET through SafeFetcher, at most
 * a few per preview) for format and pixel size; title/alt/URL keywords for worn/lifestyle shots, multi-piece
 * sets and accessories. Only the first two images are candidates (later Shopify positions are usually
 * lifestyle shots); the first one that passes becomes `tryOnImage`.
 *
 * Output per product: `category` (unchanged; null = "other"), `tryOnEligible`, `tryOnReason`, `tryOnImage`.
 * Heuristics can be wrong both ways: an eligible piece may still fail at YouCam (engine errors are refunded,
 * ADR-026) and the recipient then sees "Preview unavailable"; an ineligible piece stays in the gift as
 * hearts-only ("not tried on").
 */
import type { JewelryCategory } from "@/lib/contracts/giftfit";

export const TRYON_CATEGORIES: readonly JewelryCategory[] = ["earring", "necklace", "ring", "bracelet", "watch"];
export type TryOnCategory = JewelryCategory | "other";

export const TRYON_REASONS = [
  "ok", // jpg/png, pixel size known and in range, no worn/multi-piece/accessory signal
  "ok_size_unknown", // jpg/png by URL, pixel size not known (no metadata, no probe)
  "not_jewelry", // category other / unknown: no YouCam try-on exists for it
  "no_image",
  "unsupported_format", // webp, gif, avif, svg, heic, ... (YouCam takes jpg/png)
  "format_unknown", // no extension and no probe: we can't tell
  "image_too_small", // short side < MIN_SHORT_SIDE
  "image_too_large", // long side > MAX_LONG_SIDE and the CDN can't resize it
  "odd_aspect", // banner-like (long/short > MAX_ASPECT)
  "worn_or_lifestyle", // the photo shows the piece worn, or a styled scene
  "multiple_items", // a set, stack or bundle of several pieces
  "accessory", // box, holder, strap only, cleaner, gift card, ...
] as const;
export type TryOnReason = (typeof TRYON_REASONS)[number];

export const MIN_SHORT_SIDE = 400;
export const MAX_LONG_SIDE = 4096;
export const MAX_ASPECT = 2.5;
/** Width asked from a resizing CDN when the original is too large. */
export const RESIZE_WIDTH = 2048;
/** Ranged probes per preview (each costs one fetch of the 30, plus robots.txt once per image host). */
export const MAX_IMAGE_PROBES = 6;

/** What the store's own JSON says about an image (Shopify products.json, WooCommerce). All optional. */
export interface ImageMeta {
  url: string;
  width?: number;
  height?: number;
  alt?: string;
  /** 1-based position in the product's gallery. */
  position?: number;
}

/** What the first bytes of an image say (sniffImage). */
export interface ImageSniff {
  format: "jpeg" | "png" | "gif" | "webp" | "avif" | "svg" | "unknown";
  width?: number;
  height?: number;
}

export interface TryOnVerdict {
  category: TryOnCategory;
  tryOnEligible: boolean;
  tryOnReason: TryOnReason;
  /** The image to send to YouCam (one of the product's images, possibly with a CDN resize parameter). */
  tryOnImage?: string;
}

/** The fields classification reads (a PreviewProduct satisfies it). */
export interface ClassifiableProduct {
  title: string;
  category: JewelryCategory | null;
  categoryText?: string | null;
  tags?: readonly string[];
  images: readonly string[];
  /** Transient: per-image metadata from the store's JSON, same order as `images` where known. */
  imageMeta?: readonly ImageMeta[];
}

// ---------------------------------------------------------------------------------------------------
// Keyword rules
// ---------------------------------------------------------------------------------------------------

/** A person or a scene in the photo (checked on the image's alt text and file name, never the title alone). */
const WORN_RE = /\b(on[\s_-]?model|models?|worn|wearing|lifestyle|styled|campaign|editorial|lookbook|mannequin|on[\s_-]?(?:ear|neck|hand|wrist|body))\b/i;
/** Several pieces in one product (title or alt). "set" alone is not enough: "bezel set", "prong-set" are single pieces. */
const MULTI_RE = /\b(\d+\s?-?\s?(?:piece|pcs?)\b|(?:gift|jewel(?:le)?ry|earring|necklace|ring|bracelet|stacking|layering|bridal|matching)\s+sets?\b|set\s+of\s+\d+|pack\s+of\s+\d+|bundle|stack\b|duo\b|trio\b)/i;
/** Not a wearable piece. */
const ACCESSORY_RE = /\b(ring\s+box|jewel(?:le)?ry\s+(?:box|case|tray|stand|organi[sz]er|cleaner|dish)|gift\s+(?:box|card|wrap)|holder|ring\s+dish|trinket\s+dish|organi[sz]er|pouch|cleaner|cleaning\s+cloth|polish(?:ing)?\s+cloth|extender|ear\s+backs?|replacement\s+backs?|charger|screen\s+protector)\b/i;
/** A watch strap or band sold on its own. */
const STRAP_ONLY_RE = /\b(straps?|bands?|bracelet\s+links?)\b/i;

const IMG_EXT_RE = /\.(jpe?g|png|webp|gif|avif|svg|heic|heif|bmp|tiff?)$/i;

function extFormat(url: string): ImageSniff["format"] | "other" | null {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  const m = IMG_EXT_RE.exec(path);
  if (!m) return null;
  const e = m[1].toLowerCase();
  if (e === "jpg" || e === "jpeg") return "jpeg";
  if (e === "png" || e === "webp" || e === "gif" || e === "avif" || e === "svg") return e;
  return "other";
}

const fileName = (url: string) => {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "").replace(/[_-]+/g, " ");
  } catch {
    return "";
  }
};

/** Shopify's CDN resizes with `?width=` (cdn.shopify.com and the store's own /cdn/shop/ paths). */
export function resizableUrl(url: string, width = RESIZE_WIDTH): string | null {
  try {
    const u = new URL(url);
    if (u.hostname !== "cdn.shopify.com" && !u.pathname.startsWith("/cdn/shop/")) return null;
    u.searchParams.set("width", String(width));
    return u.href;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------
// Image header sniffing (first bytes only)
// ---------------------------------------------------------------------------------------------------

/** Format and pixel size from the first bytes of an image (PNG IHDR, JPEG SOFn, GIF, WebP VP8/VP8L/VP8X). */
export function sniffImage(bytes: Uint8Array): ImageSniff {
  const b = bytes;
  const u16be = (i: number) => (b[i] << 8) | b[i + 1];
  const u16le = (i: number) => b[i] | (b[i + 1] << 8);
  const u24le = (i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
  const u32be = (i: number) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
  const ascii = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
  if (b.length >= 24 && b[0] === 0x89 && ascii(1, 3) === "PNG" && ascii(12, 4) === "IHDR") {
    return { format: "png", width: u32be(16), height: u32be(20) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = b[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) {
        i += marker === 0xff ? 1 : 2;
        continue;
      }
      const len = u16be(i + 2);
      // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { format: "jpeg", height: u16be(i + 5), width: u16be(i + 7) };
      }
      if (len < 2) break;
      i += 2 + len;
    }
    return { format: "jpeg" };
  }
  if (b.length >= 10 && ascii(0, 3) === "GIF") return { format: "gif", width: u16le(6), height: u16le(8) };
  if (b.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const chunk = ascii(12, 4);
    if (chunk === "VP8X") return { format: "webp", width: u24le(24) + 1, height: u24le(27) + 1 };
    if (chunk === "VP8 ") return { format: "webp", width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
    if (chunk === "VP8L") {
      const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
      return { format: "webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return { format: "webp" };
  }
  if (b.length >= 12 && ascii(4, 4) === "ftyp" && /avi[fs]/.test(ascii(8, 4))) return { format: "avif" };
  const head = ascii(0, Math.min(b.length, 256)).trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return { format: "svg" };
  return { format: "unknown" };
}

// ---------------------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------------------

type ImageCheck = { ok: true; reason: "ok" | "ok_size_unknown"; image: string } | { ok: false; reason: TryOnReason };

/** One candidate image: format, pixel size, aspect, worn/lifestyle words in its alt text or file name. */
export function checkImage(meta: ImageMeta, sniff?: ImageSniff): ImageCheck {
  const text = `${meta.alt ?? ""} ${fileName(meta.url)}`;
  if (WORN_RE.test(text)) return { ok: false, reason: "worn_or_lifestyle" };
  if (MULTI_RE.test(meta.alt ?? "")) return { ok: false, reason: "multiple_items" };
  const byExt = extFormat(meta.url);
  const format = sniff && sniff.format !== "unknown" ? sniff.format : byExt;
  if (format === null || format === "unknown") return { ok: false, reason: "format_unknown" };
  if (format !== "jpeg" && format !== "png") return { ok: false, reason: "unsupported_format" };
  const width = sniff?.width ?? meta.width;
  const height = sniff?.height ?? meta.height;
  if (!width || !height) return { ok: true, reason: "ok_size_unknown", image: meta.url };
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  if (short < MIN_SHORT_SIDE) return { ok: false, reason: "image_too_small" };
  if (long / short > MAX_ASPECT) return { ok: false, reason: "odd_aspect" };
  if (long > MAX_LONG_SIDE) {
    const resized = resizableUrl(meta.url);
    return resized ? { ok: true, reason: "ok", image: resized } : { ok: false, reason: "image_too_large" };
  }
  return { ok: true, reason: "ok", image: meta.url };
}

/** The images worth checking: the first two, with whatever metadata the store gave. */
export function candidateImages(p: ClassifiableProduct): ImageMeta[] {
  const metaByUrl = new Map((p.imageMeta ?? []).map((m) => [m.url, m]));
  return p.images.slice(0, 2).map((url, i) => ({ position: i + 1, ...metaByUrl.get(url), url }));
}

/**
 * Pure classification (no network). `sniffs` maps an image URL to its probed header, when one was fetched.
 */
export function classifyTryOn(p: ClassifiableProduct, sniffs: ReadonlyMap<string, ImageSniff> = new Map()): TryOnVerdict {
  const category: TryOnCategory = p.category && TRYON_CATEGORIES.includes(p.category) ? p.category : "other";
  const no = (reason: TryOnReason): TryOnVerdict => ({ category, tryOnEligible: false, tryOnReason: reason });
  if (category === "other") return no("not_jewelry");
  const words = `${p.title} ${p.categoryText ?? ""} ${(p.tags ?? []).join(" ")}`;
  if (ACCESSORY_RE.test(words)) return no("accessory");
  if (category === "watch" && STRAP_ONLY_RE.test(p.title) && !/\bwatch(es)?\b/i.test(p.title)) return no("accessory");
  if (MULTI_RE.test(p.title)) return no("multiple_items");
  const candidates = candidateImages(p);
  if (!candidates.length) return no("no_image");
  let first: TryOnReason | undefined;
  for (const c of candidates) {
    const r = checkImage(c, sniffs.get(c.url));
    if (r.ok) return { category, tryOnEligible: true, tryOnReason: r.reason, tryOnImage: r.image };
    first ??= r.reason;
  }
  return no(first ?? "no_image");
}

/** Images whose pixel size or format only a probe can tell (jewelry, no size in the metadata). */
export function imagesToProbe(products: readonly ClassifiableProduct[]): string[] {
  const out: string[] = [];
  for (const p of products) {
    const v = classifyTryOn(p);
    if (v.category === "other" || v.tryOnReason === "accessory" || v.tryOnReason === "multiple_items") continue;
    if (v.tryOnReason !== "ok_size_unknown" && v.tryOnReason !== "format_unknown") continue;
    const c = candidateImages(p)[0];
    if (c && !out.includes(c.url)) out.push(c.url);
  }
  return out;
}

export interface ClassifyOptions {
  /** Ranged GET of the first bytes of an image (SafeFetcher.getImageHead). Omitted = no probes. */
  probe?: (url: string) => Promise<Uint8Array | null>;
  maxProbes?: number;
  /** Stop probing (deadline or fetch budget). */
  shouldStop?: () => boolean;
}

/**
 * Classifies every product and returns copies with `tryOnEligible`, `tryOnReason` and `tryOnImage` set and the
 * transient `imageMeta` removed. Probes run serially (SafeFetcher is serial anyway), at most `maxProbes`, and a
 * failed probe just leaves that image to the URL rules.
 */
export async function classifyProducts<P extends ClassifiableProduct>(
  products: readonly P[],
  opts: ClassifyOptions = {},
): Promise<Array<Omit<P, "imageMeta"> & Omit<TryOnVerdict, "category">>> {
  const sniffs = new Map<string, ImageSniff>();
  if (opts.probe) {
    const urls = imagesToProbe(products).slice(0, Math.max(0, opts.maxProbes ?? MAX_IMAGE_PROBES));
    for (const url of urls) {
      if (opts.shouldStop?.()) break;
      try {
        const head = await opts.probe(url);
        if (head && head.length) sniffs.set(url, sniffImage(head));
      } catch {
        /* the URL rules decide */
      }
    }
  }
  return products.map((p) => {
    const v = classifyTryOn(p, sniffs);
    const { imageMeta: _drop, ...rest } = p; // eslint-disable-line @typescript-eslint/no-unused-vars
    return { ...rest, tryOnEligible: v.tryOnEligible, tryOnReason: v.tryOnReason, ...(v.tryOnImage ? { tryOnImage: v.tryOnImage } : {}) };
  });
}

/** Short recipient/giver-facing words for an ineligible piece (never about the person). */
export function tryOnReasonText(reason: TryOnReason | undefined): string {
  switch (reason) {
    case "not_jewelry":
      return "Try-on works for earrings, necklaces, rings, bracelets and watches.";
    case "worn_or_lifestyle":
      return "The store's photo shows it being worn, which try-on can't use.";
    case "multiple_items":
      return "It's a set of several pieces, which try-on can't show.";
    case "accessory":
      return "It isn't worn, so there's nothing to try on.";
    case "image_too_small":
    case "image_too_large":
    case "odd_aspect":
    case "unsupported_format":
    case "format_unknown":
    case "no_image":
      return "The store's photo of it can't be used for try-on.";
    default:
      return "Not tried on.";
  }
}

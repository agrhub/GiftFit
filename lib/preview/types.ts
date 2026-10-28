/**
 * Store-URL preview types (owner: A10; ADR-055). A preview is GiftFit's own neutral store page built from
 * a merchant's PUBLIC product data, kept 24 h. Only the normalised fields below are stored: no merchant
 * HTML, no full descriptions, no images (image URLs are kept as-is and never fetched).
 */
import type { JewelryCategory, Metal } from "@/lib/contracts/giftfit";
import type { ImageMeta, TryOnReason } from "@/lib/ingest/tryon-eligibility";

export type PreviewState = "queued" | "crawling" | "ready" | "refused" | "failed";
export type PreviewPlatform = "shopify" | "woocommerce" | "jsonld";

/** Why a preview ended `refused` or `failed` (stable codes; the UI maps them to copy). */
export type PreviewReason =
  | "not_a_store" // fewer than 3 products found in public data
  | "robots_disallowed" // robots.txt forbids what a preview needs
  | "site_blocked" // the site answered 403/429/503 (bot protection) or asks for a longer crawl delay
  | "blocked_url" // a redirect led to a non-public address, http, a custom port, ...
  | "unreachable" // the host never answered (DNS, TLS, timeouts)
  | "timeout" // the whole crawl ran over its deadline
  | "interrupted" // the server restarted while crawling (cold start)
  | "internal";

export interface PreviewProduct {
  /** Store-side id (Shopify / WooCommerce id, JSON-LD sku, or URL slug). */
  id: string;
  title: string;
  /** The product page on the merchant's site ("View on <domain>"). */
  url: string;
  /** ≤ 4 absolute https image URLs, as published by the store (never cached; ingest may read a few image heads, A16). */
  images: string[];
  price: number | null;
  /** ISO 4217. */
  currency: string | null;
  /** Category as written by the store (product_type, WooCommerce category, JSON-LD category). */
  categoryText: string | null;
  /** GiftFit jewelry category guess (null for non-jewelry or unknown). */
  category: JewelryCategory | null;
  /** Canonical metal when stated (variant option, material) or in a jewelry title. */
  metal: Metal | null;
  /** Style word when the title/tags/summary use one ("minimal", "classic", ...). */
  style: string | null;
  /** ≤ 8 short store tags. */
  tags: string[];
  /** ≤ 160 chars of plain-text summary (short description), for search/grounding only. */
  summary: string | null;
  available: boolean | null;
  /**
   * YouCam jewelry try-on can use this product's photo (A16, lib/ingest/tryon-eligibility.ts; heuristics, no AI
   * call). Absent on previews made before it existed = not eligible (hearts-only, as before).
   */
  tryOnEligible?: boolean;
  /** Why (stable code, tryon-eligibility.ts TRYON_REASONS). */
  tryOnReason?: TryOnReason;
  /** The image sent to try-on when eligible (one of `images`, possibly with a CDN resize parameter). */
  tryOnImage?: string;
  /** Transient during ingest only (Shopify/WooCommerce image metadata); never stored. */
  imageMeta?: ImageMeta[];
}

export interface StoreIngestResult {
  outcome: "ready" | "refused" | "failed";
  reason?: PreviewReason;
  /** Final host the products came from (after redirects). */
  domain: string;
  /** https://<domain> */
  origin: string;
  storeName: string | null;
  platform: PreviewPlatform | null;
  products: PreviewProduct[];
  /** Dominant currency of the products, if any. */
  currency: string | null;
  fetches: number;
  ms: number;
}

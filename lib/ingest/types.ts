/**
 * Ingest types (owner: A10). Policy: docs/ingest-policy.md.
 *
 * Flow: detect platform → discover product URLs → extract `ExtractedProduct` (Tier 1 Shopify JSON,
 * Tier 2 JSON-LD / Open Graph, Tier 3 rendered DOM + extractor) → normalise to `IngestedSku`
 * (canonical GiftFit vocabulary) → embed → upsert into `catalog`.
 */
import type { JewelryAttributes, JewelryCategory } from "@/db/schema";

export type IngestTier = 1 | 2 | 3;
export type Platform = "shopify" | "jsonld" | "render" | "unknown";

/**
 * Fields an extractor reads off a page. Every field is "as written on the page": `null` (or `[]`)
 * when the page does not state it. Nothing is inferred or invented at this stage; mapping to the
 * canonical vocabulary happens in normalise.ts.
 */
export interface ExtractedProduct {
  title: string | null;
  /** Numeric price of THIS product (not related items, not shipping thresholds). */
  price: number | null;
  /** ISO 4217 code, only if stated or shown as an unambiguous symbol. */
  currency: string | null;
  /** Absolute product image URLs shown for this product. */
  images: string[];
  /** Metal as written, e.g. "14k Yellow Gold", "Sterling Silver". */
  metal: string | null;
  /** Stone as written, e.g. "Freshwater pearl". */
  stone: string | null;
  /** Product type as written, e.g. "Earrings", "Necklace". */
  category: string | null;
  /** Necklace / chain length as written, e.g. "18 in", "45 cm". */
  length: string | null;
  sku: string | null;
  brand: string | null;
  /** Short product description text from the page (≤ 600 chars). */
  description: string | null;
}

export const EMPTY_PRODUCT: ExtractedProduct = Object.freeze({
  title: null,
  price: null,
  currency: null,
  images: [],
  metal: null,
  stone: null,
  category: null,
  length: null,
  sku: null,
  brand: null,
  description: null,
}) as ExtractedProduct;

export interface RawProduct extends ExtractedProduct {
  sourceUrl: string;
  /** Store-side id: Shopify product[:variant] id, JSON-LD sku, or URL slug. */
  externalId: string;
  tier: IngestTier;
  /** Platform tags (Shopify `tags`), used for `key::value` attribute tags. */
  tags: string[];
}

/** A field an extractor proposed that the grounding check removed because the page does not support it. */
export interface DroppedField {
  field: keyof ExtractedProduct;
  value: unknown;
  reason: string;
}

/** A normalised catalog candidate. `complete` means it is a valid `CatalogSku` (contract) once stored. */
export interface IngestedSku {
  externalId: string;
  title: string;
  category: JewelryCategory | null;
  price: number | null;
  currency: string | null;
  images: string[];
  attributes: JewelryAttributes;
  sourceUrl: string;
  tier: IngestTier;
  /** Contract fields we could not fill (e.g. "metal", "price"). Empty when complete. */
  missing: string[];
  complete: boolean;
}

export interface Coverage {
  total: number;
  withMetal: number;
  withPrice: number;
  withImages: number;
  /** Items with metal AND price AND images (the P4 target: ≥ 90%). */
  withAll3: number;
  /** withAll3 / total, 0..1. */
  ratio: number;
}

export interface IngestProgress {
  phase: "detect" | "discover" | "extract" | "normalise" | "embed" | "store" | "done" | "error";
  discovered: number;
  processed: number;
  skus: number;
  errors: number;
  message?: string;
}

export interface IngestReport {
  storeUrl: string;
  platform: Platform;
  tier: IngestTier;
  detectionSignals: string[];
  discovered: number;
  skus: IngestedSku[];
  coverage: Coverage;
  dropped: { url: string; fields: DroppedField[] }[];
  errors: { url: string; error: string }[];
  extractor: string;
}

/**
 * Aurum Jewelry catalog view model (owner: A4). Reads A2's fixtures/aurum/catalog.json and exposes
 * shopper-facing fields only. Server pages import it directly; client components load it lazily
 * (`await import("@/client/store/catalog")`) so the 161-SKU JSON never lands in a page's
 * first-load bundle.
 */
import rawCatalog from "@/fixtures/aurum/catalog.json";
import type { CatalogSku, JewelryCategory, Metal, MetalVariant, Occasion } from "@/server/contracts/giftfit";
import type { GiftPiece } from "@/client/gift/giverDraft";

export interface Product {
  /** Catalog id (UUID). This is what the Fit Request API takes. */
  id: string;
  /** Human SKU, e.g. AUR-EAR-028. */
  sku: string;
  slug: string;
  title: string;
  category: JewelryCategory;
  price: number;
  currency: string;
  /** Primary display image (photo for the 12 demo SKUs, vector render elsewhere). */
  image: string;
  metal: Metal;
  /** Shopper-facing material, e.g. "10k yellow gold". */
  material: string;
  stone: string;
  style: string;
  occasions: Occasion[];
  description: string;
  isPhoto: boolean;
  genderPresentation?: "feminine" | "masculine" | "unisex";
  /** Metal variants the store sells (ADR-032). Always ≥ 1; the first is the default. */
  variants: ProductVariant[];
}

/** One metal of a design, as shoppers see it. */
export interface ProductVariant {
  variantId: string;
  metal: Metal;
  price: number;
  image: string;
  /** e.g. "10k white gold". */
  material: string;
}

type RawSku = CatalogSku & {
  variants?: MetalVariant[];
  attributes: CatalogSku["attributes"] & {
    sku: string;
    slug: string;
    material?: string;
    description?: string;
    image_source?: string;
  };
};

const RAW = rawCatalog as unknown as RawSku[];

function toProduct(s: RawSku): Product {
  const a = s.attributes;
  const fallbackImage = s.images[0] ?? a.vto_image;
  const variants: ProductVariant[] = (s.variants?.length ? s.variants : [{ variantId: `${s.id}:${a.metal}`, metal: a.metal, price: s.price, images: [fallbackImage], material: a.material } as MetalVariant]).map((v) => ({
    variantId: v.variantId,
    metal: v.metal,
    price: v.price,
    image: v.images?.[0] ?? v.vto_image ?? fallbackImage,
    material: v.material ?? a.material ?? v.metal.replace(/_/g, " "),
  }));
  return {
    variants,
    id: s.id,
    sku: a.sku,
    slug: a.slug,
    title: s.title,
    category: s.category,
    price: s.price,
    currency: s.currency,
    image: s.images[0] ?? a.vto_image,
    metal: a.metal,
    material: a.material ?? a.metal.replace(/_/g, " "),
    stone: a.stone ?? "none",
    style: a.style,
    occasions: a.occasions ?? [],
    description: a.description ?? "",
    isPhoto: a.image_source === "ai_photo",
    genderPresentation: a.gender_presentation,
  };
}

/** Photo SKUs first (they are the demo-critical pieces), then by price. Stable across renders. */
export const PRODUCTS: readonly Product[] = RAW.map(toProduct).sort((a, b) => Number(b.isPhoto) - Number(a.isPhoto) || a.price - b.price || a.sku.localeCompare(b.sku));

const BY_ID = new Map<string, Product>();
for (const p of PRODUCTS) {
  BY_ID.set(p.id, p);
  BY_ID.set(p.slug, p);
  BY_ID.set(p.sku.toLowerCase(), p);
}

/** Look up by catalog id, slug or SKU (case-insensitive). */
export function getProduct(idOrSlug: string): Product | undefined {
  const key = decodeURIComponent(idOrSlug);
  return BY_ID.get(key) ?? BY_ID.get(key.toLowerCase());
}

export function getProductsByIds(ids: readonly string[]): Product[] {
  return ids.map((id) => BY_ID.get(id)).filter((p): p is Product => Boolean(p));
}

export function productsInCategory(category: JewelryCategory): Product[] {
  return PRODUCTS.filter((p) => p.category === category);
}

export function featuredProducts(): Product[] {
  return PRODUCTS.filter((p) => p.isPhoto);
}

/** Pieces to show next to a product: same category first, then close in price. */
export function relatedProducts(product: Product, limit = 4): Product[] {
  return PRODUCTS.filter((p) => p.id !== product.id)
    .map((p) => ({ p, d: (p.category === product.category ? 0 : 1) * 10_000 + Math.abs(p.price - product.price) - (p.isPhoto ? 50 : 0) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, limit)
    .map((x) => x.p);
}

export const HERO_SKU = "AUR-EAR-028";

/** The Giver Panel's view of a product (product data only). */
export function toGiftPiece(p: Product): GiftPiece {
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    price: p.price,
    currency: p.currency,
    image: p.image,
    category: p.category,
    metal: p.metal,
    occasions: p.occasions,
    style: p.style,
    isPhoto: p.isPhoto,
    variants: p.variants.map((v) => ({ metal: v.metal, price: v.price })),
  };
}

/** The variant for a metal, else the default (first) one. */
export function variantFor(product: Pick<Product, "variants">, metal?: string | null): ProductVariant {
  return product.variants.find((v) => v.metal === metal) ?? product.variants[0];
}

/** Lowest variant price, for "from $X" on cards. */
export function priceFrom(product: Pick<Product, "variants" | "price">): number {
  return product.variants.length ? Math.min(...product.variants.map((v) => v.price)) : product.price;
}

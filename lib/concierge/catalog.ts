/**
 * Catalog view for the Gift Concierge (owner: A7). Deterministic, read-only, catalog facts only:
 * nothing here can reach a Fit Request, a recipient, a photo or a YouCam call.
 * Variant eligibility reuses lib/fit/variants (ADR-032: price ≤ budgetMax, same currency, inside the lock).
 */
import aurumCatalog from "@/data/aurum/catalog.json";
import type { StyleFamily } from "@/lib/contracts/api";
import type { CatalogSku, JewelryCategory, Metal, Occasion } from "@/lib/contracts/giftfit";
import { eligibleVariants, variantsOf } from "@/lib/fit/variants";

export type GenderPresentation = "feminine" | "masculine" | "unisex";

export interface ConciergeCatalog {
  readonly skus: readonly CatalogSku[];
  readonly byId: ReadonlyMap<string, CatalogSku>;
  /** The store's currency (all Aurum SKUs are USD). */
  readonly currency: string;
}

export function buildConciergeCatalog(skus: readonly CatalogSku[]): ConciergeCatalog {
  const counts = new Map<string, number>();
  for (const s of skus) counts.set(s.currency, (counts.get(s.currency) ?? 0) + 1);
  const currency = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "USD";
  return { skus, byId: new Map(skus.map((s) => [s.id, s])), currency };
}

let aurum: ConciergeCatalog | undefined;

/** The Aurum demo catalog (data/aurum/catalog.json), the same source lib/fit and lib/privacy use. */
export function defaultConciergeCatalog(): ConciergeCatalog {
  aurum ??= buildConciergeCatalog(aurumCatalog as unknown as CatalogSku[]);
  return aurum;
}

export interface MetalPrice {
  metal: Metal;
  price: number;
}

/** A compact row the model sees (no images, no descriptions beyond the title). */
export interface CatalogRow {
  id: string;
  title: string;
  category: JewelryCategory;
  style: string;
  genderPresentation: GenderPresentation;
  /** Metals with prices; when a budget or lock was given, only the eligible ones. */
  metals: MetalPrice[];
}

export function genderOf(sku: CatalogSku): GenderPresentation {
  return sku.attributes.gender_presentation ?? "unisex";
}

/** feminine → feminine + unisex; masculine → masculine + unisex; unisex → unisex only. */
export function genderMatches(sku: CatalogSku, wanted: GenderPresentation | undefined): boolean {
  if (!wanted) return true;
  const g = genderOf(sku);
  return wanted === "unisex" ? g === "unisex" : g === wanted || g === "unisex";
}

export function allMetals(sku: CatalogSku): MetalPrice[] {
  return variantsOf(sku)
    .map((v) => ({ metal: v.metal, price: v.price }))
    .sort((a, b) => a.price - b.price);
}

/** Variants within the cap and lock (ADR-032), cheapest first. */
export function eligibleMetals(sku: CatalogSku, budgetMax: number | undefined, metalLock: readonly Metal[] | undefined, currency: string): MetalPrice[] {
  const cap = budgetMax === undefined ? Number.POSITIVE_INFINITY : budgetMax;
  return eligibleVariants(sku, { budgetMax: cap, currency, metalLock })
    .map((v) => ({ metal: v.metal, price: v.price }))
    .sort((a, b) => a.price - b.price);
}

export function toRow(sku: CatalogSku, metals: MetalPrice[]): CatalogRow {
  return { id: sku.id, title: sku.title, category: sku.category, style: sku.attributes.style, genderPresentation: genderOf(sku), metals };
}

export interface SearchFilters {
  category?: JewelryCategory[];
  style?: StyleFamily[];
  metal?: Metal[];
  maxPrice?: number;
  occasion?: Occasion;
  genderPresentation?: GenderPresentation;
  text?: string;
  limit?: number;
}

const tokenize = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/[\s-]+/)
    .filter((t) => t.length >= 3);

function haystack(sku: CatalogSku): string {
  const a = sku.attributes as unknown as Record<string, unknown>;
  return [sku.title, sku.category, a.style, a.stone, a.material, a.description, a.earring_shape, a.necklace_style]
    .filter((v): v is string => typeof v === "string")
    .join(" ")
    .toLowerCase();
}

/**
 * Deterministic catalog search. Hard filters: category, style, metal (as a lock), maxPrice (as a cap),
 * gender presentation. Occasion and free text only rank (a design for "anniversary" ranks above one that
 * is not tagged for it, but is not excluded). Ties break on the cheapest eligible price, then the id.
 */
export function searchCatalog(catalog: ConciergeCatalog, f: SearchFilters): { rows: CatalogRow[]; total: number } {
  const terms = f.text ? tokenize(f.text) : [];
  const capped = f.maxPrice !== undefined || (f.metal && f.metal.length > 0);
  const scored: Array<{ sku: CatalogSku; metals: MetalPrice[]; score: number; textHits: number }> = [];
  for (const sku of catalog.skus) {
    if (f.category?.length && !f.category.includes(sku.category)) continue;
    if (f.style?.length && !f.style.includes(sku.attributes.style as StyleFamily)) continue;
    if (!genderMatches(sku, f.genderPresentation)) continue;
    const metals = capped ? eligibleMetals(sku, f.maxPrice, f.metal, catalog.currency) : allMetals(sku);
    if (metals.length === 0) continue;
    let textHits = 0;
    if (terms.length) {
      const h = haystack(sku);
      for (const t of terms) if (h.includes(t)) textHits += 1;
    }
    const score = textHits * 3 + (f.occasion && sku.attributes.occasions?.includes(f.occasion) ? 2 : 0);
    scored.push({ sku, metals, score, textHits });
  }
  // Free text narrows only when something matches it (any language may reach here; no match = rank only).
  const pool = terms.length && scored.some((s) => s.textHits > 0) ? scored.filter((s) => s.textHits > 0) : scored;
  pool.sort((a, b) => b.score - a.score || a.metals[0].price - b.metals[0].price || a.sku.id.localeCompare(b.sku.id));
  const limit = Math.max(1, Math.min(12, Math.floor(f.limit ?? 8)));
  return { rows: pool.slice(0, limit).map((s) => toRow(s.sku, s.metals)), total: pool.length };
}

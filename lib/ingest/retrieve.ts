/**
 * Hybrid retrieval over the catalog: hard attribute filter FIRST (store, category, metal, metal tone,
 * price band, exclusions), vector similarity SECOND (cosine on catalog.embedding). Used by the Fit
 * Request shortlist search, decoy candidates and the Concierge. Two implementations of one contract:
 * `InMemoryCatalogIndex` (tests, fixtures, key-less runs) and `buildPgvectorQuery` (Postgres +
 * pgvector, served by the `catalog_embedding_hnsw` index).
 */
import type { JewelryCategory } from "@/db/schema";
import type { Metal, MetalTone } from "@/lib/contracts/giftfit";
import { cosine } from "./embed";

export interface RetrievalFilter {
  storeId?: string;
  categories?: JewelryCategory[];
  metals?: Metal[];
  metalTones?: MetalTone[];
  priceMin?: number;
  priceMax?: number;
  excludeIds?: string[];
  /** Only SKUs whose attributes.vto_spec_ok is true (try-on ready). */
  vtoReady?: boolean;
}

export interface IndexedSku {
  id: string;
  storeId: string;
  category: JewelryCategory | null;
  price: number | null;
  attributes: { metal?: unknown; metal_tone?: unknown; vto_spec_ok?: unknown; [k: string]: unknown };
  embedding: number[] | null;
}

export interface RetrievalHit {
  id: string;
  score: number;
}

export function matchesFilter(s: IndexedSku, f: RetrievalFilter): boolean {
  if (f.storeId && s.storeId !== f.storeId) return false;
  if (f.categories?.length && (!s.category || !f.categories.includes(s.category))) return false;
  if (f.metals?.length && !f.metals.includes(s.attributes.metal as Metal)) return false;
  if (f.metalTones?.length && !f.metalTones.includes(s.attributes.metal_tone as MetalTone)) return false;
  if (f.priceMin !== undefined && (s.price === null || s.price < f.priceMin)) return false;
  if (f.priceMax !== undefined && (s.price === null || s.price > f.priceMax)) return false;
  if (f.excludeIds?.includes(s.id)) return false;
  if (f.vtoReady && s.attributes.vto_spec_ok !== true) return false;
  return true;
}

export class InMemoryCatalogIndex {
  private readonly items = new Map<string, IndexedSku>();

  upsert(skus: IndexedSku[]): void {
    for (const s of skus) this.items.set(s.id, s);
  }
  get size(): number {
    return this.items.size;
  }

  /**
   * Filter, then rank by cosine similarity (ties broken by id for determinism). Without a query
   * vector the filtered set is returned in price order (cheapest first), score 0.
   */
  search(query: number[] | null, filter: RetrievalFilter = {}, k = 20): RetrievalHit[] {
    const pool = [...this.items.values()].filter((s) => matchesFilter(s, filter));
    if (!query) {
      return pool
        .sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity) || a.id.localeCompare(b.id))
        .slice(0, k)
        .map((s) => ({ id: s.id, score: 0 }));
    }
    return pool
      .filter((s) => s.embedding)
      .map((s) => ({ id: s.id, score: cosine(query, s.embedding as number[]) }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, k);
  }
}

/** pgvector text literal: '[0.1,0.2,…]'. */
export const toVectorLiteral = (v: number[]) => `[${v.map((x) => (Number.isFinite(x) ? Number(x.toFixed(7)) : 0)).join(",")}]`;

/**
 * Parameterised SQL for the same search on Postgres (`catalog` table). Attribute predicates come first
 * (index-friendly: catalog_store_category_idx, catalog_attributes_gin), then
 * `ORDER BY embedding <=> $q` (cosine distance; score = 1 - distance). Values are always bound
 * parameters, never interpolated.
 */
export function buildPgvectorQuery(query: number[] | null, f: RetrievalFilter = {}, k = 20): { text: string; params: unknown[] } {
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const where: string[] = [];
  if (f.storeId) where.push(`store_id = ${p(f.storeId)}`);
  if (f.categories?.length) where.push(`category = ANY(${p(f.categories)}::text[])`);
  if (f.metals?.length) where.push(`attributes->>'metal' = ANY(${p(f.metals)}::text[])`);
  if (f.metalTones?.length) where.push(`attributes->>'metal_tone' = ANY(${p(f.metalTones)}::text[])`);
  if (f.priceMin !== undefined) where.push(`price >= ${p(f.priceMin)}`);
  if (f.priceMax !== undefined) where.push(`price <= ${p(f.priceMax)}`);
  if (f.excludeIds?.length) where.push(`NOT (id = ANY(${p(f.excludeIds)}::uuid[]))`);
  if (f.vtoReady) where.push(`attributes @> '{"vto_spec_ok": true}'::jsonb`);
  const limit = Math.max(1, Math.min(200, Math.floor(k)));
  if (query) {
    where.push("embedding IS NOT NULL");
    const q = p(toVectorLiteral(query));
    return {
      text: `SELECT id, 1 - (embedding <=> ${q}::vector) AS score FROM catalog${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY embedding <=> ${q}::vector, id LIMIT ${limit}`,
      params,
    };
  }
  return {
    text: `SELECT id, 0 AS score FROM catalog${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY price ASC NULLS LAST, id LIMIT ${limit}`,
    params,
  };
}

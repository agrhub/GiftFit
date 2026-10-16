/**
 * Where ingest writes: `stores` + `catalog` (db/schema.ts). `DbCatalogSink` uses Drizzle on Neon and
 * needs DATABASE_URL; `InMemoryCatalogSink` is for tests, INGEST_FIXTURE=1 and key-less demo runs.
 * Rows are keyed by (store_id, external_id), so re-ingesting a store updates in place.
 */
import { createHash } from "node:crypto";
import type { IngestTier, IngestedSku, IngestProgress, Platform } from "./types";
import { InMemoryCatalogIndex } from "./retrieve";

export interface StoreInput {
  url: string;
  name: string;
  platform: Platform;
  vertical?: "jewelry" | "beauty";
}

export interface StorePatch {
  platform?: Platform;
  ingestStatus?: "pending" | "running" | "done" | "error";
  ingestTier?: IngestTier;
  ingestProgress?: IngestProgress;
  skuCount?: number;
  error?: string | null;
  lastIngestedAt?: Date;
}

export type SkuWithEmbedding = IngestedSku & { embedding: number[] | null };

export interface CatalogSink {
  readonly name: string;
  upsertStore(input: StoreInput): Promise<string>;
  updateStore(storeId: string, patch: StorePatch): Promise<void>;
  /** Returns the number of rows written. */
  upsertSkus(storeId: string, skus: SkuWithEmbedding[]): Promise<number>;
}

/** Deterministic RFC 4122-shaped id from a name (stable across runs; for the in-memory sink). */
export function stableUuid(name: string): string {
  const h = createHash("sha256").update(name).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export interface MemoryStore extends StoreInput, Omit<StorePatch, "platform"> {
  id: string;
}
export interface MemorySku extends SkuWithEmbedding {
  id: string;
  storeId: string;
}

export class InMemoryCatalogSink implements CatalogSink {
  readonly name = "memory";
  readonly stores = new Map<string, MemoryStore>();
  readonly skus = new Map<string, MemorySku>();

  async upsertStore(input: StoreInput): Promise<string> {
    const id = stableUuid(`store:${input.url}`);
    this.stores.set(id, { ...this.stores.get(id), ...input, id });
    return id;
  }

  async updateStore(storeId: string, patch: StorePatch): Promise<void> {
    const s = this.stores.get(storeId);
    if (!s) throw new Error(`unknown store ${storeId}`);
    this.stores.set(storeId, { ...s, ...patch });
  }

  async upsertSkus(storeId: string, skus: SkuWithEmbedding[]): Promise<number> {
    for (const s of skus) {
      const id = stableUuid(`sku:${storeId}:${s.externalId}`);
      this.skus.set(id, { ...s, id, storeId });
    }
    return skus.length;
  }

  skusOf(storeId: string): MemorySku[] {
    return [...this.skus.values()].filter((s) => s.storeId === storeId);
  }

  index(): InMemoryCatalogIndex {
    const idx = new InMemoryCatalogIndex();
    idx.upsert(
      [...this.skus.values()].map((s) => ({
        id: s.id,
        storeId: s.storeId,
        category: s.category,
        price: s.price,
        attributes: s.attributes,
        embedding: s.embedding,
      })),
    );
    return idx;
  }
}

/** Postgres sink (Drizzle, Neon HTTP). Imported lazily so tests and fixture runs never touch the DB. */
export class DbCatalogSink implements CatalogSink {
  readonly name = "postgres";

  private async db() {
    const [{ getDb }, schema] = await Promise.all([import("@/db/index"), import("@/db/schema")]);
    return { db: getDb(), schema };
  }

  async upsertStore(input: StoreInput): Promise<string> {
    const { db, schema } = await this.db();
    const rows = await db
      .insert(schema.stores)
      .values({ url: input.url, name: input.name, platform: input.platform, vertical: input.vertical ?? "jewelry" })
      .onConflictDoUpdate({ target: schema.stores.url, set: { name: input.name, platform: input.platform, updatedAt: new Date() } })
      .returning({ id: schema.stores.id });
    return rows[0].id;
  }

  async updateStore(storeId: string, patch: StorePatch): Promise<void> {
    const { db, schema } = await this.db();
    const { eq } = await import("drizzle-orm");
    await db
      .update(schema.stores)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(schema.stores.id, storeId));
  }

  async upsertSkus(storeId: string, skus: SkuWithEmbedding[]): Promise<number> {
    const { db, schema } = await this.db();
    const { sql } = await import("drizzle-orm");
    let n = 0;
    for (let i = 0; i < skus.length; i += 50) {
      const batch = skus.slice(i, i + 50).map((s) => ({
        storeId,
        externalId: s.externalId,
        vertical: "jewelry",
        title: s.title,
        category: s.category,
        brand: null,
        price: s.price === null ? null : s.price.toFixed(2),
        currency: s.currency,
        images: s.images,
        attributes: s.attributes,
        sourceUrl: s.sourceUrl,
        fetchedAt: new Date(),
        embedding: s.embedding,
      }));
      await db
        .insert(schema.catalog)
        .values(batch)
        .onConflictDoUpdate({
          target: [schema.catalog.storeId, schema.catalog.externalId],
          set: {
            title: sql`excluded.title`,
            category: sql`excluded.category`,
            price: sql`excluded.price`,
            currency: sql`excluded.currency`,
            images: sql`excluded.images`,
            attributes: sql`excluded.attributes`,
            sourceUrl: sql`excluded.source_url`,
            fetchedAt: sql`excluded.fetched_at`,
            embedding: sql`excluded.embedding`,
            updatedAt: new Date(),
          },
        });
      n += batch.length;
    }
    return n;
  }
}

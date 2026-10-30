/**
 * Seeds the Aurum Jewelry demo store and catalog (owner: A2).
 *   npm run seed
 * - Always validates fixtures/aurum/catalog.json against server/contracts/giftfit.ts first (exit 1 on any problem).
 * - Without DATABASE_URL: prints counts and exits 0 (nothing is written).
 * - With DATABASE_URL: upserts the store and every SKU by deterministic id, then removes Aurum rows that are
 *   no longer in the catalog. Re-running gives the same state (idempotent). ~160 rows in 4 statements.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { and, eq, getTableColumns, notInArray, sql } from "drizzle-orm";
import type { CatalogSku } from "@/server/contracts/giftfit";
import { catalogStats } from "@/scripts/catalog/stats";
import { validateCatalog } from "@/scripts/catalog/validate";
import type { Db } from "./index";
import { catalog, stores } from "./schema";

export interface AurumStore {
  id: string;
  name: string;
  url: string;
  platform: string;
  vertical: string;
}

export type StoreRow = typeof stores.$inferInsert;
export type CatalogRow = typeof catalog.$inferInsert;

export function storeRow(store: AurumStore, skuCount: number): StoreRow {
  return {
    id: store.id,
    name: store.name,
    url: store.url,
    platform: store.platform,
    vertical: store.vertical,
    ingestStatus: "done",
    skuCount,
  };
}

export function catalogRow(sku: CatalogSku): CatalogRow {
  return {
    id: sku.id,
    storeId: sku.storeId,
    externalId: String(sku.attributes.sku),
    vertical: "jewelry",
    title: sku.title,
    category: sku.category,
    brand: "Aurum Jewelry",
    price: sku.price.toFixed(2),
    currency: sku.currency,
    images: sku.images,
    // the catalog table has no variants column (A1 schema): variants travel in attributes.variants (ADR-032)
    attributes: sku.variants ? { ...sku.attributes, variants: sku.variants } : sku.attributes,
    sourceUrl: sku.sourceUrl ?? null,
  };
}

/** `set` clause that copies every non-key column from the proposed row (Postgres `excluded`). */
function excludedSet<T extends typeof catalog | typeof stores>(table: T, skip: string[]): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  for (const [key, col] of Object.entries(getTableColumns(table))) {
    if (skip.includes(key)) continue;
    set[key] = sql.raw(`excluded."${col.name}"`);
  }
  set.updatedAt = sql`now()`;
  return set;
}

export function buildStoreUpsert(db: Db, row: StoreRow) {
  return db
    .insert(stores)
    .values(row)
    .onConflictDoUpdate({ target: stores.id, set: excludedSet(stores, ["id", "createdAt", "updatedAt", "ingestTier", "ingestProgress", "lastIngestedAt", "error"]) });
}

export function buildCatalogUpsert(db: Db, rows: CatalogRow[]) {
  return db
    .insert(catalog)
    .values(rows)
    .onConflictDoUpdate({ target: catalog.id, set: excludedSet(catalog, ["id", "createdAt", "updatedAt", "embedding", "fetchedAt"]) });
}

export function buildStaleDelete(db: Db, storeId: string, keepIds: string[]) {
  return db
    .delete(catalog)
    .where(and(eq(catalog.storeId, storeId), notInArray(catalog.id, keepIds)))
    .returning({ id: catalog.id });
}

/** Narrow write interface so the seed logic is testable without a database. */
export interface SeedWriter {
  upsertStore(row: StoreRow): Promise<void>;
  upsertCatalog(rows: CatalogRow[]): Promise<void>;
  deleteStale(storeId: string, keepIds: string[]): Promise<number>;
}

export function drizzleWriter(db: Db): SeedWriter {
  return {
    async upsertStore(row) {
      await buildStoreUpsert(db, row);
    },
    async upsertCatalog(rows) {
      await buildCatalogUpsert(db, rows);
    },
    async deleteStale(storeId, keepIds) {
      const gone = await buildStaleDelete(db, storeId, keepIds);
      return gone.length;
    },
  };
}

export interface SeedResult {
  store: string;
  upserted: number;
  deleted: number;
}

export async function seedCatalog(writer: SeedWriter, store: AurumStore, skus: CatalogSku[], chunk = 60): Promise<SeedResult> {
  const foreign = skus.filter((s) => s.storeId !== store.id);
  if (foreign.length) throw new Error(`${foreign.length} SKU(s) do not belong to store ${store.id}`);
  await writer.upsertStore(storeRow(store, skus.length));
  const rows = skus.map(catalogRow);
  for (let i = 0; i < rows.length; i += chunk) await writer.upsertCatalog(rows.slice(i, i + chunk));
  const deleted = await writer.deleteStale(store.id, rows.map((r) => r.id as string));
  return { store: store.id, upserted: rows.length, deleted };
}

export function loadAurum(root = process.cwd()): { store: AurumStore; skus: CatalogSku[] } {
  const dir = path.join(root, "fixtures/aurum");
  const store = JSON.parse(readFileSync(path.join(dir, "store.json"), "utf8")) as AurumStore;
  const skus = JSON.parse(readFileSync(path.join(dir, "catalog.json"), "utf8")) as CatalogSku[];
  return { store, skus };
}

async function main(): Promise<number> {
  const t0 = Date.now();
  const { loadEnvConfig } = await import("@next/env");
  loadEnvConfig(process.cwd());
  const { store, skus } = loadAurum();
  const problems = validateCatalog(skus);
  if (problems.length) {
    console.error(`catalog.json is invalid (${problems.length} problem(s)):\n${problems.slice(0, 50).join("\n")}`);
    return 1;
  }
  const stats = catalogStats(skus);
  console.log(`${store.name}: ${skus.length} SKUs valid`);
  for (const k of Object.keys(stats).filter((x) => x.startsWith("category:") || x.startsWith("vto_spec_ok:")).sort()) console.log(`  ${k} = ${stats[k]}`);
  const { getDb, hasDatabase } = await import("./index");
  if (!hasDatabase()) {
    console.log(`DATABASE_URL is not set: validated only, nothing written (${((Date.now() - t0) / 1000).toFixed(1)} s in seed, ${process.uptime().toFixed(1)} s incl. startup).`);
    return 0;
  }
  const res = await seedCatalog(drizzleWriter(getDb()), store, skus);
  console.log(`seeded store ${res.store}: ${res.upserted} upserted, ${res.deleted} stale removed in ${((Date.now() - t0) / 1000).toFixed(1)} s (${process.uptime().toFixed(1)} s incl. startup)`);
  return 0;
}

if (process.argv[1] && /seed\.ts$/.test(process.argv[1])) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}

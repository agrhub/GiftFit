import { afterEach, describe, expect, it, vi } from "vitest";
import { getDb, resetDb } from "@/db/index";
import {
  buildCatalogUpsert,
  buildStaleDelete,
  buildStoreUpsert,
  catalogRow,
  loadAurum,
  seedCatalog,
  storeRow,
  type CatalogRow,
  type SeedWriter,
  type StoreRow,
} from "@/db/seed";

/** In-memory stand-in for the two tables, with Postgres upsert-by-id semantics. */
function memoryDb() {
  const stores = new Map<string, StoreRow>();
  const catalog = new Map<string, CatalogRow>();
  const calls = { store: 0, catalog: 0, delete: 0 };
  const writer: SeedWriter = {
    async upsertStore(row) {
      calls.store++;
      stores.set(row.id as string, { ...row });
    },
    async upsertCatalog(rows) {
      calls.catalog++;
      for (const r of rows) catalog.set(r.id as string, structuredClone(r));
    },
    async deleteStale(storeId, keep) {
      calls.delete++;
      let n = 0;
      for (const [id, r] of catalog) {
        if (r.storeId === storeId && !keep.includes(id)) {
          catalog.delete(id);
          n++;
        }
      }
      return n;
    },
  };
  return { stores, catalog, calls, writer };
}

afterEach(() => {
  vi.unstubAllEnvs();
  resetDb();
});

describe("db/seed.ts", () => {
  const { store, skus } = loadAurum();

  it("is idempotent: a second run leaves exactly the same rows", async () => {
    const db = memoryDb();
    const first = await seedCatalog(db.writer, store, skus);
    const snapshot = JSON.stringify([...db.catalog.entries()]);
    const second = await seedCatalog(db.writer, store, skus);
    expect(first).toEqual({ store: store.id, upserted: skus.length, deleted: 0 });
    expect(second).toEqual(first);
    expect(db.stores.size).toBe(1);
    expect(db.catalog.size).toBe(skus.length);
    expect(JSON.stringify([...db.catalog.entries()])).toBe(snapshot);
    expect(db.calls.catalog).toBe(2 * Math.ceil(skus.length / 60));
  });

  it("removes Aurum rows that left the catalog but keeps other stores' rows", async () => {
    const db = memoryDb();
    const other = { ...catalogRow(skus[0]), id: "00000000-0000-4000-8000-000000000001", storeId: "00000000-0000-4000-8000-0000000000aa" };
    db.catalog.set(other.id as string, other);
    await seedCatalog(db.writer, store, skus);
    const res = await seedCatalog(db.writer, store, skus.slice(1));
    expect(res.deleted).toBe(1);
    expect(db.catalog.has(skus[0].id)).toBe(false);
    expect(db.catalog.has(other.id as string)).toBe(true);
  });

  it("refuses SKUs of another store", async () => {
    const db = memoryDb();
    await expect(seedCatalog(db.writer, store, [{ ...skus[0], storeId: "00000000-0000-4000-8000-0000000000aa" }])).rejects.toThrow(/do not belong/);
    expect(db.calls.store).toBe(0);
  });

  it("maps rows onto the A1 schema (numeric price as string, sku as external_id)", () => {
    const row = catalogRow(skus[0]);
    expect(row).toMatchObject({ id: skus[0].id, storeId: store.id, externalId: skus[0].attributes.sku, vertical: "jewelry", currency: "USD" });
    expect(row.price).toBe(skus[0].price.toFixed(2));
    // no variants column in the A1 schema: variants are carried in attributes.variants
    expect((row.attributes as Record<string, unknown>).variants).toEqual(skus[0].variants);
    expect(skus[0].attributes).not.toHaveProperty("variants");
    expect(storeRow(store, skus.length)).toMatchObject({ name: "Aurum Jewelry", skuCount: skus.length, ingestStatus: "done" });
  });

  it("builds ON CONFLICT (id) DO UPDATE upserts and a store-scoped stale delete", () => {
    vi.stubEnv("DATABASE_URL", "postgres://user:pw@example.invalid/db"); // lazy: nothing connects for toSQL()
    const db = getDb();
    const up = buildCatalogUpsert(db, skus.slice(0, 2).map(catalogRow)).toSQL().sql;
    expect(up).toMatch(/on conflict \("id"\) do update set/i);
    expect(up).toMatch(/"title" = excluded\."title"/);
    expect(up).toMatch(/"attributes" = excluded\."attributes"/);
    expect(up).not.toMatch(/"embedding" = excluded/);
    expect(buildStoreUpsert(db, storeRow(store, 1)).toSQL().sql).toMatch(/on conflict \("id"\) do update/i);
    const del = buildStaleDelete(db, store.id, [skus[0].id]).toSQL();
    expect(del.sql).toMatch(/delete from "catalog" where \("catalog"\."store_id" = \$1 and "catalog"\."id" not in \(\$2\)\)/i);
  });
});

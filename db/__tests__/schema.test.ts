import { getTableColumns, getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { auditRow } from "../audit";
import { getDb, hasDatabase, resetDb } from "../index";
import * as schema from "../schema";

afterEach(() => {
  vi.unstubAllEnvs();
  resetDb();
});

const columns = (t: Parameters<typeof getTableColumns>[0]) => Object.values(getTableColumns(t)).map((c) => c.name);

describe("GiftFit schema (MASTER_PLAN v2 4.1)", () => {
  it("has exactly the v2 tables", () => {
    const tables = Object.values(schema)
      .filter((v) => typeof v === "object" && v !== null && Symbol.for("drizzle:Name") in (v as object))
      .map((t) => getTableName(t as never))
      .sort();
    expect(tables).toEqual([
      "audit_log",
      "catalog",
      "fit_reports",
      "fit_requests",
      "hearts",
      "metal_wishes",
      "recipient_profiles",
      "retailer_metrics",
      "stores",
      "tryons",
      "youcam_results",
    ]);
  });

  it("keeps photos, hex colors and raw face data out of recipient-facing tables a giver route could read", () => {
    // Metadata columns whose names match the pattern but hold no image data (reviewed one by one).
    const ALLOWED_METADATA = new Set(["fit_requests.photo_deleted_at"]);
    const forbidden = /image|photo|selfie|hex|color|colour|url|blob|attributes|landmark/i;
    for (const t of [schema.recipientProfiles, schema.fitReports, schema.hearts, schema.metalWishes, schema.fitRequests]) {
      for (const c of columns(t)) {
        if (ALLOWED_METADATA.has(`${getTableName(t)}.${c}`)) continue;
        expect(c, `${getTableName(t)}.${c}`).not.toMatch(forbidden);
      }
    }
    expect(columns(schema.recipientProfiles)).toEqual(
      expect.arrayContaining(["undertone_estimate", "undertone_override", "face_shape", "expires_at"]),
    );
    expect(columns(schema.fitRequests)).toEqual(expect.arrayContaining(["giver_token_hash", "recipient_token_hash", "shortlist_ids", "decoy_ids"]));
    expect(columns(schema.catalog)).toContain("embedding");
    expect(schema.EMBEDDING_DIM).toBe(1024);
  });

  it("stores metal variants (ADR-032): metal lock, hearted variant, metal wishes", () => {
    const fr = getTableColumns(schema.fitRequests);
    expect(fr.metalLock.name).toBe("metal_lock");
    expect(fr.metalLock.getSQLType()).toBe("text[]");
    expect(fr.metalLock.notNull).toBe(false);

    const h = getTableColumns(schema.hearts);
    expect(h.variantId.name).toBe("variant_id");
    expect(h.variantId.getSQLType()).toBe("text");
    expect(h.variantId.notNull).toBe(false);
    expect(h.catalogId.notNull).toBe(true);
    const heartsCfg = getTableConfig(schema.hearts);
    expect(heartsCfg.uniqueConstraints.map((u) => [u.getName(), u.columns.map((c) => c.name), u.nullsNotDistinct])).toEqual([
      ["hearts_request_catalog_variant_uq", ["fit_request_id", "catalog_id", "variant_id"], true],
    ]);

    expect(columns(schema.metalWishes).sort()).toEqual(["catalog_id", "created_at", "fit_request_id", "id"]);
    const wishes = getTableConfig(schema.metalWishes);
    expect(wishes.foreignKeys.map((f) => [f.reference().foreignTable === schema.fitRequests, f.onDelete])).toContainEqual([true, "cascade"]);
    expect(wishes.indexes.map((i) => i.config.name)).toEqual(["metal_wishes_request_catalog_uq"]);

    // variants stay in catalog.attributes (jsonb); no separate variants table
    expect(Object.keys(schema)).not.toContain("catalogVariants");
    expect(getTableColumns(schema.catalog).attributes.getSQLType()).toBe("jsonb");
  });

  it("records 'Delete my photo now' on fit_requests (ADR-036)", () => {
    const c = getTableColumns(schema.fitRequests).photoDeletedAt;
    expect(c.name).toBe("photo_deleted_at");
    expect(c.getSQLType()).toBe("timestamp with time zone");
    expect(c.notNull).toBe(false);
    expect(c.hasDefault).toBe(false);
  });

  it("marks seeded judge-demo requests on fit_requests (ADR-038)", () => {
    const c = getTableColumns(schema.fitRequests).demo;
    expect(c.name).toBe("demo");
    expect(c.getSQLType()).toBe("boolean");
    expect(c.notNull).toBe(true);
    expect(c.default).toBe(false);
  });

  it("every table with fit_request_id cascades from fit_requests (delete-everything coverage)", () => {
    const withRequest = [schema.recipientProfiles, schema.tryons, schema.hearts, schema.metalWishes, schema.fitReports];
    for (const t of withRequest) {
      const fk = getTableConfig(t).foreignKeys.find((f) => f.reference().columns.some((c) => c.name === "fit_request_id"));
      expect(fk?.reference().foreignTable, getTableName(t)).toBe(schema.fitRequests);
      expect(fk?.onDelete, getTableName(t)).toBe("cascade");
    }
    expect(columns(schema.recipientProfiles).filter((c) => /image|photo|hex|color|url/i.test(c))).toEqual([]);
  });

  it("connects lazily and maps audit events", () => {
    vi.stubEnv("DATABASE_URL", "");
    expect(hasDatabase()).toBe(false);
    expect(() => getDb()).toThrow(/DATABASE_URL/);
    vi.stubEnv("DATABASE_URL", "postgres://user:pw@example.invalid/db");
    expect(hasDatabase()).toBe(true);
    const db = getDb();
    expect(getDb()).toBe(db);
    const row = auditRow({ ts: "2026-10-15T00:00:00.000Z", event: "youcam.attempt", mode: "real", balanceBefore: 40, unitsExpected: 1 });
    expect(row).toMatchObject({ event: "youcam.attempt", balanceBefore: "40", unitsExpected: 1 });
    expect(row.ts).toEqual(new Date("2026-10-15T00:00:00.000Z"));
    expect(auditRow({ ts: "2026-10-15T00:00:00.000Z", event: "youcam.outcome", mode: "mock" }).balanceBefore).toBeUndefined();
  });
});

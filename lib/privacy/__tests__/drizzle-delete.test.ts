/**
 * SQL-level proof for the Drizzle stack: deleteEverything issues a DELETE against every table
 * that references the Fit Request, purges youcam_results through A1's cache API, and closes the
 * request. A recording pg-proxy driver stands in for Neon (no DATABASE_URL needed).
 */
import { getTableColumns, getTableName } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import { createDefaultResultCache } from "@/lib/youcam/cache";
import { deleteEverything } from "../delete-everything";
import type { PrivacyDeps } from "../deps";
import { StaticCatalogSource } from "../catalog";
import { MemoryPhotoStore } from "../photo-store";
import { DrizzlePrivacyRepos, type AnyPgDb } from "../repos/drizzle";

interface Stmt {
  sql: string;
  params: unknown[];
}

const REQ = "0d6f4d8e-5c8a-4a51-9a3e-6f1b9a1c2d3e";
const TASKS = [
  { id: "t1", feature: "skin-tone-analysis", taskId: "task_tones", cacheKey: "a".repeat(64), resultRef: null },
  { id: "t2", feature: "2d-vto/earring", taskId: "task_vto", cacheKey: "b".repeat(64), resultRef: "store:tryon/x/tryon-1-a" },
];

const log: Stmt[] = [];

/** Positional rows, as pg-proxy expects for method "all". */
function respond(sql: string): unknown[][] {
  const s = sql.toLowerCase();
  if (s.startsWith("select") && s.includes('from "tryons"') && !s.includes("count(")) {
    // id, cache_key, fit_request_id, catalog_id, feature, task_id, result_ref, status, error_code, units_charged, created_at, expires_at
    const cols = Object.keys(getTableColumns(schema.tryons));
    return TASKS.map((t) =>
      cols.map((c) =>
        ({
          id: t.id,
          cacheKey: t.cacheKey,
          fitRequestId: REQ,
          catalogId: null,
          feature: t.feature,
          taskId: t.taskId,
          resultRef: t.resultRef,
          status: "success",
          errorCode: null,
          unitsCharged: 0,
          createdAt: "2026-10-20 12:00:00+00",
          expiresAt: "2026-10-23 12:00:00+00",
        })[c as "id"],
      ),
    );
  }
  if (s.startsWith("delete")) return [["row-1"]];
  if (s.includes("count(")) return [[0]];
  return [];
}

const proxy = drizzle(
  async (sql, params) => {
    log.push({ sql, params });
    const rows = respond(sql);
    return { rows };
  },
  { schema },
) as unknown as AnyPgDb;

vi.mock("@/db/index", () => ({
  getDb: () => proxy,
  hasDatabase: () => true,
  resetDb: () => {},
  schema,
}));

beforeEach(() => {
  log.length = 0;
});

/** Tables (other than fit_requests) with a fit_request_id column: all must be cleared. */
const tablesReferencingRequest = Object.values(schema)
  .filter((v): v is typeof schema.tryons => typeof v === "object" && v !== null && Symbol.for("drizzle:Name") in (v as object))
  .filter((t) => Object.values(getTableColumns(t)).some((c) => c.name === "fit_request_id"))
  .map((t) => getTableName(t))
  .sort();

describe("DrizzlePrivacyRepos.deleteRecipientData", () => {
  it("covers every table that references a Fit Request", () => {
    expect(tablesReferencingRequest).toEqual(["fit_reports", "hearts", "metal_wishes", "recipient_profiles", "tryons"]);
  });

  it("issues one parameterised DELETE per table, scoped to the request", async () => {
    const repos = new DrizzlePrivacyRepos(() => proxy);
    const counts = await repos.deleteRecipientData(REQ);
    const deletes = log.filter((s) => /^delete/i.test(s.sql));
    expect(deletes.map((d) => /delete from "(\w+)"/i.exec(d.sql)?.[1]).sort()).toEqual(tablesReferencingRequest);
    for (const d of deletes) {
      expect(d.sql).toMatch(/where "\w+"\."fit_request_id" = \$1/);
      expect(d.params).toEqual([REQ]);
    }
    expect(counts).toEqual({ recipient_profiles: 1, tryons: 1, hearts: 1, metal_wishes: 1, fit_reports: 1 });
  });
});

describe("deleteEverything on the Drizzle stack", () => {
  it("purges youcam_results via lib/youcam, deletes YouCam tasks, deletes rows and closes the request", async () => {
    const repos = new DrizzlePrivacyRepos(() => proxy);
    const cache = createDefaultResultCache({ databaseUrl: "postgres://mocked", dataDir: "unused" });
    const deleteTask = vi.fn(async () => {});
    const photos = new MemoryPhotoStore();
    const deps: PrivacyDeps = {
      repos,
      photos,
      youcam: { deleteTask, deleteCachedResult: (k) => cache.delete(k) },
      signingSecret: "x".repeat(40),
      catalog: new StaticCatalogSource([]),
      now: () => new Date("2026-10-21T00:00:00Z"),
    };
    const receipt = await deleteEverything(deps, REQ);

    const sqls = log.map((s) => s.sql.toLowerCase());
    // Result cache rows (hex colors, face data, render URLs) for both task cache keys.
    const cacheDeletes = log.filter((s) => /delete from "youcam_results"/i.test(s.sql));
    expect(cacheDeletes.map((d) => d.params[0]).sort()).toEqual(TASKS.map((t) => t.cacheKey).sort());
    // YouCam task/delete for both tasks.
    expect(deleteTask.mock.calls.map((c) => (c as unknown[])[0]).sort()).toEqual(["task_tones", "task_vto"]);
    // Every request-scoped table.
    for (const t of tablesReferencingRequest) expect(sqls.some((s) => s.startsWith(`delete from "${t}"`)), t).toBe(true);
    // Request closed.
    const update = log.find((s) => /^update "fit_requests" set "status" = \$1/i.test(s.sql));
    expect(update?.params).toEqual(["deleted", REQ]);
    // Verification re-counts each table.
    expect(sqls.filter((s) => s.includes("count(")).length).toBe(5);
    expect(receipt.verified).toBe(true);
    expect(receipt.deleted.cacheEntries).toBe(2);
  });
});

describe("Drizzle variant columns (ADR-032, migration 0002)", () => {
  it("writes hearts.variant_id, metal_wishes and reads them back in lib/fit's row convention", async () => {
    const repos = new DrizzlePrivacyRepos(() => proxy);
    await repos.hearts.set(REQ, [{ catalogId: "c1", variantId: "c1:white_gold" }, "c2"]);
    const insert = log.find((s) => /^insert into "hearts"/i.test(s.sql))!;
    expect(insert.sql).toMatch(/"variant_id"/);
    expect(insert.params).toEqual(expect.arrayContaining([REQ, "c1", "c1:white_gold", "c2", null]));
    expect(log.some((s) => /^delete from "hearts"/i.test(s.sql))).toBe(true);
    await repos.wishes.add(REQ, "c3");
    const wish = log.find((s) => /^insert into "metal_wishes"/i.test(s.sql))!;
    expect(wish.params).toEqual(expect.arrayContaining([REQ, "c3"]));
    expect(wish.sql).toMatch(/on conflict do nothing/i);
  });

  it("writes fit_requests.metal_lock", async () => {
    const repos = new DrizzlePrivacyRepos(() => proxy);
    await repos.fitRequests
      .create({
        storeId: null,
        giverTokenHash: "g",
        recipientTokenHash: "r",
        occasion: null,
        budgetMin: null,
        budgetMax: 300,
        currency: "USD",
        shortlistIds: [],
        decoyIds: [],
        metalLock: ["yellow_gold"],
      })
      .catch(() => undefined); // the recorder returns no row; only the SQL matters here
    const insert = log.find((s) => /^insert into "fit_requests"/i.test(s.sql))!;
    expect(insert.sql).toMatch(/"metal_lock"/);
    expect(JSON.stringify(insert.params)).toContain("yellow_gold");
  });
});

describe("Drizzle photo_deleted_at (ADR-036, migration 0003)", () => {
  it("sets and clears fit_requests.photo_deleted_at", async () => {
    const repos = new DrizzlePrivacyRepos(() => proxy);
    const at = new Date("2026-10-21T00:00:00Z");
    await repos.fitRequests.setPhotoDeletedAt(REQ, at);
    await repos.fitRequests.setPhotoDeletedAt(REQ, null);
    const updates = log.filter((s) => /^update "fit_requests" set "photo_deleted_at"/i.test(s.sql));
    expect(updates).toHaveLength(2);
    expect(updates[0].params).toEqual([at.toISOString(), REQ]);
    expect(updates[1].params).toEqual([null, REQ]);
  });
});

/**
 * Lazy database access. Nothing connects at import time, so `next build` and unit
 * tests work without DATABASE_URL; getDb() throws only when a query is attempted.
 */
import { neon } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import * as schema from "./schema";

export { schema };
export type Db = NeonHttpDatabase<typeof schema>;

let db: Db | undefined;

export function hasDatabase(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.DATABASE_URL?.trim());
}

export function getDb(): Db {
  if (db) return db;
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("DATABASE_URL is not set; the database is unavailable (YouCam audit falls back to JSONL)");
  db = drizzle(neon(url), { schema });
  return db;
}

/** Test helper. */
export function resetDb(): void {
  db = undefined;
}

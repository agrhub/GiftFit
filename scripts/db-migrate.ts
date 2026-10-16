/**
 * Applies db/migrations to the database in DATABASE_URL (Neon).
 * Usage: npm run db:migrate
 */
import { loadEnvConfig } from "@next/env";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { migrate } from "drizzle-orm/neon-http/migrator";

loadEnvConfig(process.cwd());

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set (put it in .env.local).");
    process.exit(2);
  }
  await migrate(drizzle(neon(url)), { migrationsFolder: "db/migrations" });
  console.log("migrations applied");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

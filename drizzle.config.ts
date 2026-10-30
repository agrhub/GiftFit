import { defineConfig } from "drizzle-kit";

// `drizzle-kit generate` works offline; `migrate` needs DATABASE_URL (Neon).
export default defineConfig({
  dialect: "postgresql",
  schema: "./server/db/schema.ts",
  out: "./server/db/migrations",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://offline/unused" },
  strict: true,
  verbose: true,
});

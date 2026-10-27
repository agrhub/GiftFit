/**
 * Playwright end-to-end config (owner: A8). See docs/RUNBOOK.md.
 *
 * The suite runs against the production build (`next start`, so run `npm run build` or
 * `npm run gate` first) in hermetic mock mode:
 *   - YOUCAM_MOCK=1, YOUCAM_ALLOW_PAID=0: zero YouCam units, zero network to YouCam.
 *   - ANTHROPIC_API_KEY / VOYAGE_API_KEY / DATABASE_URL / BLOB_READ_WRITE_TOKEN forced empty, so
 *     no Claude call, no embeddings call, in-memory repositories and photo store, whatever
 *     .env.local contains (Next does not override variables already present in process.env).
 *   - Secrets that production requires are random per run (test values, never real ones).
 *
 * Projects:
 *   - `api`: route-level smoke (no browser needed).
 *   - `ui`:  browser flows (giver/recipient two-context gift flow, Delete everything); Pixel 7 by default,
 *            the giver context opts into a desktop viewport.
 */
import { randomBytes } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);
const baseURL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;

// Random per run; exported to the specs through process.env (the config is evaluated in the
// runner and in every worker, so keep the first value).
process.env.E2E_CRON_SECRET ??= randomBytes(24).toString("hex");
const signingSecret = (process.env.E2E_SIGNING_SECRET ??= randomBytes(32).toString("hex"));

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  timeout: 30_000,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "api", testMatch: "api/**/*.spec.ts" },
    { name: "ui", testMatch: "ui/**/*.spec.ts", use: { ...devices["Pixel 7"] } },
    // A6 script-tag plugin on a cross-origin host page (spec starts its own host server on :4310).
    { name: "plugin", testMatch: "plugin/**/*.spec.ts", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `npx next start -p ${PORT} -H 127.0.0.1`,
        url: `${baseURL}/api/fit/weights`,
        reuseExistingServer: false,
        timeout: 120_000,
        stdout: "ignore",
        stderr: "pipe",
        env: {
          YOUCAM_MOCK: "1",
          YOUCAM_ALLOW_PAID: "0",
          ANTHROPIC_API_KEY: "",
          VOYAGE_API_KEY: "",
          DATABASE_URL: "",
          BLOB_READ_WRITE_TOKEN: "",
          INGEST_FIXTURE: "1",
          // Voice (P8.3): canned transcript + tone WAV, never a Google call.
          VOICE_MOCK: "1",
          // P8.2b: the only storefront is the demo store; tests/e2e/plugin/site.spec.ts serves it here.
          GIFTFIT_DEMO_STORE_URL: "http://127.0.0.1:4340",
          // A6 (ADR-055): POST /api/preview/seed stores fixture previews (Bearer CRON_SECRET); never set in production.
          PREVIEW_FIXTURE_SEED: "1",
          GIFTFIT_URL_SIGNING_SECRET: signingSecret,
          CRON_SECRET: process.env.E2E_CRON_SECRET,
          FIT_DECOY_SECRET: randomBytes(32).toString("hex"),
          NEXT_TELEMETRY_DISABLED: "1",
        },
      },
});

import type { NextConfig } from "next";

/**
 * Build-time notes (A8, see docs/reports/A8.md):
 *
 * 1. Server-only dependencies are NOT bundled by webpack. At the P2 merge `next build` spent most of
 *    its compile time parsing drizzle-orm, zod, @anthropic-ai/sdk, undici (via @vercel/blob), cheerio
 *    and @opentelemetry into every route bundle. As externals they are `require`d from node_modules
 *    at runtime and Next's file tracing copies them into the deployment instead.
 *    playwright/playwright-core: Tier 3 ingest renderer (bundling it stalled the build, ADR-017).
 *    sharp: catalog image tooling (native module).
 *
 * 2. `npm run build:gate` (or `GIFTFIT_SKIP_BUILD_CHECKS=1`) skips the lint and type-check passes that
 *    `next build` runs on its own, because `npm run gate` has just run `npm run lint` and
 *    `npm run typecheck` as separate steps. A plain `next build` (Vercel, local) still runs both.
 *
 * 3. `output: "standalone"` (Cloud Run, docs/deploy.md): `next build` writes .next/standalone/server.js
 *    plus only the traced node_modules. It honours PORT and HOSTNAME. public/ and .next/static are
 *    copied next to it by the Dockerfile (Next does not copy them). Runtime-read files are listed in
 *    outputFileTracingIncludes below. Playwright and Chromium are excluded: Tier 3 live rendering is
 *    off in deployments (INGEST_FIXTURE=1 serves the snapshots and refuses live hosts).
 */
const SERVER_EXTERNALS = [
  "playwright",
  "playwright-core",
  "sharp",
  "@anthropic-ai/sdk",
  "@neondatabase/serverless",
  "@vercel/blob",
  "@vercel/oidc",
  "cheerio",
  "drizzle-orm",
  "fast-xml-parser",
  // GCP-native state (A11): Firestore + Cloud Storage via ADC; nodemailer for server/email.
  "@google-cloud/firestore",
  "@google-cloud/storage",
  // Voice (A13, ADR-052): Speech-to-Text V2 and Text-to-Speech via ADC (gRPC; loaded on first use).
  "@google-cloud/speech",
  "@google-cloud/text-to-speech",
  "nodemailer",
  "pgvector",
  "robots-parser",
  "standardwebhooks",
  "undici",
  "zod",
];

// `npm run build:gate` is detected through npm's lifecycle variable, so the gate needs no
// cross-platform env-setting helper (npm scripts run in cmd.exe on Windows).
const skipChecks = process.env.GIFTFIT_SKIP_BUILD_CHECKS === "1" || process.env.npm_lifecycle_event === "build:gate";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: SERVER_EXTERNALS,
  eslint: { ignoreDuringBuilds: skipChecks },
  typescript: { ignoreBuildErrors: skipChecks },
  // Framing policy (ADR-033): only the plugin's Giver Panel (/embed) may be framed by retailer
  // sites; every other page, above all the recipient flow, refuses framing (clickjacking).
  // GIFTFIT_EMBED_ANCESTORS narrows /embed to an allow-list, e.g. "https://shop.example".
  async headers() {
    const embedAncestors = process.env.GIFTFIT_EMBED_ANCESTORS?.trim() || "*";
    return [
      // /w (A6 widget frame) gets its frame-ancestors at request time in middleware.ts (GIFTFIT_WIDGET_ORIGINS).
      { source: "/((?!embed(?:/|$)|w(?:/|$)|s/[^/]+/snapshot(?:/|$)).*)", headers: [{ key: "Content-Security-Policy", value: "frame-ancestors 'self'" }, { key: "X-Frame-Options", value: "SAMEORIGIN" }] },
      // Store-page snapshots (A15): config headers win over a route's own, so the strict no-script policy
      // is set here too (same string as SNAPSHOT_CSP in server/preview/page-snapshot-http.ts; a test compares them).
      ...["/s/:key/snapshot", "/s/:key/snapshot/:path*"].map((source) => ({
        source,
        headers: [
          { key: "Content-Security-Policy", value: "default-src 'none'; img-src https: data:; style-src https: 'unsafe-inline'; font-src https: data:; frame-ancestors 'self'" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
        ],
      })),
      { source: "/embed/:path*", headers: [{ key: "Content-Security-Policy", value: `frame-ancestors ${embedAncestors}` }] },
      { source: "/embed", headers: [{ key: "Content-Security-Policy", value: `frame-ancestors ${embedAncestors}` }] },
      // Live2D (A20): Core, shaders and Mark-kun are pinned (SDK 5-r.5, sha256-checked model), so a day
      // of caching is safe. Next's default (max-age=0) made the widget frame revalidate all 22 files after
      // the landing's warm-up, and the Framework re-fetch its 13 shaders, one round trip per file.
      { source: "/live2d/:path*", headers: [{ key: "Cache-Control", value: "public, max-age=86400" }] },
    ];
  },
  // The seeded judge demo (ADR-038) reads committed AI-model fixtures from disk at runtime; make sure
  // file tracing ships them with the routes that serve them.
  // Other files read from disk at runtime: mock-mode YouCam fixtures, the ingest snapshots served in
  // INGEST_FIXTURE=1 mode, and the plugin script served by /giftfit.js.
  outputFileTracingIncludes: {
    "/api/demo/**": ["./fixtures/youcam/ai-demo/**/*"],
    "/api/recipient/**": ["./fixtures/youcam/ai-demo/**/*", "./fixtures/youcam/*.json", "./fixtures/youcam/images/**/*"],
    "/api/youcam/**": ["./fixtures/youcam/*.json", "./fixtures/youcam/images/**/*"],
    "/api/health": ["./fixtures/youcam/ai-demo/showcase/manifest.json"],
    "/api/ingest/**": ["./fixtures/ingest/**/*"],
    "/giftfit.js": ["./client/plugin/giftfit.js"],
  },
  // Local-only trees that file tracing must never walk into a deployment bundle.
  outputFileTracingExcludes: {
    "*": [
      ".agents/**",
      "agent/**",
      ".claude/**",
      ".venv/**",
      ".giftfit/**",
      // Root-level survey snapshots only ("*" does not cross "/"; fixtures/ingest/**/*.html stay).
      "*.html",
      "docs/**",
      "fixtures/aurum/photo-inbox/**",
      // Real recordings of a person's face stay local (ADR-025), never in an image.
      "fixtures/youcam/real/**",
      // No browser automation in deployments (Tier 3 live ingest is disabled there).
      "node_modules/playwright/**",
      "node_modules/playwright-core/**",
      "node_modules/@playwright/**",
    ],
  },
};

export default nextConfig;

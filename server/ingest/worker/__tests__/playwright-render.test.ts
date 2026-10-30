/**
 * Real-browser check of the Tier 3 renderer: serves the client-rendered fixture store on 127.0.0.1,
 * renders a listing page and a product page with headless Chromium through PlaywrightRenderer (polite
 * slots, images blocked), and checks the live render extracts exactly like the committed snapshot.
 * Skipped when no Chromium is installed (`npx playwright install chromium`).
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HeuristicExtractor } from "@/server/ingest/extract/heuristic";
import { PoliteFetcher } from "@/server/ingest/politeness";
import { PlaywrightRenderer, SnapshotRenderer } from "@/server/ingest/render";
import { serveDir } from "../static-server";

let hasChromium = false;
try {
  hasChromium = existsSync(chromium.executablePath());
} catch {
  hasChromium = false;
}

describe.skipIf(!hasChromium)("PlaywrightRenderer on the fixture store", () => {
  let server: Awaited<ReturnType<typeof serveDir>>;
  let renderer: PlaywrightRenderer;
  beforeAll(async () => {
    server = await serveDir(path.join(process.cwd(), "fixtures", "ingest", "aurum-sample", "site"));
    renderer = new PlaywrightRenderer(new PoliteFetcher({ maxPages: 10 }));
  }, 60_000);
  afterAll(async () => {
    await renderer?.close();
    await server?.close();
  }, 60_000);

  it(
    "renders client-side content that the server HTML does not contain, and matches the snapshot extraction",
    async () => {
      const slug = "halo-solitaire-ring";
      const logical = `https://aurum-fixture.test/products/${slug}`;
      const raw = await (await fetch(`${server.origin}/products/${slug}`)).text();
      expect(raw).not.toContain("<h1>");
      const live = await renderer.render(`${server.origin}/products/${slug}`, logical);
      expect(live.text).toContain("Halo Solitaire Ring");
      const ex = new HeuristicExtractor();
      const fromLive = await ex.extract(live);
      const fromSnapshot = await ex.extract(await new SnapshotRenderer().render(logical));
      expect(fromLive.product).toEqual(fromSnapshot.product);
      expect(fromLive.product.price).toBe(1250);

      const listing = await renderer.render(`${server.origin}/`, "https://aurum-fixture.test/");
      expect(listing.links).toContain("https://aurum-fixture.test/shop/page/2");
      expect(listing.links.filter((l) => l.includes("/products/")).length).toBeGreaterThanOrEqual(12);
    },
    120_000,
  );
});

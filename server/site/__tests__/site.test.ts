import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import rawCatalog from "@/fixtures/aurum/catalog.json";
import { GET as cartGET } from "@/app/(site)/cart/route";
import { GET as categoryGET } from "@/app/(site)/c/[category]/route";
import { GET as productGET } from "@/app/(site)/p/[id]/route";
import { GET as pluginDemoGET } from "@/app/(retailer)/plugin-demo/[id]/route";
import { DEFAULT_DEMO_STORE_URL, STORE_CATEGORY_SLUGS, demoStoreUrl, storeRedirectTarget, storeSlugFor } from "../config";
import { parseAcceptLanguage, siteLocale } from "../locale";

const STORE = DEFAULT_DEMO_STORE_URL;
const catalog = rawCatalog as unknown as Array<{ id: string; attributes: { sku: string; slug: string } }>;
const halo = catalog.find((s) => s.attributes.slug === "halo-drop-earrings")!;

describe("demo store URL", () => {
  it("defaults to the deployed demo store, accepts an origin override, ignores junk", () => {
    expect(demoStoreUrl({})).toBe("https://giftfit-demo-store-469920173665.us-central1.run.app");
    expect(demoStoreUrl({ GIFTFIT_DEMO_STORE_URL: "http://127.0.0.1:4340/some/path" })).toBe("http://127.0.0.1:4340");
    expect(demoStoreUrl({ GIFTFIT_DEMO_STORE_URL: "javascript:alert(1)" })).toBe(STORE);
    expect(demoStoreUrl({ GIFTFIT_DEMO_STORE_URL: "https://u:p@evil.example" })).toBe(STORE);
  });
});

describe("redirect map", () => {
  it("products by catalog id, slug or SKU go to the demo store page of that design", () => {
    for (const key of [halo.id, "halo-drop-earrings", "AUR-EAR-028", "aur-ear-028", encodeURIComponent("Halo-Drop-Earrings")]) {
      expect(storeRedirectTarget("product", key, {})).toBe(`${STORE}/p/halo-drop-earrings`);
    }
    expect(storeRedirectTarget("product", "not-a-design", {})).toBe(`${STORE}/`);
    expect(storeSlugFor("%E0%A4%A")).toBeUndefined();
  });

  it("categories keep their slug; unknown categories and the cart go home", () => {
    for (const c of STORE_CATEGORY_SLUGS) expect(storeRedirectTarget("category", c, {})).toBe(`${STORE}/c/${c}`);
    expect(storeRedirectTarget("category", "EARRINGS", {})).toBe(`${STORE}/c/earrings`);
    expect(storeRedirectTarget("category", "hats", {})).toBe(`${STORE}/`);
    expect(storeRedirectTarget("home", undefined, {})).toBe(`${STORE}/`);
  });

  it("the route handlers answer 308 with that Location", async () => {
    const p = await productGET(new Request("http://x/p/halo-drop-earrings"), { params: Promise.resolve({ id: "halo-drop-earrings" }) });
    expect(p.status).toBe(308);
    expect(p.headers.get("location")).toBe(`${demoStoreUrl()}/p/halo-drop-earrings`);
    const c = await categoryGET(new Request("http://x/c/rings"), { params: Promise.resolve({ category: "rings" }) });
    expect([c.status, c.headers.get("location")]).toEqual([308, `${demoStoreUrl()}/c/rings`]);
    const cart = cartGET();
    expect([cart.status, cart.headers.get("location")]).toEqual([308, `${demoStoreUrl()}/`]);
    const pd = await pluginDemoGET(new Request("http://x/plugin-demo/x"), { params: Promise.resolve({ id: halo.id }) });
    expect([pd.status, pd.headers.get("location")]).toEqual([308, `${demoStoreUrl()}/p/halo-drop-earrings`]);
  });
});

describe("demo store pages", () => {
  const PUBLIC = path.join(process.cwd(), "server", "demo-store", "public");
  it("has a page for every Aurum design and every category, so product redirects are exact", () => {
    for (const s of catalog) expect(existsSync(path.join(PUBLIC, "p", `${s.attributes.slug}.html`)), s.attributes.slug).toBe(true);
    for (const c of STORE_CATEGORY_SLUGS) expect(existsSync(path.join(PUBLIC, "c", `${c}.html`)), c).toBe(true);
    expect(existsSync(path.join(PUBLIC, "index.html"))).toBe(true);
  });

  it("generated pages are up to date with fixtures/aurum/catalog.json", async () => {
    const gen = (await import(/* @vite-ignore */ path.join(process.cwd(), "server", "demo-store", "generate.mjs"))) as {
      renderSite(): Map<string, string>;
      isHandWritten(file: string): boolean;
    };
    let checked = 0;
    for (const [rel, html] of gen.renderSite()) {
      const file = path.join(PUBLIC, rel);
      if (gen.isHandWritten(file)) continue;
      expect(readFileSync(file, "utf8"), `${rel} is stale: run node server/demo-store/generate.mjs`).toBe(html);
      checked++;
    }
    expect(checked).toBeGreaterThan(150);
  });

  it("every product page carries parseable JSON-LD with the catalog SKU and the snippet", () => {
    for (const s of catalog) {
      const html = readFileSync(path.join(PUBLIC, "p", `${s.attributes.slug}.html`), "utf8");
      const m = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
      const ld = JSON.parse(m![1]) as { "@type": string; sku: string; offers: { price?: string; priceCurrency: string } };
      expect(ld["@type"]).toBe("Product");
      expect(ld.sku).toBe(s.attributes.sku);
      expect(html).toContain('<script src="{{GIFTFIT_ORIGIN}}/giftfit.js"');
    }
  });
});

describe("site locale", () => {
  it("Accept-Language by q (Vietnamese or English), else English; no switcher", () => {
    expect(parseAcceptLanguage("fr;q=0.5, vi-VN,en;q=0.8, *;q=0.1")).toEqual(["vi-VN", "en", "fr"]);
    expect(siteLocale("en-US")).toBe("en");
    expect(siteLocale("vi-VN,vi;q=0.9")).toBe("vi");
    expect(siteLocale("fr-FR,de")).toBe("en");
    expect(siteLocale("ja-JP")).toBe("en");
    expect(siteLocale(null)).toBe("en");
  });
});

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { homeSignals } from "@/lib/ingest/detect";
import { createFixtureFetch, fixtureRelPath } from "@/lib/ingest/fixtures";
import { pageFromHtml } from "@/lib/ingest/html";
import { normaliseProduct } from "@/lib/ingest/normalise";
import { PoliteFetcher } from "@/lib/ingest/politeness";
import { ingestShopify, isShopifyCatalog, parseShopifyProduct, type ShopifyProduct } from "@/lib/ingest/tier1-shopify";
import { discoverFromSitemaps, isProductUrl, parseSitemap, productFromJsonLd, rawFromTier2 } from "@/lib/ingest/tier2-jsonld";

const FIX = path.join(process.cwd(), "fixtures", "ingest");
const read = (...p: string[]) => readFileSync(path.join(FIX, ...p), "utf8");
const fixtureFetcher = () => new PoliteFetcher({ fetch: createFixtureFetch(), sleep: async () => {} });

describe("fixture URL mapping", () => {
  it("maps paths and queries to files and refuses traversal", () => {
    expect(fixtureRelPath("https://a.test/")).toBe("index.html");
    expect(fixtureRelPath("https://a.test/products/x")).toBe("products/x.html");
    expect(fixtureRelPath("https://a.test/shop/page/2")).toBe("shop/page/2.html");
    expect(fixtureRelPath("https://a.test/products.json?limit=250&page=1")).toBe("products.q-limit=250_page=1.json");
    expect(fixtureRelPath("https://a.test/%2e%2e/secret")).not.toContain("..");
  });
});

describe("Tier 1: Shopify /products.json", () => {
  const SHOP = "https://shopify-fixture.test/";
  const products = (JSON.parse(read("shopify", "site", "products.q-limit=250_page=1.json")) as { products: ShopifyProduct[] }).products;

  it("splits a product with a Metal option into one SKU per canonical metal at that metal's lowest price", () => {
    const nova = parseShopifyProduct(products[1], SHOP, "USD");
    expect(nova.map((r) => [r.externalId, r.metal, r.price])).toEqual([
      ["9002:yellow_gold", "14k Yellow Gold", 899],
      ["9002:white_gold", "14k White Gold", 929],
      ["9002:platinum", "Platinum", 1199],
    ]);
    expect(nova[0].sourceUrl).toBe("https://shopify-fixture.test/products/nova-solitaire-ring?variant=90021");
  });

  it("maps key::value tags into canonical attributes and accepts comma-string tags", () => {
    const [stella] = parseShopifyProduct(products[0], SHOP, "USD");
    const s = normaliseProduct(stella);
    expect(s).toMatchObject({ category: "earring", price: 78, currency: "USD", complete: true });
    expect(s.attributes).toMatchObject({ metal: "yellow_gold", metal_tone: "warm", stone: "freshwater pearl", earring_shape: "stud_small", style: "classic" });
    expect(stella.description).toContain("freshwater pearl");
    const nova = parseShopifyProduct(products[1], SHOP, "USD");
    expect(nova[0].tags).toEqual(["stone::Lab-grown diamond", "anniversary"]);
  });

  it("ingests all pages through the polite fetcher with the currency from /meta.json", async () => {
    const fetcher = fixtureFetcher();
    expect(await isShopifyCatalog(fetcher, SHOP)).toBe(true);
    const raws = await ingestShopify(fetcher, SHOP);
    expect(raws).toHaveLength(6);
    expect(new Set(raws.map((r) => r.currency))).toEqual(new Set(["USD"]));
    const bar = normaliseProduct(raws.find((r) => r.externalId === "9003")!);
    expect(bar.attributes).toMatchObject({ category: "necklace", metal: "silver", necklace_length_in: 18 });
    const gift = normaliseProduct(raws.find((r) => r.externalId === "9004")!);
    expect(gift.complete).toBe(false);
    expect(gift.missing).toEqual(expect.arrayContaining(["category", "metal", "images"]));
  });
});

describe("Tier 2: sitemap + JSON-LD / Open Graph", () => {
  const BASE = "https://jsonld-fixture.test/";

  it("parses sitemap indexes and url sets", () => {
    const idx = parseSitemap(read("jsonld", "site", "sitemap_index.xml"));
    expect(idx.sitemaps).toHaveLength(3);
    expect(parseSitemap(read("jsonld", "site", "sitemap-products.xml")).urls).toHaveLength(4);
    expect(isProductUrl("https://x.test/products/a")).toBe(true);
    expect(isProductUrl("https://x.test/about")).toBe(false);
  });

  it("discovers product URLs from robots.txt sitemaps, skipping other hosts and robots-disallowed paths", async () => {
    const urls = await discoverFromSitemaps(fixtureFetcher(), BASE);
    expect(urls).toEqual([`${BASE}products/lyra-hoops`, `${BASE}products/cora-pendant`, `${BASE}products/rhea-bangle`]);
  });

  it("reads a schema.org Product from an @graph", () => {
    const page = pageFromHtml(read("jsonld", "site", "products", "lyra-hoops.html"), `${BASE}products/lyra-hoops`);
    expect(productFromJsonLd(page.jsonLd, page.url)).toMatchObject({
      title: "Lyra Hoops",
      price: 145,
      currency: "USD",
      metal: "14k Rose Gold",
      sku: "LY-01",
      brand: "Fixture JSON-LD Jewelry",
      images: [`${BASE}img/lyra-1.jpg`, `${BASE}img/lyra-2.jpg`],
    });
  });

  it("reads AggregateOffer prices with dot thousands and additionalProperty metal/length", () => {
    const raw = rawFromTier2(pageFromHtml(read("jsonld", "site", "products", "cora-pendant.html"), `${BASE}products/cora-pendant`))!;
    const s = normaliseProduct(raw);
    expect(s).toMatchObject({ price: 1_250_000, currency: "VND", category: "necklace" });
    expect(s.attributes).toMatchObject({ metal: "silver", necklace_length_in: 17.7, necklace_style: "pendant_curved" });
  });

  it("skips malformed JSON-LD and falls back to Open Graph product tags", () => {
    const raw = rawFromTier2(pageFromHtml(read("jsonld", "site", "products", "rhea-bangle.html"), `${BASE}products/rhea-bangle`))!;
    expect(raw).toMatchObject({ title: "Rhea Platinum Bangle", price: 640, currency: "GBP", externalId: "rhea-bangle" });
    expect(normaliseProduct(raw).attributes).toMatchObject({ category: "bracelet", metal: "platinum" });
  });
});

describe("platform detection signals", () => {
  const res = (body: string, headers: Record<string, string> = {}) => ({ body, headers, url: "https://x.test/" });
  it("recognises Shopify from headers or storefront markers", () => {
    expect(homeSignals(res(read("shopify", "site", "index.html"))).shopify).toBe(true);
    expect(homeSignals(res("<html></html>", { "x-shopid": "1" })).signals).toContain("header:x-shopid");
  });
  it("recognises a client-rendered store (empty app root + scripts)", () => {
    const s = homeSignals(res(read("aurum-sample", "site", "index.html")));
    expect(s).toMatchObject({ shopify: false, clientRendered: true });
  });
  it("does not call a server-rendered store client-rendered", () => {
    expect(homeSignals(res(read("jsonld", "site", "index.html"))).clientRendered).toBe(false);
  });
});

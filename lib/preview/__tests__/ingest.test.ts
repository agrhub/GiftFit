/**
 * Store-URL preview ingest (ADR-055) over self-authored fixture stores on `.test` hosts: Shopify,
 * WooCommerce Store API, sitemap + JSON-LD / Open Graph; refusal below 3 products; the 50-product cap;
 * robots, redirect and budget behaviour. No network: lib/preview/__tests__/fake-site.ts.
 */
import { describe, expect, it } from "vitest";
import { PREVIEW_FETCH_BUDGET } from "@/lib/ingest/safe-fetch";
import { getPreviewCatalog, previewProductToSku } from "../catalog";
import { ingestStoreUrl, MAX_PREVIEW_PRODUCTS, storeNameFromHtml } from "../ingest";
import { MemoryPreviewRepo, DEFAULT_PREVIEW_SETTINGS } from "../repo";
import { buildConciergeCatalog, searchCatalog } from "@/lib/concierge/catalog";
import { fakeNet, html, jsonLdPage, shopifyProducts } from "./fake-site";

const SHOP = "https://lumen-shop.test";
const shopifySite = (n: number) => ({
  [`${SHOP}/robots.txt`]: "User-agent: *\nDisallow: /cart\n",
  [`${SHOP}/`]: html('<meta property="og:site_name" content="Lumen Test Jewelry"><link rel="preconnect" href="https://cdn.shopify.com">', "<a href='/products/fixture-band-ring-1'>x</a>"),
  [`${SHOP}/products.json?limit=50`]: JSON.stringify({ products: shopifyProducts(n) }),
  [`${SHOP}/meta.json`]: JSON.stringify({ name: "Lumen (meta)", currency: "USD" }),
});

describe("Shopify /products.json", () => {
  it("ingests public products with name, currency, metal, category, images and links", async () => {
    const net = fakeNet(shopifySite(5));
    const r = await ingestStoreUrl(`${SHOP}/collections/all?utm=x`, { fetcherOptions: net.options });
    expect(r.outcome).toBe("ready");
    expect(r.platform).toBe("shopify");
    expect(r.domain).toBe("lumen-shop.test");
    expect(r.storeName).toBe("Lumen (meta)");
    expect(r.currency).toBe("USD");
    expect(r.products).toHaveLength(5);
    const ring = r.products[0];
    expect(ring).toMatchObject({
      id: "7001",
      title: "Fixture Band Ring 1",
      url: `${SHOP}/products/fixture-band-ring-1`,
      price: 101,
      currency: "USD",
      categoryText: "Rings",
      category: "ring",
      metal: "yellow_gold",
      style: "minimal",
      available: true,
    });
    expect(ring.images).toEqual(["https://cdn.shop-fixture.test/img/1.jpg?v=1"]); // http image dropped, URL kept as-is
    expect(ring.summary!.length).toBeLessThanOrEqual(160);
    expect(r.products[1].category).toBe("necklace");
    expect(net.hrefs()).toEqual([`${SHOP}/robots.txt`, `${SHOP}/`, `${SHOP}/products.json?limit=50`, `${SHOP}/meta.json`]);
    expect(r.fetches).toBe(4);
  });

  it(`caps a large store at ${MAX_PREVIEW_PRODUCTS} products`, async () => {
    const net = fakeNet(shopifySite(60));
    const r = await ingestStoreUrl(SHOP, { fetcherOptions: net.options });
    expect(r.outcome).toBe("ready");
    expect(r.products).toHaveLength(MAX_PREVIEW_PRODUCTS);
  });

  it("refuses with not_a_store when fewer than 3 products are found anywhere", async () => {
    const net = fakeNet(shopifySite(2));
    const r = await ingestStoreUrl(SHOP, { fetcherOptions: net.options });
    expect(r).toMatchObject({ outcome: "refused", reason: "not_a_store", products: [] });
  });
});

describe("WooCommerce Store API", () => {
  const WOO = "https://woo-fixture.test";
  const wooProducts = [1, 2, 3, 4].map((i) => ({
    id: 300 + i,
    name: `Test Hoop Earrings &#8211; No. ${i}`,
    permalink: `http://woo-fixture.test/product/test-hoop-${i}/`,
    sku: `WOO-${i}`,
    short_description: "<p>Sterling silver <em>classic</em> hoops.</p>",
    prices: { price: String(2500 + i), currency_code: "EUR", currency_minor_unit: 2 },
    images: [{ src: `https://woo-fixture.test/wp-content/uploads/${i}.jpg` }],
    categories: [{ name: "Earrings" }],
    tags: [{ name: "gift" }],
    is_in_stock: true,
    attributes: [{ name: "Material", terms: [{ name: "925 Sterling Silver" }] }],
  }));
  const site = {
    [`${WOO}/robots.txt`]: "User-agent: *\nDisallow: /wp-admin/\n",
    [`${WOO}/`]: html("<title>Woo Fixture Shop | Handmade</title>", '<div class="woocommerce wc-block-grid">shop</div>'),
    [`${WOO}/wp-json/wc/store/v1/products?per_page=50`]: JSON.stringify(wooProducts),
  };

  it("ingests from the Store API (minor-unit prices, https product links, stated material)", async () => {
    const net = fakeNet(site);
    const r = await ingestStoreUrl(WOO, { fetcherOptions: net.options });
    expect(r.outcome).toBe("ready");
    expect(r.platform).toBe("woocommerce");
    expect(r.storeName).toBe("Woo Fixture Shop");
    expect(r.products).toHaveLength(4);
    expect(r.products[0]).toMatchObject({
      id: "301",
      title: "Test Hoop Earrings – No. 1",
      url: "https://woo-fixture.test/product/test-hoop-1/",
      price: 25.01,
      currency: "EUR",
      category: "earring",
      metal: "silver",
      style: "classic",
    });
    expect(net.hrefs()).not.toContain(`${WOO}/products.json?limit=50`); // the home page said WooCommerce
  });
});

describe("sitemap + JSON-LD / Open Graph", () => {
  const LD = "https://ld-fixture.test";
  const pages: Record<string, string> = {};
  const names = ["Aster Ring", "Birch Pendant Necklace", "Cove Stud Earrings", "Dune Bangle Bracelet"];
  names.forEach((name, i) => {
    pages[`${LD}/products/item-${i}`] = jsonLdPage({ name, price: 40 + i, currency: "GBP", image: `/img/${i}.jpg`, sku: `LD-${i}`, material: i === 0 ? "14k Rose Gold" : undefined });
  });
  pages[`${LD}/products/og-only`] = html('<meta property="og:type" content="product"><meta property="og:title" content="Ember Chain Necklace"><meta property="product:price:amount" content="55.00"><meta property="product:price:currency" content="GBP"><meta property="og:image" content="https://ld-fixture.test/img/og.jpg">');
  pages[`${LD}/products/not-a-product`] = html("<title>About</title>");
  const sitemapIndex = `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${LD}/post-sitemap.xml</loc></sitemap><sitemap><loc>${LD}/product-sitemap.xml</loc></sitemap></sitemapindex>`;
  const productSitemap = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${[...Object.keys(pages), "https://elsewhere.test/products/x"].map((u) => `<url><loc>${u}</loc></url>`).join("")}</urlset>`;
  const site = {
    [`${LD}/robots.txt`]: `User-agent: *\nDisallow: /products/blocked\nSitemap: ${LD}/sitemap_index.xml\n`,
    [`${LD}/`]: html('<script type="application/ld+json">{"@type":"WebSite","name":"LD Fixture Atelier"}</script>'),
    [`${LD}/sitemap_index.xml`]: sitemapIndex,
    [`${LD}/product-sitemap.xml`]: productSitemap,
    [`${LD}/post-sitemap.xml`]: '<?xml version="1.0"?><urlset></urlset>',
    ...pages,
  };

  it("discovers product pages from robots.txt sitemaps and reads JSON-LD Product/Offer and Open Graph", async () => {
    const net = fakeNet(site);
    const r = await ingestStoreUrl(LD, { fetcherOptions: net.options });
    expect(r.outcome).toBe("ready");
    expect(r.platform).toBe("jsonld");
    expect(r.storeName).toBe("LD Fixture Atelier");
    expect(r.products.map((p) => p.title)).toEqual([...names, "Ember Chain Necklace"]);
    expect(r.products[0]).toMatchObject({ id: "LD-0", price: 40, currency: "GBP", category: "ring", metal: "rose_gold", images: [`${LD}/img/0.jpg`] });
    expect(r.products[4]).toMatchObject({ price: 55, category: "necklace", url: `${LD}/products/og-only` });
    expect(net.hrefs()).not.toContain(`${LD}/post-sitemap.xml`);
    expect(net.hrefs()).not.toContain("https://elsewhere.test/products/x");
    expect(r.fetches).toBeLessThanOrEqual(PREVIEW_FETCH_BUDGET);
  });

  it("stays within the 30-fetch budget on a store with many product pages", async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 80; i++) many[`${LD}/products/p-${i}`] = jsonLdPage({ name: `Budget Ring ${i}`, price: 10 + i, currency: "USD" });
    const sm = `<?xml version="1.0"?><urlset>${Object.keys(many).map((u) => `<url><loc>${u}</loc></url>`).join("")}</urlset>`;
    const net = fakeNet({ [`${LD}/robots.txt`]: "", [`${LD}/`]: html(""), [`${LD}/sitemap.xml`]: sm, ...many });
    const r = await ingestStoreUrl(LD, { fetcherOptions: net.options });
    expect(r.outcome).toBe("ready");
    expect(net.calls.length).toBe(PREVIEW_FETCH_BUDGET);
    expect(r.fetches).toBe(PREVIEW_FETCH_BUDGET);
    expect(r.products.length).toBeGreaterThanOrEqual(20);
  });
});

describe("refusals and failures", () => {
  it("refuses with robots_disallowed when robots.txt forbids everything", async () => {
    const net = fakeNet({ "https://closed.test/robots.txt": "User-agent: *\nDisallow: /\n" });
    const r = await ingestStoreUrl("https://closed.test/", { fetcherOptions: net.options });
    expect(r).toMatchObject({ outcome: "refused", reason: "robots_disallowed" });
    expect(net.hrefs()).toEqual(["https://closed.test/robots.txt"]);
  });

  it("refuses with site_blocked when the site answers 403 (bot protection) and stops asking", async () => {
    const net = fakeNet({ "https://guarded.test/robots.txt": "", "https://guarded.test/": { status: 403 } });
    const r = await ingestStoreUrl("https://guarded.test/", { fetcherOptions: net.options });
    expect(r).toMatchObject({ outcome: "refused", reason: "site_blocked" });
    expect(net.hrefs()).toEqual(["https://guarded.test/robots.txt", "https://guarded.test/"]);
  });

  it("fails with blocked_url when the home page redirects to a private address", async () => {
    const net = fakeNet(
      { "https://redir.test/robots.txt": "", "https://redir.test/": { status: 301, headers: { location: "https://inside.test/" } } },
      { "inside.test": ["10.0.0.8"] },
    );
    const r = await ingestStoreUrl("https://redir.test/", { fetcherOptions: net.options });
    expect(r).toMatchObject({ outcome: "failed", reason: "blocked_url", products: [] });
    expect(net.calls.every((c) => c.address !== "10.0.0.8")).toBe(true);
  });

  it("follows a same-site redirect (apex → www) and reports the final domain", async () => {
    const routes: Record<string, unknown> = { ...shopifySite(4) };
    const www = Object.fromEntries(Object.entries(routes).map(([k, v]) => [k.replace("lumen-shop.test", "www.lumen-shop.test"), v]));
    const net = fakeNet({ "https://lumen-shop.test/robots.txt": "", "https://lumen-shop.test/": { status: 301, headers: { location: "https://www.lumen-shop.test/" } }, ...(www as Record<string, string>) });
    const r = await ingestStoreUrl(SHOP, { fetcherOptions: net.options });
    expect(r.outcome).toBe("ready");
    expect(r.domain).toBe("www.lumen-shop.test");
    expect(r.products[0].url.startsWith("https://www.lumen-shop.test/products/")).toBe(true);
  });

  it("fails with unreachable when the host never answers", async () => {
    const net = fakeNet({ "https://down.test/robots.txt": { status: -1 }, "https://down.test/": { status: -1 } });
    const r = await ingestStoreUrl("https://down.test/", { fetcherOptions: net.options });
    expect(r).toMatchObject({ outcome: "failed", reason: "unreachable" });
  });

  it("refuses a site with pages but no products", async () => {
    const net = fakeNet({ "https://blog.test/robots.txt": "", "https://blog.test/": html("<title>Just a blog</title>") });
    const r = await ingestStoreUrl("https://blog.test/", { fetcherOptions: net.options });
    expect(r).toMatchObject({ outcome: "refused", reason: "not_a_store", storeName: "Just a blog" });
  });
});

describe("store name", () => {
  it("prefers og:site_name, then application-name, JSON-LD, then the title's first segment", () => {
    expect(storeNameFromHtml(html('<meta property="og:site_name" content="A &amp; B"><title>X | Y</title>'))).toBe("A & B");
    expect(storeNameFromHtml(html('<meta name="application-name" content="App Name">'))).toBe("App Name");
    expect(storeNameFromHtml(html("<title>Shop Name – Fine things</title>"))).toBe("Shop Name");
    expect(storeNameFromHtml(html(""))).toBeNull();
  });
});

describe("getPreviewCatalog shape (Concierge-compatible)", () => {
  it("returns every product plus the CatalogSku subset that buildConciergeCatalog/searchCatalog accept", async () => {
    const net = fakeNet(shopifySite(6));
    const r = await ingestStoreUrl(SHOP, { fetcherOptions: net.options });
    const repo = new MemoryPreviewRepo();
    const now = Date.now();
    await repo.create({
      key: "AAAAAAAAAAAAAAAAAAAAAA",
      domain: r.domain,
      storeUrl: r.origin,
      state: "ready",
      reason: null,
      storeName: r.storeName,
      platform: r.platform,
      currency: r.currency,
      products: r.products,
      productCount: r.products.length,
      fetches: r.fetches,
      createdAt: new Date(now),
      updatedAt: new Date(now),
      expiresAt: new Date(now + 60_000),
      ownerTokenHash: "0".repeat(64),
      runner: "x",
      settings: { ...DEFAULT_PREVIEW_SETTINGS, removedProductIds: ["7006"] },
    });
    const c = await getPreviewCatalog("AAAAAAAAAAAAAAAAAAAAAA", repo);
    expect(c).not.toBeNull();
    expect(c!.products).toHaveLength(5); // the owner removed one
    expect(c!.skus).toHaveLength(5);
    const sku = c!.skus[0];
    expect(sku).toMatchObject({ storeId: "preview:lumen-shop.test", category: "ring", price: 101, currency: "USD", sourceUrl: `${SHOP}/products/fixture-band-ring-1` });
    expect(sku.attributes).toMatchObject({ metal: "yellow_gold", metal_tone: "warm", vto_spec_ok: false, vto_image: "", occasions: [] });
    const concierge = buildConciergeCatalog(c!.skus);
    expect(searchCatalog(concierge, { category: ["ring"], maxPrice: 200 }).rows.length).toBeGreaterThan(0);
    // Non-jewelry or metal-less products stay out of `skus` (nothing is invented).
    expect(previewProductToSku({ ...r.products[0], category: null }, "x.test", 0)).toBeNull();
    expect(previewProductToSku({ ...r.products[0], metal: null }, "x.test", 0)).toBeNull();
    expect(await getPreviewCatalog("AAAAAAAAAAAAAAAAAAAAAA", repo, now + 120_000)).toBeNull(); // expired
  });
});

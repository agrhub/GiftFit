/**
 * "In this preview · GiftFit" strip (A19): a captured home page whose links reach none of the ingested
 * products (carousels built by script) gets one GiftFit-labelled strip of those products; category
 * collection links jump to it; pages with product links get none. Fictional "Example Jewelry" fixtures.
 */
import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import { describe, expect, it } from "vitest";
import { capturePageSnapshot, snapshotLinkMapper, snapshotProductPath, withPreviewStrip } from "../page-snapshot";
import { serveSnapshotHome, SNAPSHOT_CSP } from "../page-snapshot-http";
import { isDangerousCss, sanitizeSnapshotHtml } from "../page-snapshot-sanitize";
import { HOME_PAGE_ID, MemoryPageSnapshotStore, productPageId } from "../page-snapshot-store";
import { collectionCategory, insertPreviewStrip, localizePreviewStrip, MAX_STRIP_PRODUCTS, PREVIEW_STRIP_ID, previewStripHtml, STRIP_CSS, STRIP_TEXT } from "../page-snapshot-strip";
import { DEFAULT_PREVIEW_SETTINGS, MemoryPreviewRepo, type PreviewRecord } from "../repo";
import type { PreviewProduct } from "../types";
import { fakeNet, html } from "./fake-site";

const ORIGIN = "https://shop.example.com";
const KEY = "ExJwLrYStRiP0123456789";
const PREFIX = `/s/${KEY}/snapshot`;
const ANCHOR = `${PREFIX}#${PREVIEW_STRIP_ID}`;
const T0 = Math.floor(Date.now() / 1000) * 1000;
const EXPIRES = new Date(T0 + 3_600_000);

function product(id: string, title: string, category: PreviewProduct["category"], over: Partial<PreviewProduct> = {}): PreviewProduct {
  return {
    id,
    title,
    url: `${ORIGIN}/products/${id}`,
    images: [`https://cdn.example.com/${id}.jpg`],
    price: 120,
    currency: "USD",
    categoryText: category ?? "Gift card",
    category,
    metal: null,
    style: null,
    tags: [],
    summary: null,
    available: true,
    ...over,
  };
}

const PRODUCTS = [
  product("aria-hoops", "Aria Gold Hoops", "earring", { price: 180 }),
  product("luna-studs", "Luna Pearl Studs", "earring", { price: 95.5, currency: "EUR" }),
  product("band-ring", "Band Ring", "ring"),
  product("tide-cuff", "Tide Cuff", "bracelet", { images: ["http://cdn.example.com/insecure.jpg"] }),
];
const TEXT = "Example Jewelry makes fine pieces by hand in small batches, with recycled gold and lab-grown stones. ".repeat(4);

/** A home page whose product carousels are built by script: only collection and page links. */
const homeOnlyCollections = html(
  `<title>Example Jewelry</title><script src="https://cdn.example.com/carousel.js"></script><style>main img{width:50%!important}a{color:red}</style>`,
  `<header class="site-header"><a id="logo" href="/">Example Jewelry</a><nav>
     <a id="c-ear" href="/collections/earrings">Earrings</a><a id="c-ring" href="/en-us/collections/Rings/?sort=new">Rings</a>
     <a id="c-neck" href="/collections/necklaces">Necklaces</a><a id="c-watch" href="/collections/watches">Watches</a>
     <a id="c-sale" href="/collections/sale">Sale</a><a id="c-ring-product" href="/collections/rings/products/not-ingested">A ring</a><a id="about" href="/pages/about">About</a></nav></header>
   <main id="MainContent"><section class="hero"><h1>Example Jewelry</h1><p>${TEXT}</p>
     <img src="https://cdn.example.com/hero-1.jpg"><img src="https://cdn.example.com/hero-2.jpg"><img src="https://cdn.example.com/hero-3.jpg"></section>
     <div class="product-carousel" data-collection="best-sellers" onclick="go()"></div></main>`,
);

const net = (home: string) =>
  fakeNet({
    [`${ORIGIN}/robots.txt`]: "User-agent: *\nAllow: /\n",
    [`${ORIGIN}/`]: home,
    ...Object.fromEntries(PRODUCTS.map((p) => [p.url, html(`<title>${p.title}</title>`, `<main><h1>${p.title}</h1><img src="/${p.id}.jpg"><p>${TEXT}</p><a href="/collections/earrings">Earrings</a></main>`)])),
  });

async function capture(home: string, store = new MemoryPageSnapshotStore()) {
  const info = await capturePageSnapshot({ key: KEY, origin: ORIGIN, products: PRODUCTS, expiresAt: EXPIRES }, { fetcherOptions: net(home).options, store, env: {}, now: () => T0 });
  return { info, store, home: (await store.get(KEY, HOME_PAGE_ID, T0))?.html ?? "" };
}

const attrs = (el: unknown) => (el as Element).attribs;

describe("home page without product links", () => {
  it("gets one GiftFit-labelled strip at the top of <main>, linking each ingested product to its preview page", async () => {
    const { info, home } = await capture(homeOnlyCollections);
    expect(info.mode).toBe("snapshot");
    const $ = cheerio.load(home);
    const strip = $(`#${PREVIEW_STRIP_ID}`);
    expect(strip.length).toBe(1);
    expect(strip.parent().is("main#MainContent")).toBe(true);
    expect(strip.prev().length).toBe(0); // first in <main>
    expect(strip.attr("aria-label")).toBe("In this preview · GiftFit");
    expect(strip.find(".gfpv-head").text()).toBe("In this preview·GiftFit");
    expect(strip.find(".gfpv-brand").text()).toBe("GiftFit");

    // Categories in turn: earring, ring, bracelet, then the second earring.
    const order = [PRODUCTS[0], PRODUCTS[2], PRODUCTS[3], PRODUCTS[1]];
    const cards = strip.find("a.gfpv-card").toArray().map(attrs);
    expect(cards.map((a) => a.href)).toEqual(order.map((p) => `${PREFIX}/p/${p.id}`));
    for (const a of cards) expect(a.target).toBeUndefined();
    expect(strip.find(".gfpv-title").map((_, e) => $(e).text()).get()).toEqual(order.map((p) => p.title));
    expect(strip.find(".gfpv-price").map((_, e) => $(e).text()).get()).toEqual(["$180.00", "$120.00", "$120.00", "€95.50"]);
    // https images only, as published (the http one is not upgraded into the strip)
    expect(strip.find("img").map((_, e) => attrs(e).src).get()).toEqual(["https://cdn.example.com/aria-hoops.jpg", "https://cdn.example.com/band-ring.jpg", "https://cdn.example.com/luna-studs.jpg"]);
    expect(strip.find('a[data-giftfit-product="tide-cuff"] .gfpv-media').children().length).toBe(0);
  });

  it("points collection links naming an ingested category to the strip; other links keep today's behaviour", async () => {
    const $ = cheerio.load((await capture(homeOnlyCollections)).home);
    expect($("#c-ear").attr("href")).toBe(ANCHOR);
    expect($("#c-ring").attr("href")).toBe(ANCHOR);
    for (const id of ["c-ear", "c-ring"]) expect($(`#${id}`).attr("target")).toBeUndefined();
    // necklaces and watches were not ingested; sale is no category; a non-ingested product; a page
    for (const id of ["c-neck", "c-watch", "c-sale", "c-ring-product", "about"]) {
      expect($(`#${id}`).attr("target"), id).toBe("_blank");
      expect($(`#${id}`).attr("href"), id).toMatch(/^https:\/\/shop\.example\.com\//);
    }
    expect($("#logo").attr("href")).toBe(PREFIX);
  });

  it("is a fixpoint of the sanitizer, with no script, handler or unsafe URL, and the store's CSS can't reach it", async () => {
    const { home } = await capture(homeOnlyCollections);
    const linkFor = snapshotLinkMapper(KEY, `${ORIGIN}/`, PRODUCTS, undefined, new Set(["earring", "ring", "bracelet"] as const));
    expect(sanitizeSnapshotHtml(home, { pageUrl: `${ORIGIN}/`, linkFor, internalPrefix: PREFIX, internalAnchor: PREVIEW_STRIP_ID }).html).toBe(home);
    expect(home).not.toMatch(/<script|\son[a-z]+=|javascript:|http:\/\//i);
    const $ = cheerio.load(home);
    const css = $(`#${PREVIEW_STRIP_ID} > style`).text();
    expect(css).toBe(STRIP_CSS);
    expect(isDangerousCss(STRIP_CSS)).toBe(false);
    // Every rule is scoped to the strip and starts from a reset.
    for (const rule of STRIP_CSS.replace(/@media[^{]+\{/, "").split("\n")) expect(rule.trim().startsWith(`#${PREVIEW_STRIP_ID}`), rule).toBe(true);
    expect(STRIP_CSS).toContain(`#${PREVIEW_STRIP_ID},#${PREVIEW_STRIP_ID} *{all:revert;box-sizing:border-box}`);
  });

  it("is judged without the strip: a script-built shell still falls back to the template", async () => {
    const shell = html(`<title>Shop</title><script src="/app.js"></script>`, `<header><a href="/collections/rings">Rings</a></header><main><div id="root"></div></main>`);
    expect((await capture(shell)).info).toMatchObject({ mode: "template", reason: "too_little_text" });
  });
});

describe("pages that need no strip", () => {
  it("a home page with links to ingested products, and every product page", async () => {
    const withLinks = homeOnlyCollections.replace(`<div class="product-carousel"`, `<a id="p" href="/collections/all/products/band-ring?variant=1">Band Ring</a><div class="product-carousel"`);
    const { home, store } = await capture(withLinks);
    const $ = cheerio.load(home);
    expect($(`#${PREVIEW_STRIP_ID}, .gfpv-card`).length).toBe(0);
    expect($("#p").attr("href")).toBe(`${PREFIX}/p/band-ring`);
    expect($("#c-ear").attr("target")).toBe("_blank"); // no strip, so no jump
    const pdp = (await store.get(KEY, productPageId("band-ring"), T0))!.html;
    expect(pdp).not.toContain(PREVIEW_STRIP_ID);
    expect(cheerio.load(pdp)('a[href*="collections/earrings"]').attr("target")).toBe("_blank");
  });
});

describe("strip markup", () => {
  it("clamps long titles (German, Japanese) and escapes them; never more than MAX_STRIP_PRODUCTS, jewelry first", () => {
    const de = "Ohrhänger „Morgentau“ aus recyceltem 18-Karat-Gelbgold mit handgefassten Süßwasserperlen und Diamantpavé, Länge verstellbar, Geschenkverpackung inklusive";
    const ja = "ゴールドフープピアス・淡水パール・ダイヤモンドパヴェ・十八金イエローゴールド・長さ調節可能・ギフトボックス付き・ハンドメイド・日本製・ゴールドフープピアス・淡水パール・ダイヤモンドパヴェ";
    const many = [
      product("gift-card", "Gift <card>", null),
      product("de", de, "earring"),
      product("ja", ja, "earring"),
      ...Array.from({ length: 10 }, (_, i) => product(`r${i}`, `Ring ${i}`, "ring")),
    ];
    const stripHtml = previewStripHtml(many, (id) => snapshotProductPath(KEY, id))!;
    const $ = cheerio.load(stripHtml);
    expect($(".gfpv-card").length).toBe(MAX_STRIP_PRODUCTS);
    expect($(".gfpv-card").first().attr("data-giftfit-product")).toBe("de");
    expect($('[data-giftfit-product="gift-card"]').length).toBe(0); // non-jewelry comes last, cut here
    const titles = $(".gfpv-title").map((_, e) => $(e).text()).get();
    expect(titles[0].length).toBe(120);
    expect(titles[0].endsWith("…")).toBe(true);
    expect(titles[1].length).toBeLessThanOrEqual(120);
    expect(STRIP_CSS).toMatch(/\.gfpv-title\{[^}]*-webkit-line-clamp:2;line-clamp:2;max-height:2\.6em;overflow:hidden;overflow-wrap:anywhere;word-break:break-word/);
    expect(STRIP_CSS).toMatch(/\.gfpv-card\{[^}]*flex:0 0 136px;[^}]*width:136px;min-width:0/);
    expect(STRIP_CSS).toMatch(/\.gfpv-row\{[^}]*overflow-x:auto/);
    expect(previewStripHtml([product("x", "Gift <card>", null)], (id) => id)).toContain("Gift &lt;card&gt;");
    expect(previewStripHtml([], (id) => id)).toBeNull();
  });

  it("goes after the first <header> without a <main>, else at the top of <body>; never inside <template>/<noscript>", () => {
    const strip = `<section id="${PREVIEW_STRIP_ID}"></section>`;
    const at = (body: string) => cheerio.load(insertPreviewStrip(html("", body), strip)!)(`#${PREVIEW_STRIP_ID}`);
    expect(at(`<header id="h">H</header><div>x</div>`).prev().attr("id")).toBe("h");
    expect(at(`<div id="d">x</div>`).parent().is("body")).toBe(true);
    expect(at(`<template><main></main></template><div role="main" id="m"></div>`).parent().attr("id")).toBe("m");
  });

  it("withPreviewStrip keeps the store's own markup and adds the strip once", () => {
    const page = sanitizeSnapshotHtml(homeOnlyCollections, { pageUrl: `${ORIGIN}/`, internalPrefix: PREFIX });
    const once = withPreviewStrip(page.html, `${ORIGIN}/`, KEY, PRODUCTS)!;
    expect(cheerio.load(once.html)(`#${PREVIEW_STRIP_ID}`).length).toBe(1);
    expect(once.html).toContain("Example Jewelry makes fine pieces");
    expect(once.textChars).toBeGreaterThan(page.textChars);
  });
});

describe("collectionCategory", () => {
  it.each([
    ["/collections/earrings", "earring"],
    ["/en-us/collections/gold-earrings", "earring"],
    ["/collections/necklaces", "necklace"],
    ["/collections/rings", "ring"],
    ["/collections/bracelets", "bracelet"],
    ["/collections/watches", "watch"],
    ["/de/collections/ohrringe", "earring"],
    ["/de/collections/armbänder", "bracelet"],
    ["/fr/collections/boucles-d-oreilles", "earring"],
    ["/es/collections/anillos", "ring"],
    ["/product-category/vong-tay", "bracelet"],
    ["/ja/collections/ピアス", "earring"],
    ["/collections/sale", null],
    ["/collections/earrings/products/aria-hoops", null],
    ["/pages/rings", null],
    ["/collections/springs", null],
  ])("%s → %s", (path, cat) => {
    expect(collectionCategory(path)).toBe(cat);
  });
});

describe("serving", () => {
  it("drops the strip cards of products the owner removed after the capture (and an emptied strip)", async () => {
    const { info, store } = await capture(homeOnlyCollections);
    const repo = new MemoryPreviewRepo();
    const rec: PreviewRecord = {
      key: KEY,
      domain: "shop.example.com",
      storeUrl: ORIGIN,
      state: "ready",
      reason: null,
      storeName: "Example Jewelry",
      platform: "shopify",
      currency: "USD",
      products: PRODUCTS,
      productCount: PRODUCTS.length,
      fetches: 6,
      createdAt: new Date(T0),
      updatedAt: new Date(T0),
      expiresAt: EXPIRES,
      ownerTokenHash: "0".repeat(64),
      runner: null,
      settings: { ...DEFAULT_PREVIEW_SETTINGS, removedProductIds: ["band-ring"] },
      snapshot: info,
    };
    await repo.create(rec);
    const $ = cheerio.load(await (await serveSnapshotHome(KEY, { repo, store, nowMs: T0 })).text());
    expect($(".gfpv-card").map((_, e) => attrs(e)["data-giftfit-product"]).get()).toEqual(["aria-hoops", "tide-cuff", "luna-studs"]);
    await repo.update(KEY, { settings: { version: 0, removedProductIds: PRODUCTS.map((p) => p.id) } });
    const body = await (await serveSnapshotHome(KEY, { repo, store, nowMs: T0 })).text();
    expect(cheerio.load(body)(`#${PREVIEW_STRIP_ID}, .gfpv-card`).length).toBe(0);
    expect(body).toContain("Example Jewelry makes fine pieces");
  });
});

describe("strip language (A26)", () => {
  async function served(acceptLanguage: string | null | undefined, rewrite?: (html: string) => string) {
    const { info, store } = await capture(homeOnlyCollections);
    if (rewrite) {
      const page = (await store.get(KEY, HOME_PAGE_ID, T0))!;
      await store.put({ ...page, html: rewrite(page.html) });
    }
    const repo = new MemoryPreviewRepo();
    await repo.create({
      key: KEY, domain: "shop.example.com", storeUrl: ORIGIN, state: "ready", reason: null, storeName: "Example Jewelry", platform: "shopify", currency: "USD",
      products: PRODUCTS, productCount: PRODUCTS.length, fetches: 6, createdAt: new Date(T0), updatedAt: new Date(T0), expiresAt: EXPIRES,
      ownerTokenHash: "0".repeat(64), runner: null, settings: { ...DEFAULT_PREVIEW_SETTINGS }, snapshot: info,
    });
    const res = await serveSnapshotHome(KEY, { repo, store, nowMs: T0, acceptLanguage });
    return { res, body: await res.text() };
  }
  const stripOf = (body: string) => cheerio.load(body)(`#${PREVIEW_STRIP_ID}`);

  it("is stored in English, with lang and every word in the catalog", async () => {
    const strip = cheerio.load((await capture(homeOnlyCollections)).home)(`#${PREVIEW_STRIP_ID}`);
    expect(strip.attr("lang")).toBe("en");
    expect(strip.find(".gfpv-label").text()).toBe(STRIP_TEXT.en.label);
    expect(strip.find(".gfpv-note").text()).toBe(STRIP_TEXT.en.note);
    for (const [locale, text] of Object.entries(STRIP_TEXT)) {
      expect(text.note, locale).toContain("GiftFit");
      if (locale !== "en") expect([text.label, text.note], locale).not.toContain(STRIP_TEXT.en.label);
    }
  });

  it.each<[string | null | undefined, keyof typeof STRIP_TEXT]>([
    ["ja-JP,ja;q=0.9,en;q=0.8", "ja"],
    ["de", "de"],
    ["pt-BR,pt;q=0.9", "en"],
    [undefined, "en"],
    ["pt-BR, fr;q=0.4, de;q=0.7", "de"], // q order, first of the ten
  ])("is served in the viewer's language: Accept-Language %s → %s", async (acceptLanguage, locale) => {
    const { res, body } = await served(acceptLanguage);
    const strip = stripOf(body);
    expect(strip.attr("lang")).toBe(locale);
    expect(strip.attr("aria-label")).toBe(`${STRIP_TEXT[locale].label} · GiftFit`);
    expect(strip.find(".gfpv-label").text()).toBe(STRIP_TEXT[locale].label);
    expect(strip.find(".gfpv-note").text()).toBe(STRIP_TEXT[locale].note);
    expect(strip.find(".gfpv-brand").text()).toBe("GiftFit");
    if (locale !== "en") expect(body).not.toMatch(/In this preview|Pieces GiftFit found/);
    expect(res.headers.get("vary")).toBe("Accept-Language");
    expect(res.headers.get("content-security-policy")).toBe(SNAPSHOT_CSP);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(body).toContain("Example Jewelry makes fine pieces");
  });

  it("stays a fixpoint of the sanitizer once localized", async () => {
    const linkFor = snapshotLinkMapper(KEY, `${ORIGIN}/`, PRODUCTS, undefined, new Set(["earring", "ring", "bracelet"] as const));
    for (const al of ["ja", "de", "th", "fr"]) {
      const { body } = await served(al);
      expect(sanitizeSnapshotHtml(body, { pageUrl: `${ORIGIN}/`, linkFor, internalPrefix: PREFIX, internalAnchor: PREVIEW_STRIP_ID }).html, al).toBe(body);
      expect(body).not.toMatch(/<script|\son[a-z]+=|javascript:|http:\/\//i);
    }
  });

  it("localizes a strip stored before A26 (English, no lang)", async () => {
    const old = (html: string) => {
      const out = html.replace(` lang="en" aria-label=`, " aria-label=");
      expect(out).not.toBe(html);
      expect(out).toContain('aria-label="In this preview · GiftFit"><style>');
      expect(out).toContain('<span class="gfpv-label">In this preview</span>');
      expect(out).toContain('<p class="gfpv-note">Pieces GiftFit found on this store. Open one to see it in the preview.</p>');
      return out;
    };
    const strip = stripOf((await served("ja-JP", old)).body);
    expect(strip.attr("lang")).toBe("ja");
    expect(strip.attr("aria-label")).toBe(`${STRIP_TEXT.ja.label} · GiftFit`);
    expect(strip.find(".gfpv-label").text()).toBe(STRIP_TEXT.ja.label);
    expect(strip.find(".gfpv-note").text()).toBe(STRIP_TEXT.ja.note);
  });

  it("leaves a page without the strip, and look-alike store markup, alone", () => {
    const page = `<!DOCTYPE html><html><head></head><body><div id="${PREVIEW_STRIP_ID}"><span class="gfpv-label">In this preview</span></div></body></html>`;
    expect(localizePreviewStrip(page, "de")).toBe(page);
    expect(localizePreviewStrip("<!DOCTYPE html><html><head></head><body><p>x</p></body></html>", "ja")).toBe("<!DOCTYPE html><html><head></head><body><p>x</p></body></html>");
  });
});

/**
 * Store-page snapshots (A19): lazy-loaded and script-built images are filled statically (no script runs),
 * <noscript> fallbacks fill their scripted image, every candidate URL passes the resource rules, and
 * product links on the HOME page lead to the preview's own product pages. Fixtures are a fictional store
 * ("Example Jewelry" on example.com hosts).
 */
import * as cheerio from "cheerio";
import { describe, expect, it } from "vitest";
import { capturePageSnapshot, snapshotLinkMapper, snapshotProductPath } from "../page-snapshot";
import { isPlaceholderSrc, LINK_REL, sanitizeSnapshotHtml } from "../page-snapshot-sanitize";
import { HOME_PAGE_ID, MemoryPageSnapshotStore } from "../page-snapshot-store";
import type { PreviewProduct } from "../types";
import { fakeNet, html } from "./fake-site";

const PAGE = "https://shop.example.com/";
const KEY = "ExJwLrYKeY0123456789ab";
const PREFIX = `/s/${KEY}/snapshot`;
const GIF = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

const sanitize = (body: string, head = "") => {
  const r = sanitizeSnapshotHtml(`<!doctype html><html><head>${head}</head><body>${body}</body></html>`, { pageUrl: PAGE, internalPrefix: PREFIX });
  // Always a fixpoint: re-sanitizing the output changes nothing.
  expect(sanitizeSnapshotHtml(r.html, { pageUrl: PAGE, internalPrefix: PREFIX }).html).toBe(r.html);
  return r;
};
const $of = (body: string, head = "") => cheerio.load(sanitize(body, head).html);

/** Every URL in the output is https (or an allowed data: image); never http, javascript: or data:text. */
function expectOnlyHttps(out: string): void {
  expect(out).not.toMatch(/javascript:|vbscript:|data:text|http:\/\//i);
  const $ = cheerio.load(out);
  $("[src], [srcset]").each((_, el) => {
    const a = (el as unknown as { attribs: Record<string, string> }).attribs;
    if (a.src) expect(a.src).toMatch(/^(https:\/\/|data:image\/)/);
    if (a.srcset) for (const c of a.srcset.split(/,\s+/)) expect(c.split(/\s+/)[0]).toMatch(/^(https:\/\/|data:image\/)/);
  });
}

describe("lazy-loaded images", () => {
  it.each([
    ["data-src", `<img data-src="/img/ring.jpg">`],
    ["data-lazy-src", `<img src="${GIF}" data-lazy-src="/img/ring.jpg">`],
    ["data-original", `<img src="/assets/blank.gif" data-original="/img/ring.jpg">`],
    ["data-lazy", `<img src="" data-lazy="/img/ring.jpg">`],
    ["placeholder path", `<img src="https://cdn.example.com/theme/placeholder-image.svg" data-src="/img/ring.jpg">`],
    ["spacer", `<img src="/spacer.gif" data-src="/img/ring.jpg">`],
  ])("%s → src", (_n, markup) => {
    const $ = $of(markup);
    expect($("img").attr("src")).toBe("https://shop.example.com/img/ring.jpg");
  });

  it("fills Shopify-style {width} templates (also percent-encoded) with 800", () => {
    const $ = $of(`<img class="lazyload" data-src="//cdn.example.com/files/aria_{width}x.jpg?v=1" data-widths="[180,360,540]"><img data-src="//cdn.example.com/files/solo_%7Bwidth%7Dx.jpg">`);
    expect($("img").eq(0).attr("src")).toBe("https://cdn.example.com/files/aria_800x.jpg?v=1");
    expect($("img").eq(1).attr("src")).toBe("https://cdn.example.com/files/solo_800x.jpg");
  });

  it("data-srcset / data-lazy-srcset → srcset, and a placeholder-only srcset is replaced", () => {
    const $ = $of(
      `<img id="a" data-srcset="/a-400.jpg 400w, /a-800.jpg 800w" data-sizes="auto"><img id="b" srcset="${GIF} 1x" data-lazy-srcset="/b.jpg 1x, /b@2x.jpg 2x"><img id="c" src="/c.jpg" srcset="/blank.gif 1x">`,
    );
    expect($("#a").attr("srcset")).toBe("https://shop.example.com/a-400.jpg 400w, https://shop.example.com/a-800.jpg 800w");
    expect($("#b").attr("srcset")).toBe("https://shop.example.com/b.jpg 1x, https://shop.example.com/b@2x.jpg 2x");
    // A placeholder srcset would win over the real src: removed.
    expect($("#c").attr("srcset")).toBeUndefined();
    expect($("#c").attr("src")).toBe("https://shop.example.com/c.jpg");
  });

  it("<picture><source data-srcset> → srcset", () => {
    const $ = $of(`<picture><source type="image/webp" data-srcset="/p.webp 1x, /p@2x.webp 2x"><source media="(min-width: 800px)" data-src="/wide.jpg"><img class="lazyload" src="${GIF}" data-src="/p.jpg" alt="Pendant"></picture>`);
    expect($("source").eq(0).attr("srcset")).toBe("https://shop.example.com/p.webp 1x, https://shop.example.com/p@2x.webp 2x");
    expect($("source").eq(1).attr("srcset")).toBe("https://shop.example.com/wide.jpg");
    expect($("img").attr("src")).toBe("https://shop.example.com/p.jpg");
  });

  it("keeps a real src even when a lazy attribute is present, and loading=lazy as is", () => {
    const $ = $of(`<img src="/real.jpg" data-src="/other.jpg" loading="lazy">`);
    expect($("img").attr("src")).toBe("https://shop.example.com/real.jpg");
    expect($("img").attr("loading")).toBe("lazy");
  });

  it("data-bgset (widest candidate) and data-bg become an inline background, never over a real one", () => {
    const $ = $of(
      `<div id="a" class="hero lazyload" data-bgset="/h-600.jpg 600w, /h-1200.jpg 1200w [--wide] | /h-300.jpg 300w"></div>` +
        `<div id="b" data-bg="url('//cdn.example.com/b.jpg')" style="min-height:200px"></div>` +
        `<div id="c" data-bg="/c.jpg" style="background-image:url(/real.jpg)"></div>` +
        `<div id="d" data-bg="/d.jpg" style="background-image:url(${GIF})"></div>` +
        `<div id="e" data-bg="javascript:alert(1)"></div>`,
    );
    expect($("#a").attr("style")).toBe('background-image:url("https://shop.example.com/h-1200.jpg")');
    expect($("#a").attr("class")).toBe("hero lazyloaded");
    expect($("#b").attr("style")).toBe('min-height:200px;background-image:url("https://cdn.example.com/b.jpg")');
    expect($("#c").attr("style")).toBe('background-image:url("https://shop.example.com/real.jpg")');
    expect($("#d").attr("style")).toContain('background-image:url("https://shop.example.com/d.jpg")');
    expect($("#e").attr("style")).toBeUndefined();
  });

  it("swaps the lazysizes classes the store's CSS uses to hide not-yet-loaded images", () => {
    const $ = $of(`<img id="a" class="product__img lazyload" data-src="/a.jpg"><img id="b" class="b-lazy" data-src="/b.jpg"><img id="c" class="lazyload" data-src="javascript:alert(1)">`, `<style>.lazyload{opacity:0}.lazyloaded{opacity:1}</style>`);
    expect($("#a").attr("class")).toBe("product__img lazyloaded");
    expect($("#b").attr("class")).toBe("b-loaded");
    expect($("#c").attr("class")).toBe("lazyload"); // nothing to show: left alone
    expect($("#c").attr("src")).toBeUndefined();
  });

  it("never promotes an unsafe lazy URL; srcset candidates are validated one by one", () => {
    const r = sanitize(
      `<img id="a" src="${GIF}" data-src="javascript:alert(1)">` +
        `<img id="b" data-src="data:text/html;base64,PHNjcmlwdD4=">` +
        `<img id="c" data-srcset="javascript:alert(1) 1x, http://cdn.example.com/c-2x.jpg 2x, https://cdn.example.com/c-3x.jpg 3x">` +
        `<img id="d" data-srcset="vbscript:x 1x, javascript:alert(1) 2x" src="/d.jpg">` +
        `<picture><source data-srcset="javascript:alert(1) 1x, //cdn.example.com/p.webp 2x"><img src="/p.jpg"></picture>`,
    );
    const $ = cheerio.load(r.html);
    expect($("#a").attr("src")).toBe(GIF); // the placeholder stays rather than a script URL
    expect($("#b").attr("src")).toBeUndefined();
    // javascript: dropped; http never survives as http (upgraded to https by the existing resource rule)
    expect($("#c").attr("srcset")).toBe("https://cdn.example.com/c-2x.jpg 2x, https://cdn.example.com/c-3x.jpg 3x");
    expect($("#d").attr("srcset")).toBeUndefined();
    expect($("#d").attr("src")).toBe("https://shop.example.com/d.jpg");
    expect($("source").attr("srcset")).toBe("https://cdn.example.com/p.webp 2x");
    expectOnlyHttps(r.html);
  });

  it("isPlaceholderSrc", () => {
    for (const v of [undefined, "", "  ", GIF, "data:image/svg+xml,%3Csvg%3E", "/blank.gif", "https://cdn.example.com/x/spacer.gif?v=2", "/img/placeholder.png", "/lazy.gif", "/transparent.png", "/1x1.gif", "about:blank"]) {
      expect(isPlaceholderSrc(v), String(v)).toBe(true);
    }
    for (const v of ["/img/ring.jpg", "https://cdn.example.com/transparent-ring.png", "/blankets.jpg", "/files/aria_800x.jpg"]) expect(isPlaceholderSrc(v), v).toBe(false);
  });
});

describe("<noscript> fallbacks", () => {
  it("fill the scripted image next to them when it has no usable source; the <noscript> markup is never rendered", () => {
    const $ = $of(
      `<div class="card"><img id="a" class="lazyload" src="${GIF}" alt=""><noscript><img src="/a.jpg" srcset="/a.jpg 1x, /a@2x.jpg 2x" alt="Aria hoops"><p class="ns-text">Enable JavaScript</p></noscript></div>` +
        `<div class="gallery"><picture><img id="b" src=""></picture><noscript><picture><img src="//cdn.example.com/b.jpg"></picture></noscript></div>`,
    );
    expect($("#a").attr("src")).toBe("https://shop.example.com/a.jpg");
    expect($("#a").attr("srcset")).toBe("https://shop.example.com/a.jpg 1x, https://shop.example.com/a@2x.jpg 2x");
    expect($("#a").attr("alt")).toBe(""); // the page's own alt is kept
    expect($("#b").attr("src")).toBe("https://cdn.example.com/b.jpg");
    expect($("noscript, .ns-text").length).toBe(0);
    expect($("img").length).toBe(2);
  });

  it("leave a scripted image that already has a source alone", () => {
    const $ = $of(`<img id="a" class="lazyload" data-src="/img/aria.jpg?v=1" src="${GIF}"><noscript><img src="/fallback.jpg"></noscript><img id="b" src="/b.jpg"><noscript><img src="/b-fallback.jpg"></noscript>`);
    expect($("#a").attr("src")).toBe("https://shop.example.com/img/aria.jpg?v=1");
    expect($("#b").attr("src")).toBe("https://shop.example.com/b.jpg");
    expect($("img").length).toBe(2);
  });

  it("never promote a tracking pixel, a <noscript> image without a scripted counterpart, or an unsafe fallback", () => {
    const $ = $of(
      `<p>x</p><noscript><img height="1" width="1" style="display:none" src="https://pixel.example.com/tr?id=1&amp;noscript=1"></noscript>` +
        `<img id="c" src=""><noscript><img src="javascript:alert(1)" onerror="alert(1)"></noscript>` +
        `<p>y</p><noscript><img src="https://cdn.example.com/alone.jpg"></noscript><p>z</p>`,
    );
    expect($("noscript").length).toBe(0);
    expect($('img[src*="pixel.example.com"], img[src*="alone.jpg"]').length).toBe(0);
    expect($("#c").attr("src")).toBeUndefined(); // an empty src is dropped, never resolved to the page itself
    expect($("img").length).toBe(1);
  });
});

describe("regression: lazy handling keeps every existing rule", () => {
  it("scripts, on* handlers, iframes and forms are still removed from a lazy-heavy page", () => {
    const r = sanitize(
      `<div class="grid"><img class="lazyload" data-src="/a.jpg" onload="alert(1)" onerror="alert(2)"><noscript><img src="/a.jpg" onerror="alert(3)"><script>alert(4)</script></noscript>` +
        `<div data-bgset="/b.jpg" onmouseover="alert(5)"></div><script src="https://cdn.example.com/lazysizes.min.js"></script><script>document.querySelectorAll("img").forEach(i=>i.src=i.dataset.src)</script>` +
        `<iframe src="https://video.example.com/embed"></iframe><form action="/cart/add"><button type="submit">Add</button></form></div>`,
      `<script>window.lazySizesConfig={}</script>`,
    );
    expect(r.html).not.toMatch(/<script|<iframe|<form|<noscript|\son\w+=|alert\(/i);
    const $ = cheerio.load(r.html);
    expect($("img").attr("src")).toBe("https://shop.example.com/a.jpg");
    expect($("div[style]").attr("style")).toBe('background-image:url("https://shop.example.com/b.jpg")');
    expect($("button").attr("type")).toBe("button");
    expectOnlyHttps(r.html);
  });
});

// ---------------------------------------------------------------------------------------------------
// Product links on the home page
// ---------------------------------------------------------------------------------------------------

const ORIGIN = "https://shop.example.com";

function product(id: string, handle: string, cat: PreviewProduct["category"] = "ring"): PreviewProduct {
  return {
    id,
    title: `Example ${handle}`,
    url: `${ORIGIN}/products/${handle}`,
    images: [`https://cdn.example.com/${handle}.jpg`],
    price: 120,
    currency: "USD",
    categoryText: "Jewelry",
    category: cat,
    metal: null,
    style: null,
    tags: [],
    summary: null,
    available: true,
  };
}

const PRODUCTS = [product("7001", "aria-hoops", "earring"), product("7002", "solo-pendant", "necklace"), product("7003", "band-ring"), product("7004", "tide-cuff", "bracelet"), product("7005", "luna-studs", "earring")];
const TEXT = "Example Jewelry makes fine pieces by hand in small batches, with recycled gold and lab-grown stones. ".repeat(4);

const homeHtml = html(
  `<title>Example Jewelry</title><script>window.theme={}</script><style>.lazyload{opacity:0}</style>`,
  `<header><a id="logo" href="/">Example Jewelry</a></header><main><h1>Example Jewelry</h1><p>${TEXT}</p>
   <div class="featured">
     <a id="l1" href="/collections/rings/products/aria-hoops?variant=4411"><img class="lazyload" data-src="//cdn.example.com/aria-hoops_{width}x.jpg"></a>
     <a id="l2" href="/products/solo-pendant/"><img src="${GIF}" data-srcset="//cdn.example.com/solo-pendant.jpg 1x"></a>
     <a id="l3" href="/en-us/products/band-ring#reviews"><img src="" data-lazy-src="//cdn.example.com/band-ring.jpg"></a>
     <a id="l4" href="https://www.shop.example.com/collections/all/products/Tide-Cuff/?utm_source=home"><picture><source data-srcset="//cdn.example.com/tide-cuff.webp"><img src="/blank.gif"></picture></a>
     <a id="l5" href="/fr/collections/earrings/products/luna-studs.html"><img id="noscript-host" src=""><noscript><img src="//cdn.example.com/luna-studs.jpg"></noscript></a>
     <a id="other" href="/products/not-in-the-preview">More</a>
     <a id="coll" href="/collections/rings">Rings</a>
     <a id="ext" href="https://social.example.com/example-jewelry">Social</a>
   </div></main>`,
);

describe("home page product links", () => {
  it("point to the preview's own product pages (collection prefix, query, hash, trailing slash, locale, www, case, .html)", async () => {
    const n = fakeNet({ [`${ORIGIN}/robots.txt`]: "User-agent: *\nAllow: /\n", [`${ORIGIN}/`]: homeHtml });
    const store = new MemoryPageSnapshotStore();
    const now = Math.floor(Date.now() / 1000) * 1000;
    const info = await capturePageSnapshot({ key: KEY, origin: ORIGIN, products: PRODUCTS, expiresAt: new Date(now + 3_600_000) }, { fetcherOptions: n.options, store, env: {}, now: () => now });
    expect(info.mode).toBe("snapshot");
    const home = (await store.get(KEY, HOME_PAGE_ID, now))!;
    const $ = cheerio.load(home.html);
    expect($("#l1").attr("href")).toBe(`${PREFIX}/p/7001`);
    expect($("#l2").attr("href")).toBe(`${PREFIX}/p/7002`);
    expect($("#l3").attr("href")).toBe(`${PREFIX}/p/7003`);
    expect($("#l4").attr("href")).toBe(`${PREFIX}/p/7004`);
    expect($("#l5").attr("href")).toBe(`${PREFIX}/p/7005`);
    for (const id of ["l1", "l2", "l3", "l4", "l5", "logo"]) expect($(`#${id}`).attr("target"), id).toBeUndefined();
    expect($("#logo").attr("href")).toBe(PREFIX);
    // Pages GiftFit did not ingest keep the current behaviour: the real page in a new tab.
    for (const id of ["other", "coll", "ext"]) {
      expect($(`#${id}`).attr("target"), id).toBe("_blank");
      expect($(`#${id}`).attr("rel"), id).toBe(LINK_REL);
    }
    expect($("#other").attr("href")).toBe("https://shop.example.com/products/not-in-the-preview");
    // ...and the product grid's lazy images are filled.
    expect($("#l1 img").attr("src")).toBe("https://cdn.example.com/aria-hoops_800x.jpg");
    expect($("#l1 img").attr("class")).toBe("lazyloaded");
    expect($("#l2 img").attr("srcset")).toBe("https://cdn.example.com/solo-pendant.jpg 1x");
    expect($("#l3 img").attr("src")).toBe("https://cdn.example.com/band-ring.jpg");
    expect($("#l4 source").attr("srcset")).toBe("https://cdn.example.com/tide-cuff.webp");
    expect($("#noscript-host").attr("src")).toBe("https://cdn.example.com/luna-studs.jpg");
    expect(home.html).not.toMatch(/<script|<noscript/);
  });

  it("snapshotLinkMapper matches by path and by handle, only on the store's hosts", () => {
    const products = [
      { id: "w1", url: "https://shop.example.com/product/gold-chain/" }, // WooCommerce-style
      { id: "j1", url: "https://shop.example.com/rings/stack-ring" }, // a JSON-LD store's own path
      { id: "m1", url: "https://store.example.com/products/moon-charm" }, // products served from a second host
      { id: "a(1)", url: "https://shop.example.com/products/a-1" },
    ];
    const map = snapshotLinkMapper(KEY, "https://www.shop.example.com/", products);
    const at = (href: string) => map(new URL(href, "https://shop.example.com/"));
    expect(at("/product/gold-chain")).toBe(`${PREFIX}/p/w1`);
    expect(at("/de/product/gold-chain/?attribute_size=7")).toBe(`${PREFIX}/p/w1`);
    expect(at("/en-gb/rings/stack-ring/")).toBe(`${PREFIX}/p/j1`);
    expect(at("/products/moon-charm")).toBe(`${PREFIX}/p/m1`);
    expect(at("https://store.example.com/collections/x/products/moon-charm?variant=2")).toBe(`${PREFIX}/p/m1`);
    expect(at("/products/a-1")).toBe(`${PREFIX}/p/a%281%29`);
    // Not a product GiftFit shows, or not the store: external (null).
    expect(at("/products/gold-chain-extender")).toBeNull();
    expect(at("/collections/stack-ring")).toBeNull();
    expect(at("/rings")).toBeNull();
    expect(at("https://other.example.com/products/moon-charm")).toBeNull();
    expect(at("/")).toBe(PREFIX);
  });

  it("product paths stay internal across re-sanitizing, ids with !'()* included", () => {
    expect(snapshotProductPath(KEY, "a(1)!*'")).toBe(`${PREFIX}/p/a%281%29%21%2A%27`);
    const linkFor = snapshotLinkMapper(KEY, PAGE, [{ id: "a(1)", url: `${ORIGIN}/products/a-1` }]);
    const r = sanitizeSnapshotHtml(html("", `<a href="/products/a-1">A</a>`), { pageUrl: PAGE, linkFor, internalPrefix: PREFIX });
    expect(cheerio.load(r.html)("a").attr("href")).toBe(`${PREFIX}/p/a%281%29`);
    expect(r.rounds).toBe(2);
  });
});

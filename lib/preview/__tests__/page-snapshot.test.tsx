/**
 * Store-page snapshots (A15): capture through SafeFetcher on a fake network, the gates (jewelry, login/
 * payment, SPA shell, size, robots), link rewriting, storage and TTL; the snapshot routes' headers (exact
 * CSP, noindex, no-store) and 404s; the outer frame's sandbox; the preview service wiring.
 */
import * as cheerio from "cheerio";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SnapshotFrame } from "@/components/preview/SnapshotFrame";
import { capturePageSnapshot, MAX_SNAPSHOT_BYTES, MAX_SNAPSHOT_PRODUCT_PAGES, snapshotLinkMapper, type PageSnapshotInfo } from "../page-snapshot";
import { inSnapshotMode, serveSnapshotHome, serveSnapshotProduct, SNAPSHOT_CSP, SNAPSHOT_IFRAME_SANDBOX } from "../page-snapshot-http";
import { FirestorePageSnapshotStore, HOME_PAGE_ID, MemoryPageSnapshotStore, PAGE_SNAPSHOT_COLLECTION, productPageId } from "../page-snapshot-store";
import { DEFAULT_PREVIEW_SETTINGS, FirestorePreviewRepo, MemoryPreviewRepo, PREVIEW_TTL_MS, type PreviewRecord } from "../repo";
import { FakeFirestore } from "@/lib/store/__tests__/fake-firestore";
import type { PreviewProduct } from "../types";
import { fakeNet, html } from "./fake-site";

const ORIGIN = "https://lumen.example";
const KEY = "AbCdEfGhIjKlMnOpQrStUv";
// Relative to the real clock: the memory stores sweep expired entries with Date.now().
const T0 = Math.floor(Date.now() / 1000) * 1000;
const EXPIRES = new Date(T0 + PREVIEW_TTL_MS);

function product(id: string, cat: PreviewProduct["category"], path = `/products/${id}`): PreviewProduct {
  return {
    id,
    title: `Piece ${id}`,
    url: `${ORIGIN}${path}`,
    images: [`https://cdn.lumen.example/${id}.jpg`],
    price: 100,
    currency: "USD",
    categoryText: cat ?? "Gift",
    category: cat,
    metal: null,
    style: null,
    tags: [],
    summary: `Piece ${id} summary`,
    available: true,
  };
}
const JEWELRY = [product("aria-hoops", "earring"), product("solo-pendant", "necklace"), product("band-ring", "ring"), product("tide-cuff", "bracelet")];

const LONG_TEXT = "Fine jewelry made by hand in small batches, with recycled gold and conflict-free stones. ".repeat(4);
const homeHtml = (extra = "") =>
  html(
    `<title>Lumen</title><link rel="stylesheet" href="/theme.css"><script>document.title="pwned"</script><style>.hero{background:url(/hero.jpg)}</style>`,
    `<header><a href="/">Lumen</a><nav><a href="/collections/all">Shop</a><a href="https://instagram.example/lumen">IG</a></nav></header>
     <main><h1>Lumen Fine Jewelry</h1><p>${LONG_TEXT}</p>
     <ul>${JEWELRY.map((p) => `<li><a href="/collections/all/products/${p.id}?variant=1"><img src="//cdn.lumen.example/${p.id}.jpg" onerror="alert(1)"> ${p.title}</a></li>`).join("")}</ul>
     <form action="/contact"><input name="email"><button type="submit">Join</button></form><iframe src="https://video.example/embed"></iframe>${extra}</main>`,
  );
const productHtml = (p: PreviewProduct) => html(`<title>${p.title}</title><script>x()</script>`, `<main><h1>${p.title}</h1><img src="/${p.id}-large.jpg"><p>${LONG_TEXT}</p><a href="/">Back</a><button>Add to cart</button></main>`);

function net(home: string = homeHtml(), extra: Record<string, string | { status?: number; body?: string; type?: string }> = {}) {
  const routes: Record<string, string | { status?: number; body?: string; type?: string }> = {
    [`${ORIGIN}/robots.txt`]: "User-agent: *\nAllow: /\n",
    [`${ORIGIN}/`]: home,
    ...Object.fromEntries(JEWELRY.map((p) => [p.url, productHtml(p)])),
    ...extra,
  };
  return fakeNet(routes);
}

let store: MemoryPageSnapshotStore;
beforeEach(() => {
  store = new MemoryPageSnapshotStore();
});

const capture = (n = net(), products: PreviewProduct[] = JEWELRY, env: Record<string, string | undefined> = {}) =>
  capturePageSnapshot({ key: KEY, origin: ORIGIN, products, expiresAt: EXPIRES }, { fetcherOptions: n.options, store, env, now: () => T0 });

describe("capturePageSnapshot", () => {
  it("copies the home page and the product pages, sanitized, with GiftFit product links kept inside", async () => {
    const n = net();
    const info = await capture(n);
    expect(info).toMatchObject({ mode: "snapshot", reason: null, productPages: JEWELRY.map((p) => p.id) });
    expect(info.bytes).toBeGreaterThan(0);
    // robots.txt, home, 4 product pages; the honest UA on every request
    expect(n.hrefs()).toEqual([`${ORIGIN}/robots.txt`, `${ORIGIN}/`, ...JEWELRY.map((p) => p.url)]);
    for (const c of n.calls) expect(c.headers["user-agent"]).toMatch(/^GiftFitPreviewBot\//);

    const home = await store.get(KEY, HOME_PAGE_ID, T0);
    expect(home?.expiresAt.getTime()).toBe(EXPIRES.getTime());
    const $ = cheerio.load(home!.html);
    expect($("script, form, input, iframe").length).toBe(0);
    expect(home!.html).not.toMatch(/onerror|pwned/);
    expect($("li a").first().attr("href")).toBe(`/s/${KEY}/snapshot/p/aria-hoops`);
    expect($("li a").first().attr("target")).toBeUndefined();
    expect($("header a").first().attr("href")).toBe(`/s/${KEY}/snapshot`);
    expect($('nav a[href="https://lumen.example/collections/all"]').attr("target")).toBe("_blank");
    expect($('nav a[href="https://instagram.example/lumen"]').attr("rel")).toBe("noopener noreferrer nofollow");
    expect($("img").first().attr("src")).toBe("https://cdn.lumen.example/aria-hoops.jpg");
    expect($("link").attr("href")).toBe("https://lumen.example/theme.css");
    expect($("style").text()).toContain("https://lumen.example/hero.jpg");
    expect($("button").attr("type")).toBe("button");

    const pdp = await store.get(KEY, productPageId("band-ring"), T0);
    expect(pdp?.productId).toBe("band-ring");
    expect(pdp?.html).toContain('src="https://lumen.example/band-ring-large.jpg"');
    expect(pdp?.html).not.toContain("<script");
  });

  it("needs at least 3 jewelry products", async () => {
    const n = net();
    const info = await capture(n, [product("a", "earring"), product("b", "ring"), product("tea", null), product("pot", null)]);
    expect(info).toMatchObject({ mode: "template", reason: "not_jewelry" });
    expect(n.calls).toHaveLength(0);
    expect(store.pages.size).toBe(0);
  });

  it("can be switched off", async () => {
    expect(await capture(net(), JEWELRY, { PREVIEW_SNAPSHOT: "off" })).toMatchObject({ mode: "template", reason: "disabled" });
  });

  it("refuses login / payment-looking pages", async () => {
    expect(await capture(net(homeHtml(`<label>Password <input type="password" name="pw"></label>`)))).toMatchObject({ mode: "template", reason: "sensitive_page" });
    expect(await capture(net(homeHtml(`<p>Enter your card number and CVV to continue</p>`)))).toMatchObject({ mode: "template", reason: "sensitive_page" });
    expect(store.pages.size).toBe(0);
  });

  it("falls back for a JS-rendered shell (too little text) and for a page without images", async () => {
    const shell = html(`<title>Shop</title><script src="/app.js"></script>`, `<div id="root"></div><noscript>You need to enable JavaScript to run this app.</noscript>`);
    expect(await capture(net(shell))).toMatchObject({ mode: "template", reason: "too_little_text" });
    const noImages = html(`<title>Shop</title>`, `<main><h1>Lumen</h1><p>${LONG_TEXT}</p></main>`);
    expect(await capture(net(noImages))).toMatchObject({ mode: "template", reason: "no_images" });
  });

  it("falls back when the sanitized page is over the size cap", async () => {
    const big = homeHtml(`<div>${"<p>Gold hoops in recycled gold, made by hand.</p>".repeat(Math.ceil(MAX_SNAPSHOT_BYTES / 40))}</div>`);
    expect(await capture(net(big))).toMatchObject({ mode: "template", reason: "too_large" });
  });

  it("respects robots.txt and reports fetch failures", async () => {
    const blocked = await capture(net(homeHtml(), { [`${ORIGIN}/robots.txt`]: "User-agent: GiftFitPreviewBot\nDisallow: /\n" }));
    expect(blocked).toMatchObject({ mode: "template", reason: "robots_disallowed" });
    expect(await capture(net(homeHtml(), { [`${ORIGIN}/`]: { status: 500 } }))).toMatchObject({ mode: "template", reason: "fetch_failed" });
  });

  it("skips product pages that fail their own checks, keeps the rest", async () => {
    const n = net(homeHtml(), { [JEWELRY[1].url]: html("", `<input type="password">${LONG_TEXT}<img src="/x.jpg">`), [JEWELRY[2].url]: { status: 404 } });
    const info = await capture(n);
    expect(info.mode).toBe("snapshot");
    expect(info.productPages).toEqual(["aria-hoops", "tide-cuff"]);
  });

  it("captures at most MAX_SNAPSHOT_PRODUCT_PAGES pages, home-linked products first, same host only", async () => {
    const many = [...Array.from({ length: 14 }, (_, i) => product(`extra-${i}`, "ring")), ...JEWELRY, product("elsewhere", "ring")];
    many[many.length - 1] = { ...many[many.length - 1], url: "https://other.example/products/elsewhere" };
    const routes = Object.fromEntries(many.map((p) => [p.url, productHtml(p)]));
    const info = await capture(net(homeHtml(), routes), many);
    expect(info.productPages).toHaveLength(MAX_SNAPSHOT_PRODUCT_PAGES);
    expect(info.productPages.slice(0, 4)).toEqual(JEWELRY.map((p) => p.id));
    expect(info.productPages).not.toContain("elsewhere");
  });

  it("removes the previous pages of the preview before a new capture", async () => {
    await capture();
    expect(store.pages.size).toBe(5);
    await capture(net(homeHtml(`<input type="password">`)));
    expect(store.pages.size).toBe(0);
  });
});

describe("snapshotLinkMapper", () => {
  const map = snapshotLinkMapper(KEY, "https://www.lumen.example/", [product("aria-hoops", "earring"), { id: "x y", url: `${ORIGIN}/p/X%20Y/` }, { id: "nopage", url: ORIGIN }]);
  it("matches product URLs by path (www, case, trailing slash, query, /collections/…/products/)", () => {
    expect(map(new URL("https://lumen.example/products/aria-hoops"))).toBe(`/s/${KEY}/snapshot/p/aria-hoops`);
    expect(map(new URL("https://www.lumen.example/collections/new/products/Aria-Hoops?variant=2"))).toBe(`/s/${KEY}/snapshot/p/aria-hoops`);
    expect(map(new URL("https://lumen.example/p/x%20y"))).toBe(`/s/${KEY}/snapshot/p/x%20y`);
    expect(map(new URL("https://lumen.example/"))).toBe(`/s/${KEY}/snapshot`);
    expect(map(new URL("https://lumen.example/collections/all"))).toBeNull();
    expect(map(new URL("https://evil.example/products/aria-hoops"))).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------
// Serving
// ---------------------------------------------------------------------------------------------------

function record(snapshot: PageSnapshotInfo | null, over: Partial<PreviewRecord> = {}): PreviewRecord {
  return {
    key: KEY,
    domain: "lumen.example",
    storeUrl: ORIGIN,
    state: "ready",
    reason: null,
    storeName: "Lumen",
    platform: "shopify",
    currency: "USD",
    products: JEWELRY,
    productCount: JEWELRY.length,
    fetches: 5,
    createdAt: new Date(T0),
    updatedAt: new Date(T0),
    expiresAt: EXPIRES,
    ownerTokenHash: "0".repeat(64),
    runner: null,
    settings: { ...DEFAULT_PREVIEW_SETTINGS },
    snapshot,
    ...over,
  };
}

const EXPECTED_CSP = "default-src 'none'; img-src https: data:; style-src https: 'unsafe-inline'; font-src https: data:; frame-ancestors 'self'";

function expectSnapshotHeaders(res: Response) {
  expect(res.headers.get("content-security-policy")).toBe(EXPECTED_CSP);
  expect(res.headers.get("content-security-policy")).not.toMatch(/script-src/);
  expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
}

describe("snapshot routes", () => {
  let repo: MemoryPreviewRepo;
  let info: PageSnapshotInfo;
  beforeEach(async () => {
    repo = new MemoryPreviewRepo();
    info = await capture(net());
  });
  afterEach(() => undefined);

  it("serve the sanitized home and product pages with the strict headers", async () => {
    await repo.create(record(info));
    const home = await serveSnapshotHome(KEY, { repo, store, nowMs: T0 });
    expect(home.status).toBe(200);
    expectSnapshotHeaders(home);
    const body = await home.text();
    expect(body).toContain("Lumen Fine Jewelry");
    expect(body).not.toContain("<script");

    const pdp = await serveSnapshotProduct(KEY, "band-ring", { repo, store, nowMs: T0 });
    expect(pdp.status).toBe(200);
    expectSnapshotHeaders(pdp);
    expect(await pdp.text()).toContain("band-ring-large.jpg");
  });

  it("render GiftFit's plain card for a shown product without a captured page", async () => {
    await repo.create(record({ ...info, productPages: [] }));
    const res = await serveSnapshotProduct(KEY, "solo-pendant", { repo, store, nowMs: T0 });
    expect(res.status).toBe(200);
    expectSnapshotHeaders(res);
    const $ = cheerio.load(await res.text());
    expect($("h1").text()).toBe("Piece solo-pendant");
    expect($("a.btn").attr("href")).toBe(`${ORIGIN}/products/solo-pendant`);
    expect($("a.btn").attr("rel")).toBe("noopener noreferrer nofollow");
    expect($("a.btn").attr("target")).toBe("_blank");
    expect($("script").length).toBe(0);
  });

  it("404 (same headers) for unknown keys, expired or template-mode previews, unknown or removed products", async () => {
    const cases: Response[] = [];
    cases.push(await serveSnapshotHome("not-a-key", { repo, store, nowMs: T0 }));
    cases.push(await serveSnapshotHome(KEY, { repo, store, nowMs: T0 })); // no record
    await repo.create(record({ ...info, mode: "template", reason: "too_little_text" }));
    cases.push(await serveSnapshotHome(KEY, { repo, store, nowMs: T0 }));
    await repo.update(KEY, { snapshot: info, settings: { version: 0, removedProductIds: ["band-ring"] } });
    cases.push(await serveSnapshotProduct(KEY, "band-ring", { repo, store, nowMs: T0 }));
    cases.push(await serveSnapshotProduct(KEY, "nope", { repo, store, nowMs: T0 }));
    expect((await serveSnapshotHome(KEY, { repo, store, nowMs: T0 })).status).toBe(200);
    expect((await serveSnapshotProduct(KEY, "aria-hoops", { repo, store, nowMs: T0 })).status).toBe(200);
    cases.push(await serveSnapshotHome(KEY, { repo, store, nowMs: EXPIRES.getTime() + 1 })); // expired preview
    for (const r of cases) {
      expect(r.status).toBe(404);
      expectSnapshotHeaders(r);
    }
  });

  it("inSnapshotMode needs a ready preview whose snapshot mode is on", () => {
    expect(inSnapshotMode(record(info))).toBe(true);
    expect(inSnapshotMode(record(info, { state: "crawling" }))).toBe(false);
    expect(inSnapshotMode(record({ ...info, mode: "template", reason: "not_jewelry" }))).toBe(false);
    expect(inSnapshotMode(record(null))).toBe(false);
  });

  it("the constant CSP is the exact policy", () => {
    expect(SNAPSHOT_CSP).toBe(EXPECTED_CSP);
  });
});

describe("outer frame", () => {
  it("is sandboxed without allow-scripts, allow-same-origin or allow-forms", () => {
    const markup = renderToStaticMarkup(
      <SnapshotFrame src={`/s/${KEY}/snapshot`} title="copy">
        <p data-testid="preview-banner">banner</p>
      </SnapshotFrame>,
    );
    const $ = cheerio.load(markup);
    const sandbox = $("iframe").attr("sandbox") ?? "";
    expect(sandbox).toBe(SNAPSHOT_IFRAME_SANDBOX);
    expect(sandbox.split(/\s+/).sort()).toEqual(["allow-popups", "allow-popups-to-escape-sandbox"]);
    for (const banned of ["allow-scripts", "allow-same-origin", "allow-forms", "allow-top-navigation", "allow-modals"]) expect(sandbox).not.toContain(banned);
    expect($("iframe").attr("src")).toBe(`/s/${KEY}/snapshot`);
    expect($("iframe").attr("referrerpolicy")).toBe("no-referrer");
    // The banner is outside the frame.
    expect($("iframe").prevAll('[data-testid="preview-banner"]').length).toBe(1);
  });
});

describe("TTL", () => {
  it("pages expire with the preview and move with it", async () => {
    await capture();
    expect(await store.get(KEY, HOME_PAGE_ID, EXPIRES.getTime() + 1)).toBeNull();
    await capture();
    const later = new Date(EXPIRES.getTime() + 3_600_000);
    await store.extend(KEY, later);
    expect(await store.get(KEY, HOME_PAGE_ID, EXPIRES.getTime() + 1)).not.toBeNull();
    await store.deleteFor(KEY);
    expect(store.pages.size).toBe(0);
  });
});

describe("Firestore storage", () => {
  it(`stores one ${PAGE_SNAPSHOT_COLLECTION} document per page with expiresAt, and the record keeps the outcome`, async () => {
    const db = new FakeFirestore();
    const fsStore = new FirestorePageSnapshotStore(async () => db);
    const info = await capturePageSnapshot({ key: KEY, origin: ORIGIN, products: JEWELRY, expiresAt: EXPIRES }, { fetcherOptions: net().options, store: fsStore, env: {}, now: () => T0 });
    expect(info.mode).toBe("snapshot");
    const home = await fsStore.get(KEY, HOME_PAGE_ID, T0);
    expect(home?.html).toContain("Lumen Fine Jewelry");
    expect(home?.expiresAt.getTime()).toBe(EXPIRES.getTime());
    expect(await fsStore.get(KEY, HOME_PAGE_ID, EXPIRES.getTime())).toBeNull();
    const later = new Date(EXPIRES.getTime() + 3_600_000);
    await fsStore.extend(KEY, later);
    expect((await fsStore.get(KEY, productPageId("band-ring"), EXPIRES.getTime() + 1))?.expiresAt.getTime()).toBe(later.getTime());
    await fsStore.deleteFor(KEY);
    expect(await fsStore.get(KEY, HOME_PAGE_ID, T0)).toBeNull();

    const repo = new FirestorePreviewRepo(async () => db);
    await repo.create(record(null));
    await repo.update(KEY, { snapshot: info });
    const got = await repo.get(KEY, T0);
    expect(got?.snapshot).toEqual(info);
  });
});

describe("next.config.ts framing headers", () => {
  it("give the snapshot routes the same strict CSP (config headers override a route's own)", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("../../../next.config.ts", import.meta.url), "utf8");
    expect(src).toContain(`value: "${SNAPSHOT_CSP}"`);
    expect(src).toContain(`s/[^/]+/snapshot(?:/|$)`);
  });
});

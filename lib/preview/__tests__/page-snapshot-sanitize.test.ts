/**
 * Store-page snapshot sanitizer (A15): an OWASP-cheat-sheet-style XSS vector list. For every vector the
 * output must contain no script, no event handler, no dangerous URL, nothing that submits or embeds, and
 * must be a fixpoint (re-parsing and re-sanitizing changes nothing).
 */
import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";
import { describe, expect, it } from "vitest";
import { assessSensitivePage, isDangerousCss, sanitizeCss, sanitizeSnapshotHtml, sanitizeSrcset, LINK_REL } from "../page-snapshot-sanitize";

const PAGE = "https://shop.example/";
const PREFIX = "/s/KEY/snapshot";
const linkFor = (u: URL) => (u.hostname === "shop.example" && u.pathname === "/products/ring" ? `${PREFIX}/p/ring` : u.hostname === "shop.example" && u.pathname === "/" ? PREFIX : null);
const sanitize = (body: string, head = "") => sanitizeSnapshotHtml(`<!doctype html><html><head>${head}</head><body>${body}</body></html>`, { pageUrl: PAGE, linkFor, internalPrefix: PREFIX });

const FORBIDDEN = new Set([
  "script",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "portal",
  "fencedframe",
  "form",
  "input",
  "textarea",
  "select",
  "option",
  "base",
  "noscript",
  "template",
  "math",
  "foreignobject",
  "animate",
  "animatetransform",
  "animatemotion",
  "set",
  "xmp",
  "noembed",
  "noframes",
  "plaintext",
  "keygen",
  "video",
  "audio",
  "isindex",
  "feimage",
]);
const URL_ATTRS = new Set(["href", "src", "xlink:href", "action", "formaction", "data", "poster", "background", "cite", "longdesc", "codebase", "dynsrc", "lowsrc"]);

function okUrl(value: string, el: Element): boolean {
  const v = value.trim();
  if (v.startsWith(PREFIX)) return true;
  if (/^#[\w:.-]+$/.test(v) && el.name.toLowerCase() === "use") return true;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return false; // every URL we keep is absolute
  }
  if (u.protocol === "https:" || (u.protocol === "http:" && (el.name === "a" || el.name === "area"))) return true;
  return u.protocol === "data:" && /^data:image\//i.test(v) && el.name !== "a";
}

function assertInert(out: string): void {
  expect(out).not.toMatch(/<script/i);
  expect(out).not.toMatch(/javascript:|vbscript:|data:text\/html/i);
  const $ = cheerio.load(out, { scriptingEnabled: false });
  const walk = (n: AnyNode) => {
    if (n.type === "comment" || n.type === "cdata") throw new Error(`comment survived: ${out}`);
    if (n.type !== "tag" && n.type !== "script" && n.type !== "style" && n.type !== "root") return;
    if (n.type !== "root") {
      const el = n as Element;
      const name = el.name.toLowerCase();
      expect(FORBIDDEN.has(name), `<${name}> survived in ${out}`).toBe(false);
      if (el.namespace && el.namespace !== "http://www.w3.org/1999/xhtml") expect(el.namespace).toBe("http://www.w3.org/2000/svg");
      if (name === "button") expect(el.attribs.type).toBe("button");
      if (name === "link") expect(el.attribs.rel).toBe("stylesheet");
      if (name === "meta") expect(el.attribs["http-equiv"]).toBeUndefined();
      if (name === "style") expect(isDangerousCss($(el).text())).toBe(false);
      if (name === "a" && el.attribs.target) {
        expect(el.attribs.target).toBe("_blank");
        expect(el.attribs.rel).toBe(LINK_REL);
      }
      for (const [k, v] of Object.entries(el.attribs)) {
        const lk = k.toLowerCase();
        expect(lk.startsWith("on"), `handler ${k} survived in ${out}`).toBe(false);
        expect(["srcdoc", "formaction", "action", "ping", "http-equiv"].includes(lk), `${k} survived`).toBe(false);
        expect(v.includes("<"), `"<" in ${k}`).toBe(false);
        if (URL_ATTRS.has(lk)) expect(okUrl(v, el), `${k}="${v}" on <${el.name}>`).toBe(true);
        if (lk === "srcset") for (const c of v.split(/,\s+/)) expect(okUrl(c.split(/\s+/)[0], el), `srcset ${v}`).toBe(true);
        if (lk === "style") expect(isDangerousCss(v)).toBe(false);
      }
    }
    for (const c of (n as Element).children ?? []) walk(c);
  };
  walk($.root()[0]);
  // Fixpoint: what the browser would parse sanitizes to itself.
  expect(sanitizeSnapshotHtml(out, { pageUrl: PAGE, linkFor, internalPrefix: PREFIX }).html).toBe(out);
}

const VECTORS: [string, string][] = [
  ["script", `<script>alert(1)</script>`],
  ["script src upper", `<SCRIPT SRC=https://xss.example/xss.js></SCRIPT>`],
  ["module script", `<script type="module">import x from "https://e.example/x.js"</script>`],
  ["json-ld", `<script type="application/ld+json">{"@type":"Product"}</script>`],
  ["img javascript", `<IMG SRC="javascript:alert('XSS');">`],
  ["img mixed case", `<IMG SRC=JaVaScRiPt:alert('XSS')>`],
  ["img decimal entities", `<IMG SRC=&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;&#97;&#108;&#101;&#114;&#116;&#40;&#39;&#88;&#83;&#83;&#39;&#41;>`],
  ["img hex entities no semicolons", `<IMG SRC=&#x6A&#x61&#x76&#x61&#x73&#x63&#x72&#x69&#x70&#x74&#x3A&#x61&#x6C&#x65&#x72&#x74&#x28&#x27&#x58&#x53&#x53&#x27&#x29>`],
  ["img zero-padded entities", `<IMG SRC=&#0000106&#0000097&#0000118&#0000097&#0000115&#0000099&#0000114&#0000105&#0000112&#0000116&#0000058&#0000097&#0000108&#0000101&#0000114&#0000116&#0000040&#0000039&#0000088&#0000083&#0000083&#0000039&#0000041>`],
  ["a tab entity", `<a href="jav&#x09;ascript:alert(1)">x</a>`],
  ["a newline entity", `<a href="jav&#x0A;ascript:alert(1)">x</a>`],
  ["a CR entity", `<a href="jav&#x0D;ascript:alert(1)">x</a>`],
  ["a leading controls", `<a href=" &#14;  javascript:alert(1)">x</a>`],
  ["a named tab entity", `<a href="java&Tab;script&colon;alert(1)">x</a>`],
  ["a uppercase", `<A HREF="JAVASCRIPT:alert(1)">x</A>`],
  ["a vbscript", `<a href="vbscript:msgbox(1)">x</a>`],
  ["a data html", `<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>`],
  ["img onerror", `<img src=x onerror=alert(1)>`],
  ["img OnErRoR", `<img src=x OnErRoR=alert(1)>`],
  ["img slashes", `<img/src=x/onerror=alert(1)>`],
  ["body onload", `</body><body onload=alert(1)>`],
  ["details ontoggle", `<details open ontoggle=alert(1)><summary>s</summary></details>`],
  ["div onclick", `<DIV ONCLICK="alert(1)">x</DIV>`],
  ["svg onload", `<svg onload=alert(1)><circle r="1"/></svg>`],
  ["svg script", `<svg><script>alert(1)</script></svg>`],
  ["svg script xlink", `<svg><script xlink:href="data:,alert(1)"></script></svg>`],
  ["svg a javascript", `<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>`],
  ["svg animate href", `<svg><animate xlink:href="#x" attributeName="href" values="javascript:alert(1)"/><a id="x"><text>c</text></a></svg>`],
  ["svg set handler", `<svg><set attributeName="onmouseover" to="alert(1)"/></svg>`],
  ["svg foreignObject", `<svg><foreignObject><iframe srcdoc="<script>alert(1)</script>"></iframe></foreignObject></svg>`],
  ["svg image javascript", `<svg><image href="javascript:alert(1)"/></svg>`],
  ["svg use external", `<svg><use href="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=#x"/></svg>`],
  ["iframe srcdoc", `<iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe>`],
  ["iframe javascript", `<iframe src="javascript:alert(1)"></iframe>`],
  ["meta refresh", `<meta http-equiv="refresh" content="0;url=javascript:alert(1)">`],
  ["base href", `<base href="javascript:alert(1)//"><a href="/x">x</a>`],
  ["base target", `<base target="_top"><a href="/x">x</a>`],
  ["form action", `<form action="javascript:alert(1)"><input type="submit"></form>`],
  ["button formaction", `<form><button formaction="javascript:alert(1)">X</button></form>`],
  ["button submit", `<button type="submit" form="f">Buy</button>`],
  ["object data", `<object data="javascript:alert(1)"></object>`],
  ["object data html", `<object data="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="></object>`],
  ["embed", `<embed src="data:text/html,<script>alert(1)</script>">`],
  ["applet portal frameset", `<applet code="x"></applet><portal src="https://e.example"></portal>`],
  ["math mglyph style mXSS", `<math><mtext><table><mglyph><style><img src=x onerror=alert(1)></style></mglyph></table></mtext></math>`],
  ["math mglyph comment mXSS", `<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;/mglyph&gt;&lt;img&Tab;src=1&Tab;onerror=alert(1)&gt;">`],
  ["svg p style mXSS", `<svg></p><style><a id="</style><img src=1 onerror=alert(1)>">`],
  ["noscript title mXSS", `<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>`],
  ["noscript img", `<noscript><img src="https://cdn.example/a.jpg"></noscript>`],
  ["style import javascript", `<style>@import 'javascript:alert(1)';</style>`],
  ["style import url javascript", `<style>@import url("javascript:alert(1)");</style>`],
  ["style url javascript", `<style>body{background:url("javascript:alert(1)")}</style>`],
  ["style expression", `<style>a{width:expression(alert(1))}</style>`],
  ["style closing trick", `<style>a{}</style><style>/*</style><img src=x onerror=alert(1)>*/</style>`],
  ["inline expression", `<div style="width: expression(alert(1))">x</div>`],
  ["inline commented expression", `<div style="width: expr/**/ession(alert(1))">x</div>`],
  ["inline escaped expression", `<div style="width: e\\78 pression(alert(1))">x</div>`],
  ["inline url javascript", `<div style="background:url(javascript:alert(1))">x</div>`],
  ["inline escaped url javascript", `<div style="background:url(\\6a avascript:alert(1))">x</div>`],
  ["inline moz-binding", `<div style="-moz-binding:url(https://e.example/x.xml#xss)">x</div>`],
  ["inline behavior", `<div style="behavior: url(x.htc)">x</div>`],
  ["link preload script", `<link rel="preload" as="script" href="https://e.example/x.js">`],
  ["link modulepreload", `<link rel=modulepreload href=x.js>`],
  ["link import", `<link rel=import href=x.html>`],
  ["link manifest", `<link rel=manifest href=m.json>`],
  ["link serviceworker", `<link rel=serviceworker href=sw.js>`],
  ["link stylesheet javascript", `<link rel="stylesheet" href="javascript:alert(1)">`],
  ["srcset javascript", `<img srcset="javascript:alert(1) 1x, https://ok.example/x.png 2x">`],
  ["picture source javascript", `<picture><source srcset="javascript:alert(1)"><img src="x.png"></picture>`],
  ["source outside picture", `<video><source src=x onerror="alert(1)"></video><audio src=x onerror=alert(1)></audio>`],
  ["inputs", `<input autofocus onfocus=alert(1)><textarea>t</textarea><select><option>o</option></select><keygen autofocus onfocus=alert(1)>`],
  ["isindex", `<isindex type=image src=1 onerror=alert(1)>`],
  ["template", `<template><script>alert(1)</script><img src=x onerror=alert(1)></template>`],
  ["xmp", `<xmp><img src=x onerror=alert(1)></xmp>`],
  ["noembed", `<noembed><img title="</noembed><img src onerror=alert(1)>"></noembed>`],
  ["noframes", `<noframes><img title="</noframes><img src onerror=alert(1)>"></noframes>`],
  ["conditional comment", `<!--[if gte IE 4]><SCRIPT>alert('XSS');</SCRIPT><![endif]-->`],
  ["cdata", `<![CDATA[<script>alert(1)</script>]]>`],
  ["comment break", `<!-- --!><script>alert(1)</script> -->`],
  ["attribute with markup", `<div data-x="<img src=x onerror=alert(1)>">x</div>`],
  ["a ping", `<a href="https://shop.example/x" ping="https://track.example/">x</a>`],
  ["a target top", `<a href="https://other.example/" target="_top">x</a>`],
  ["area javascript", `<map name="m"><area href="javascript:alert(1)"></map>`],
  ["table background", `<table background="javascript:alert(1)"><tr><td>x</td></tr></table>`],
  ["lazy data-src javascript", `<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="javascript:alert(1)" data-srcset="javascript:alert(1) 1x">`],
  ["lazy data-bg javascript", `<div data-bg="url(javascript:alert(1))" data-bgset="javascript:alert(1) 1x | vbscript:x"></div>`],
  ["lazy picture source data-srcset", `<picture><source data-srcset="javascript:alert(1)"><img data-src="data:text/html;base64,PHNjcmlwdD4="></picture>`],
  ["noscript fallback handler", `<img class="lazyload" src=""><noscript><img src="/a.jpg" onerror="alert(1)"><script>alert(1)</script></noscript>`],
  ["null byte", `<a href="java\u0000script:alert(1)">x</a><img src="java\u0000script:alert(1)">`],
];

describe("sanitizeSnapshotHtml: XSS vectors", () => {
  it.each(VECTORS)("%s", (_name, vector) => {
    assertInert(sanitize(`<p>before</p>${vector}<p>after</p>`).html);
  });

  it("the same vectors inside <head> are inert too", () => {
    assertInert(sanitize("<p>x</p>", VECTORS.map((v) => v[1]).join("\n")).html);
  });

  it("all vectors at once stay inert", () => {
    assertInert(sanitize(VECTORS.map((v) => v[1]).join("\n")).html);
  });
});

describe("sanitizeSnapshotHtml: what it keeps", () => {
  it("keeps markup and classes, absolute merchant resources, our head and no <base>", () => {
    const r = sanitizeSnapshotHtml(
      `<!doctype html><html lang="en" class="no-js"><head><meta charset="windows-1252"><title>Lumen</title><link rel="stylesheet" href="/assets/theme.css" media="all"><style>.hero{background:url(img/hero.jpg)} @import "fonts.css";</style></head>
       <body class="home"><header class="site-header"><a href="/" class="logo">Lumen</a></header>
       <main><h1 class="title">Fine jewelry</h1><img src="//cdn.example/ring.jpg" alt="Ring" width="400"><img src="http://cdn.example/http.jpg">
       <picture><source srcset="/a.webp 1x, /b.webp 2x" type="image/webp"><img src="/a.jpg"></picture>
       <div style="background-image:url('/bg.png')">Hello</div><svg viewBox="0 0 10 10"><use href="#icon"></use><path d="M0 0L10 10"/></svg></main></body></html>`,
      { pageUrl: "https://shop.example/", linkFor, internalPrefix: PREFIX },
    );
    const $ = cheerio.load(r.html);
    expect(r.html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect($("html").attr("class")).toBe("no-js");
    expect($("base").length).toBe(0);
    expect($('meta[charset="utf-8"]').length).toBe(1);
    expect($('meta[name="robots"]').attr("content")).toBe("noindex, nofollow");
    expect($('meta[name="referrer"]').attr("content")).toBe("no-referrer");
    expect($("link").attr("href")).toBe("https://shop.example/assets/theme.css");
    expect($("link").attr("media")).toBe("all");
    expect($("style").text()).toContain('url("https://shop.example/img/hero.jpg")');
    expect($("style").text()).toContain('@import url("https://shop.example/fonts.css")');
    expect($("img").eq(0).attr("src")).toBe("https://cdn.example/ring.jpg");
    expect($("img").eq(1).attr("src")).toBe("https://cdn.example/http.jpg");
    expect($("source").attr("srcset")).toBe("https://shop.example/a.webp 1x, https://shop.example/b.webp 2x");
    expect($("div[style]").attr("style")).toBe('background-image:url("https://shop.example/bg.png")');
    expect($("use").attr("href")).toBe("#icon");
    expect($("h1.title").text()).toBe("Fine jewelry");
    expect($("a.logo").attr("href")).toBe(PREFIX);
    expect($("a.logo").attr("target")).toBeUndefined();
    expect(r.images).toBe(4);
    expect(r.textChars).toBeGreaterThan(10);
  });

  it("rewrites links: GiftFit products and home stay inside, everything else opens the real site in a new tab", () => {
    const r = sanitize(
      `<a id="p" href="/products/ring">Ring</a><a id="c" href="/collections/all?x=1">All</a><a id="e" href="https://ig.example/lumen">IG</a><a id="f" href="#top">Top</a><a id="m" href="mailto:a@b.example">Mail</a><a id="h" href="https://shop.example/">Home</a>`,
    );
    const $ = cheerio.load(r.html);
    expect($("#p").attr("href")).toBe(`${PREFIX}/p/ring`);
    expect($("#p").attr("target")).toBeUndefined();
    expect($("#c").attr("href")).toBe("https://shop.example/collections/all?x=1");
    expect($("#c").attr("target")).toBe("_blank");
    expect($("#c").attr("rel")).toBe("noopener noreferrer nofollow");
    expect($("#e").attr("href")).toBe("https://ig.example/lumen");
    expect($("#e").attr("rel")).toBe("noopener noreferrer nofollow");
    expect($("#f").attr("href")).toBeUndefined();
    expect($("#m").attr("href")).toBeUndefined();
    expect($("#h").attr("href")).toBe(PREFIX);
  });

  it("turns forms into divs and buttons into inert type=button", () => {
    const $ = cheerio.load(sanitize(`<form class="newsletter" action="/subscribe" method="post"><label>Email</label><input name="email"><button>Join</button><button type="submit">Go</button></form>`).html);
    expect($("form").length).toBe(0);
    expect($("div.newsletter").length).toBe(1);
    expect($("div.newsletter").attr("action")).toBeUndefined();
    expect($("div.newsletter").attr("method")).toBe("post"); // harmless on a div
    expect($("button").map((_, b) => $(b).attr("type")).get()).toEqual(["button", "button"]);
    expect($("label").text()).toBe("Email");
  });

  it("promotes lazy-loaded images", () => {
    const $ = cheerio.load(sanitize(`<img class="lazy" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="//cdn.example/p_{width}x.jpg" data-srcset="//cdn.example/a.jpg 1x"><img data-lazy-src="/l.jpg">`).html);
    expect($("img").eq(0).attr("src")).toBe("https://cdn.example/p_800x.jpg");
    expect($("img").eq(0).attr("srcset")).toBe("https://cdn.example/a.jpg 1x");
    expect($("img").eq(1).attr("src")).toBe("https://shop.example/l.jpg");
  });

  it("drops long data-* attributes and keeps short ones", () => {
    const $ = cheerio.load(sanitize(`<div data-id="42" data-json='${"x".repeat(300)}'>x</div>`).html);
    expect($("div").attr("data-id")).toBe("42");
    expect($("div").attr("data-json")).toBeUndefined();
  });
});

describe("CSS and srcset helpers", () => {
  it("sanitizeCss drops dangerous blocks and absolutises url()", () => {
    expect(sanitizeCss("a{b:expression(alert(1))}", PAGE)).toBeNull();
    expect(sanitizeCss("a{b:url(\\6a avascript:x)}", PAGE)).toBeNull();
    expect(sanitizeCss("a{behavior : url(x.htc)}", PAGE)).toBeNull();
    expect(sanitizeCss("@font-face{src:url(f.woff2) format('woff2'),url(data:font/woff2;base64,AAA)}", PAGE)).toBe(`@font-face{src:url("https://shop.example/f.woff2") format('woff2'),url("data:font/woff2;base64,AAA")}`);
    expect(sanitizeCss("a{b:url(data:text/html,x)}", PAGE)).toBe(`a{b:url("data:,")}`);
    expect(sanitizeCss("a{b:url(ftp://x/y)}", PAGE)).toBe(`a{b:url("data:,")}`);
  });

  it("sanitizeSrcset parses candidates per the HTML spec (commas inside URLs)", () => {
    expect(sanitizeSrcset("https://img.example/w_300,h_300/a.jpg 300w, /b.jpg 600w", PAGE)).toBe("https://img.example/w_300,h_300/a.jpg 300w, https://shop.example/b.jpg 600w");
    expect(sanitizeSrcset("javascript:alert(1) 1x", PAGE)).toBeNull();
    // No whitespace: one candidate whose URL contains a comma (as browsers read it).
    expect(sanitizeSrcset("a.jpg,b.jpg 2x", PAGE)).toBe("https://shop.example/a.jpg,b.jpg 2x");
    expect(sanitizeSrcset("a.jpg 1x,b.jpg 2x", PAGE)).toBe("https://shop.example/a.jpg 1x, https://shop.example/b.jpg 2x");
  });
});

describe("assessSensitivePage", () => {
  const page = (body: string) => `<!doctype html><html><body>${body}</body></html>`;
  it("flags password fields, card/bank fields and payment wording", () => {
    expect(assessSensitivePage(page(`<form><input type="PASSWORD" name="p"></form>`))).toEqual({ sensitive: true, why: "password_field" });
    expect(assessSensitivePage(page(`<input autocomplete="cc-number">`))).toEqual({ sensitive: true, why: "payment_field" });
    expect(assessSensitivePage(page(`<input name="cvv">`))).toEqual({ sensitive: true, why: "payment_field" });
    expect(assessSensitivePage(page(`<p>Enter your card number and CVV</p>`))).toEqual({ sensitive: true, why: "payment_text" });
    expect(assessSensitivePage(page(`<h1>Sign in to your bank</h1>`))).toEqual({ sensitive: true, why: "payment_text" });
    expect(assessSensitivePage(page(`<p>Your IBAN: DE00 0000</p>`))).toEqual({ sensitive: true, why: "payment_text" });
    expect(assessSensitivePage(page(`<p>Sort code 00-00-00</p>`))).toEqual({ sensitive: true, why: "payment_text" });
  });
  it("lets a normal jewelry page through (a newsletter e-mail field, 'Log in' link, payment icons)", () => {
    expect(assessSensitivePage(page(`<a href="/account/login">Log in</a><input type="email" name="contact[email]"><p>We accept Visa, Mastercard and PayPal.</p><h2>Gold hoops</h2>`))).toEqual({ sensitive: false });
  });
});

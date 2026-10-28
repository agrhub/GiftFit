/**
 * Sanitizer for store-page snapshots (owner: A15; user decision "Chụp lại trang thật", which overrides
 * ADR-055's "never re-serve merchant pages" for the preview's look only). Server-only, pure.
 *
 * Input: the HTML of the merchant's home page or of one product page, fetched by SafeFetcher. Output: an
 * inert copy that keeps the page's markup and styling and nothing that runs or submits:
 *
 *   Parser   cheerio (already a dependency) with parse5, the WHATWG HTML parser, and the scripting flag
 *            OFF: the snapshot is shown in a sandboxed iframe without allow-scripts, where the browser
 *            also parses with scripting disabled, so both build the same tree (incl. <noscript>).
 *   Elements dropped with their content: script (any type, JSON-LD too), noscript, template, iframe,
 *            frame, frameset, object, embed, applet, portal, fencedframe, input, textarea, select,
 *            option, optgroup, datalist, keygen, video, audio, track, param, base, meta (ours are added),
 *            xmp, plaintext, noembed, noframes, link (except rel=stylesheet over https), every MathML
 *            element, and every SVG element outside a small drawing allow-list (so no SVG script,
 *            foreignObject, animate/set, style, feImage, ...). <form> becomes a <div> (layout kept,
 *            nothing to submit); every <button> becomes type="button". Comments, CDATA and processing
 *            instructions are dropped; <source> survives only inside <picture>.
 *   Attributes dropped: every on* handler; any value containing "<" (mutation-XSS through re-parsing);
 *            srcdoc, action, formaction and the other form* attributes, ping, attributionsrc, manifest,
 *            http-equiv, nonce, autofocus, contenteditable, download, target (links get ours),
 *            referrerpolicy, xml:base, sandbox, allow, csp, dynsrc, lowsrc, longdesc, codebase, data,
 *            crossorigin other than anonymous, data-* longer than 200 characters.
 *   URLs     resolved against the page URL exactly as a browser does (WHATWG URL: entities decoded by the
 *            parser, tabs/newlines removed, C0/space trimmed), so obfuscated "jav&#x09;ascript:" is
 *            caught. Resources (img/srcset/background/svg image/stylesheet/CSS url()) must end up https
 *            (http is upgraded) or data:image/*, data:font/* for CSS; anything else is removed. Every URL
 *            is written ABSOLUTE to the merchant's own server (images, CSS and fonts load from the
 *            merchant, never re-hosted by GiftFit); no <base> element is used, so our own links stay on
 *            our origin.
 *   Links    an <a>/<area> (and SVG <a>) to a product GiftFit shows → `linkFor()`'s internal path (the
 *            preview's snapshot product page, same frame); the store home → the snapshot home; every
 *            other http(s) link → the real absolute URL with target="_blank" rel="noopener noreferrer
 *            nofollow"; fragment-only, javascript:, vbscript:, data:, mailto:, tel: ... → no href.
 *            `linkFor` may also return `<internalPrefix>#<internalAnchor>` (a jump to GiftFit's strip).
 *   CSS      <style> blocks and style="" attributes are dropped whole when, after removing comments and
 *            CSS escapes, they mention expression(, -moz-binding, behavior:, javascript: or vbscript:;
 *            otherwise every url(...) and @import "..." is made absolute (same resource rules).
 *   Images   what a lazy-load script would have done, done statically (no script ever runs): a missing
 *            or placeholder src/srcset (empty, data: URI such as a 1x1 gif, blank.gif, spacer.gif,
 *            "placeholder") takes the first usable of data-src, data-lazy-src, data-original, data-lazy,
 *            data-original-src / data-srcset, data-lazy-srcset, data-original-set ({width} → 800),
 *            and those lazy attributes are then dropped;
 *            <picture><source data-srcset> likewise; data-bgset (widest candidate) / data-bg /
 *            data-background-image become an inline background-image when the element shows no real
 *            one; lazysizes classes (lazyload, lazyloading → lazyloaded; b-lazy → b-loaded) are swapped
 *            as the script would, so a store rule like `.lazyload{opacity:0}` no longer hides them. A
 *            <noscript> fallback image fills the scripted <img> next to it when that one has no usable
 *            source; the <noscript> itself is still dropped. Every candidate URL passes the resource
 *            rules above (srcset per candidate). loading="lazy" is kept (scripting is disabled in the
 *            sandboxed frame, where browsers load such images eagerly).
 *
 * Mutation XSS: the output is re-parsed and re-sanitized until it no longer changes (≤ 4 rounds); a page
 * that never stabilises is refused. The snapshot route adds a CSP without any script-src and the iframe
 * has no allow-scripts, so even a miss here cannot run code.
 */
import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";

const NS_HTML = "http://www.w3.org/1999/xhtml";
const NS_SVG = "http://www.w3.org/2000/svg";

/** Dropped with everything inside (HTML namespace). */
const DROP_HTML = new Set([
  "script",
  "noscript",
  "template",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "portal",
  "fencedframe",
  "input",
  "textarea",
  "select",
  "option",
  "optgroup",
  "datalist",
  "keygen",
  "video",
  "audio",
  "track",
  "param",
  "base",
  "basefont",
  "bgsound",
  "xmp",
  "plaintext",
  "noembed",
  "noframes",
  "math",
  "menuitem",
  "isindex",
]);

/** SVG drawing elements kept (case as parse5 reports it). Everything else in SVG is dropped. */
const SVG_ALLOWED = new Set([
  "svg",
  "g",
  "defs",
  "symbol",
  "use",
  "path",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "rect",
  "text",
  "tspan",
  "title",
  "desc",
  "lineargradient",
  "radialgradient",
  "stop",
  "clippath",
  "mask",
  "pattern",
  "image",
  "a",
  "marker",
]);

const DROP_ATTRS = new Set([
  "srcdoc",
  "action",
  "formaction",
  "formmethod",
  "formtarget",
  "formenctype",
  "formnovalidate",
  "form",
  "ping",
  "attributionsrc",
  "manifest",
  "http-equiv",
  "nonce",
  "autofocus",
  "contenteditable",
  "download",
  "target",
  "referrerpolicy",
  "xml:base",
  "sandbox",
  "allow",
  "csp",
  "dynsrc",
  "lowsrc",
  "longdesc",
  "codebase",
  "data",
  "cite",
  "poster",
  "imagesrcset",
  "imagesizes",
  "as",
  "rel",
  "integrity",
]);

const MAX_DATA_ATTR = 200;
export const LINK_REL = "noopener noreferrer nofollow";

/** The head we serve: fixed strings, kept by every round (so the output is a fixpoint). */
const OUR_META: { attrs: Record<string, string> }[] = [
  { attrs: { charset: "utf-8" } },
  { attrs: { name: "viewport", content: "width=device-width, initial-scale=1" } },
  { attrs: { name: "robots", content: "noindex, nofollow" } },
  { attrs: { name: "referrer", content: "no-referrer" } },
];

export interface SanitizeOptions {
  /** The page's own URL (after redirects): relative URLs resolve against it. */
  pageUrl: string;
  /**
   * Internal path for a link target (a product GiftFit shows, or the store home), else null. Receives the
   * absolute http(s) URL the browser would follow.
   */
  linkFor?: (absoluteUrl: URL) => string | null;
  /** Paths `linkFor` returns start with this; such hrefs are kept as they are on re-sanitizing. */
  internalPrefix?: string;
  /** An element id GiftFit adds to the page: `<internalPrefix>#<id>` is kept too (an in-page jump). */
  internalAnchor?: string;
}

export interface SanitizedPage {
  html: string;
  /** UTF-8 bytes of `html`. */
  bytes: number;
  /** Visible text characters in <body> (whitespace collapsed). */
  textChars: number;
  /** <img> and <picture> sources with a usable URL. */
  images: number;
  /** Rounds until the output stopped changing. */
  rounds: number;
}

export class SnapshotUnstableError extends Error {
  constructor() {
    super("the sanitized markup did not stabilise");
    this.name = "SnapshotUnstableError";
  }
}

// ---------------------------------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------------------------------

const DATA_IMAGE = /^data:image\/(png|gif|jpe?g|webp|avif|svg\+xml|x-icon|vnd\.microsoft\.icon|bmp)[;,]/i;
const DATA_FONT = /^data:(font\/[\w.+-]+|application\/(x-)?font[\w.+-]*|application\/vnd\.ms-fontobject)[;,]/i;

/** WHATWG resolution, as the browser does it (the parser already decoded entities). */
function resolve(raw: string, base: string): URL | null {
  try {
    return new URL(raw, base);
  } catch {
    return null;
  }
}

/** An image/stylesheet URL the snapshot may load: https (http upgraded), or a data: image when allowed. */
export function safeResourceUrl(raw: string | undefined, base: string, allowData: "image" | "font" | "none" = "image"): string | null {
  if (raw === undefined) return null;
  const u = resolve(raw, base);
  if (!u) return null;
  if (u.protocol === "data:") {
    const href = u.href;
    if (allowData === "image" && DATA_IMAGE.test(href)) return href;
    if (allowData === "font" && (DATA_FONT.test(href) || DATA_IMAGE.test(href))) return href;
    return null;
  }
  if (u.protocol === "http:") u.protocol = "https:";
  if (u.protocol !== "https:" || u.username || u.password) return null;
  return u.href;
}

/**
 * srcset per the HTML spec's candidate parsing (a URL is a run of non-whitespace; trailing commas end
 * it; descriptors run to the next comma outside parentheses). Each candidate URL must pass the resource
 * rules or the candidate is dropped.
 */
export function sanitizeSrcset(raw: string, base: string): string | null {
  const out = srcsetCandidates(raw, base).map((c) => (c.descriptor ? `${c.url} ${c.descriptor}` : c.url));
  return out.length ? out.join(", ") : null;
}

interface SrcsetCandidate {
  /** Absolute, passed the resource rules. */
  url: string;
  /** "800w", "2x", "300h" or "" (the other descriptors are dropped). */
  descriptor: string;
}

function srcsetCandidates(raw: string, base: string): SrcsetCandidate[] {
  const out: SrcsetCandidate[] = [];
  let i = 0;
  const s = raw;
  const ws = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";
  while (i < s.length) {
    while (i < s.length && (ws(s[i]) || s[i] === ",")) i++;
    if (i >= s.length) break;
    let start = i;
    while (i < s.length && !ws(s[i])) i++;
    let url = s.slice(start, i);
    let descriptor = "";
    if (url.endsWith(",")) {
      url = url.replace(/,+$/, "");
    } else {
      start = i;
      let depth = 0;
      while (i < s.length) {
        const c = s[i];
        if (c === "(") depth++;
        else if (c === ")") depth = Math.max(0, depth - 1);
        else if (c === "," && depth === 0) break;
        i++;
      }
      descriptor = s.slice(start, i).trim();
      i++; // skip the comma
    }
    const safe = safeResourceUrl(url, base, "image");
    if (!safe) continue;
    if (descriptor && !/^[\d.]+[wx]$|^[\d.]+h$/i.test(descriptor.replace(/\s+/g, " ").split(" ")[0])) descriptor = "";
    out.push({ url: safe, descriptor: descriptor ? descriptor.split(/\s+/)[0] : "" });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------------------------------

/** CSS escapes → characters (`\6a ` → "j", `\"` → `"`). */
function cssUnescape(s: string): string {
  return s.replace(/\\([0-9a-fA-F]{1,6})[ \t\n\r\f]?|\\([\s\S])/g, (_m, hex: string | undefined, ch: string | undefined) => {
    if (hex) {
      const cp = parseInt(hex, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "�";
    }
    return ch === "\n" ? "" : (ch ?? "");
  });
}

const CSS_DANGER = /expression\(|-moz-binding|behavior:|javascript:|vbscript:|-o-link|binding:/;

/** True when the CSS must be dropped whole. */
export function isDangerousCss(css: string): boolean {
  const flat = cssUnescape(css.replace(/\/\*[\s\S]*?(\*\/|$)/g, ""))
    .toLowerCase()
    .replace(/[\s\u0000-\u001f]+/g, "");
  return CSS_DANGER.test(flat);
}

const CSS_URL = /url\(\s*(?:"((?:[^"\\\n]|\\[\s\S])*)"|'((?:[^'\\\n]|\\[\s\S])*)'|((?:[^)"'\s\\]|\\[\s\S])*))\s*\)/gi;
const CSS_IMPORT_STRING = /@import\s+(?:"((?:[^"\\\n]|\\[\s\S])*)"|'((?:[^'\\\n]|\\[\s\S])*)')/gi;

/**
 * Sanitized CSS (urls absolute and safe), or null when it must be dropped. `base` is the URL the CSS
 * belongs to (the page for <style> and style="").
 */
export function sanitizeCss(css: string, base: string): string | null {
  if (isDangerousCss(css)) return null;
  const fix = (raw: string) => {
    const safe = safeResourceUrl(cssUnescape(raw).trim(), base, "font");
    return `url("${safe ?? "data:,"}")`;
  };
  const out = css
    .replace(CSS_IMPORT_STRING, (_m, d?: string, s?: string) => `@import ${fix(d ?? s ?? "")}`)
    .replace(CSS_URL, (_m, d?: string, s?: string, bare?: string) => fix(d ?? s ?? bare ?? ""));
  // Our own output must stay inside its <style> and never become dangerous after rewriting.
  if (/<\/style/i.test(out) || /<!--|-->/.test(out) || isDangerousCss(out)) return null;
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Tree walk
// ---------------------------------------------------------------------------------------------------

type $T = cheerio.CheerioAPI;

const isElement = (n: AnyNode): n is Element => n.type === "tag" || n.type === "script" || n.type === "style";

function ns(el: Element): string {
  return el.namespace ?? NS_HTML;
}

function removeNode(n: AnyNode): void {
  const parent = n.parent;
  if (!parent) return;
  const i = parent.children.indexOf(n as never);
  if (i >= 0) parent.children.splice(i, 1);
  if (n.prev) n.prev.next = n.next;
  if (n.next) n.next.prev = n.prev;
  n.parent = null;
  n.prev = null;
  n.next = null;
}

function setAttr(el: Element, name: string, value: string): void {
  el.attribs[name] = value;
}

function delAttr(el: Element, name: string): void {
  delete el.attribs[name];
  const nsMap = el["x-attribsNamespace"];
  const prefixMap = el["x-attribsPrefix"];
  if (nsMap) delete nsMap[name];
  if (prefixMap) delete prefixMap[name];
}

interface Ctx {
  base: string;
  linkFor?: (u: URL) => string | null;
  internalRe: RegExp | null;
  internalPrefix?: string;
}

function isOurMeta(el: Element): boolean {
  const names = Object.keys(el.attribs);
  return OUR_META.some((m) => {
    const keys = Object.keys(m.attrs);
    return keys.length === names.length && keys.every((k) => el.attribs[k] === m.attrs[k]);
  });
}

function sanitizeLink(el: Element, ctx: Ctx): void {
  const hrefName = el.attribs.href !== undefined ? "href" : el.attribs["xlink:href"] !== undefined ? "xlink:href" : null;
  delAttr(el, "target");
  delAttr(el, "rel");
  if (!hrefName) return;
  const raw = el.attribs[hrefName];
  delAttr(el, "href");
  delAttr(el, "xlink:href");
  const trimmed = raw.replace(/^[\u0000- ]+|[\u0000- ]+$/g, "");
  if (!trimmed || trimmed.startsWith("#")) return; // fragment-only: would leave the frame (no <base>), so inert
  if (ctx.internalRe && ctx.internalRe.test(trimmed)) {
    setAttr(el, "href", trimmed);
    return;
  }
  const u = resolve(raw, ctx.base);
  if (!u || (u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password) return;
  const internal = ctx.linkFor?.(u) ?? null;
  if (internal) {
    setAttr(el, "href", internal);
    return;
  }
  setAttr(el, "href", u.href);
  setAttr(el, "target", "_blank");
  setAttr(el, "rel", LINK_REL);
}

// ---------------------------------------------------------------------------------------------------
// Lazy-loaded images, filled without running any script
// ---------------------------------------------------------------------------------------------------

/** Where lazy-load scripts keep the real image until they run (first usable one wins). */
const LAZY_SRC = ["data-src", "data-lazy-src", "data-original", "data-lazy", "data-original-src"];
const LAZY_SRCSET = ["data-srcset", "data-lazy-srcset", "data-original-set"];
const LAZY_BG = ["data-bg", "data-background-image", "data-bg-src"];
/** Dropped once used (no script will ever read them). */
const LAZY_ATTRS = [...LAZY_SRC, ...LAZY_SRCSET, ...LAZY_BG, "data-bgset"];
/** Width put into Shopify-style "{width}" image URL templates. */
export const LAZY_IMAGE_WIDTH = 800;
/** Classes a lazy-load script swaps once the image is in (the store's CSS often hides the "before" one). */
const LAZY_CLASS_DONE: Record<string, string> = { lazyload: "lazyloaded", lazyloading: "lazyloaded", "b-lazy": "b-loaded" };

const widen = (v: string) => v.replace(/\{width\}|%7Bwidth%7D/gi, String(LAZY_IMAGE_WIDTH));

const PLACEHOLDER_FILE = /^(?:blank|spacer|pixel|transparent|placeholder|lazy|lazyload|loading|loader|empty|grey|gray|1x1|px)(?:[-_.]?(?:\d+x\d+|\d+|px|pixel|image|img|white))?\.(?:gif|png|svg|jpe?g|webp)$/i;

/** A src that only holds the place of the real image: missing, empty, a data: URI (1x1 gif, blurred preview), blank.gif, ... */
export function isPlaceholderSrc(v: string | undefined): boolean {
  if (v === undefined) return true;
  const s = v.trim();
  if (!s || /^(data|about):/i.test(s) || /placeholder/i.test(s)) return true;
  const file = s.split(/[?#]/)[0].split("/").pop() ?? "";
  return PLACEHOLDER_FILE.test(file);
}

const usableSrc = (v: string | undefined, base: string) => !isPlaceholderSrc(v) && safeResourceUrl(v, base, "image") !== null;
const usableSrcset = (v: string | undefined, base: string) => v !== undefined && srcsetCandidates(v, base).some((c) => !isPlaceholderSrc(c.url));

function lazySrc(a: Record<string, string>, base: string): string | null {
  for (const n of LAZY_SRC) {
    const v = a[n];
    if (v === undefined) continue;
    const u = safeResourceUrl(widen(v).trim(), base, "image");
    if (u && !isPlaceholderSrc(u)) return u;
  }
  return null;
}

function lazySrcset(a: Record<string, string>, base: string): string | null {
  for (const n of LAZY_SRCSET) {
    const v = a[n];
    if (v === undefined) continue;
    const set = sanitizeSrcset(widen(v), base);
    if (set && usableSrcset(set, base)) return set;
  }
  return null;
}

/**
 * <img>/<source>: a placeholder src/srcset is replaced by the real one a lazy-load script would have
 * set (every candidate validated by the resource rules). A placeholder-only srcset that would hide a real
 * src is removed.
 */
function promoteLazy(el: Element, base: string): void {
  const a = el.attribs;
  const isImg = el.name.toLowerCase() === "img";
  const real = lazySrc(a, base);
  if (isImg && real && !usableSrc(a.src, base)) a.src = real;
  if (!usableSrcset(a.srcset, base)) {
    const set = lazySrcset(a, base) ?? (isImg ? null : real); // <source data-src> → srcset
    if (set) a.srcset = set;
    else if (a.srcset !== undefined && (!isImg || usableSrc(a.src, base))) delAttr(el, "srcset");
  }
}

const imgUsable = (el: Element, base: string) => usableSrc(el.attribs.src, base) || usableSrcset(el.attribs.srcset, base);

/** lazysizes "lazyload" → "lazyloaded" (what its script does), so `.lazyload{opacity:0}` no longer hides it. */
function markLoaded(el: Element): void {
  const cls = el.attribs.class;
  if (!cls) return;
  const list = cls.split(/[ \t\n\r\f]+/).filter(Boolean);
  if (!list.some((c) => LAZY_CLASS_DONE[c.toLowerCase()])) return;
  const out: string[] = [];
  for (const c of list) {
    const v = LAZY_CLASS_DONE[c.toLowerCase()] ?? c;
    if (!out.includes(v)) out.push(v);
  }
  setAttr(el, "class", out.join(" "));
}

/** Only characters that can sit inside url("…") without any escaping. */
const CSS_PLAIN_URL = /^[^\s"'()\\<>]+$/;

/** The real background a lazy-load script would set (data-bgset: the widest candidate), or null. */
function lazyBackground(a: Record<string, string>, base: string): string | null {
  const bgset = a["data-bgset"];
  if (bgset) {
    let best: { url: string; w: number } | null = null;
    for (const part of widen(bgset).split("|")) {
      for (const c of srcsetCandidates(part.replace(/\[[^\]]*\]/g, " "), base)) {
        if (isPlaceholderSrc(c.url)) continue;
        const w = /^(\d+(?:\.\d+)?)w$/i.exec(c.descriptor);
        const width = w ? Number(w[1]) : 0;
        if (!best || width > best.w || (width === 0 && best.w === 0)) best = { url: c.url, w: width };
      }
    }
    if (best && CSS_PLAIN_URL.test(best.url)) return best.url;
  }
  for (const n of LAZY_BG) {
    const v = a[n];
    if (v === undefined) continue;
    const raw = widen(v)
      .trim()
      .replace(/^url\(\s*(["']?)(.*?)\1\s*\)$/i, "$2");
    const u = safeResourceUrl(raw, base, "image");
    if (u && !isPlaceholderSrc(u) && CSS_PLAIN_URL.test(u)) return u;
  }
  return null;
}

/** Adds the lazy background to an already-sanitized style="" unless it already shows a real image. */
function applyBackground(el: Element, url: string): void {
  const style = el.attribs.style ?? "";
  if (/url\(\s*["']?\s*(?!data:)[^\s)"']/i.test(style)) return;
  const decl = `background-image:url("${url}")`;
  setAttr(el, "style", style.trim() ? `${style.trim().replace(/;+$/, "")};${decl}` : decl);
}

/** Size or style of a tracking pixel: never promoted out of <noscript>. */
const isTinyImg = (el: Element) =>
  ["width", "height"].some((k) => /^\s*[01](px)?\s*$/i.test(el.attribs[k] ?? "")) || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(el.attribs.style ?? "");

const isHtmlImg = (n: AnyNode): n is Element => isElement(n) && n.name.toLowerCase() === "img" && ns(n) === NS_HTML;

function imgsIn(el: Element, out: Element[] = []): Element[] {
  for (const c of el.children) {
    if (!isElement(c) || c.name.toLowerCase() === "noscript") continue;
    if (isHtmlImg(c)) out.push(c);
    else imgsIn(c, out);
  }
  return out;
}

/** The scripted <img> a <noscript> stands in for: the previous sibling (or its only image), the next sibling, or the <picture>'s image. */
function scriptedImgFor(n: Element): Element | null {
  let prev = n.prev;
  while (prev && !isElement(prev)) prev = prev.prev;
  if (prev && isElement(prev) && prev.name.toLowerCase() !== "noscript") {
    if (isHtmlImg(prev)) return prev;
    const inside = imgsIn(prev);
    if (inside.length === 1) return inside[0];
  }
  let next = n.next;
  while (next && !isElement(next)) next = next.next;
  if (next && isHtmlImg(next)) return next;
  const parent = n.parent;
  if (parent && isElement(parent) && parent.name.toLowerCase() === "picture") {
    const inside = imgsIn(parent);
    if (inside.length === 1) return inside[0];
  }
  return null;
}

/**
 * <noscript><img src=real></noscript> after a scripted <img> without a usable source: the scripted image
 * takes the fallback's src/srcset/alt. The <noscript> itself is always dropped later by the walk, so
 * nothing else of its markup is ever rendered (and an image with no scripted counterpart is not promoted).
 */
function promoteNoscriptImages($: $T, base: string): void {
  $("noscript").each((_, node) => {
    const n = node as Element;
    if (ns(n) !== NS_HTML) return;
    const fallback = $(n)
      .find("img")
      .toArray()
      .find((img): img is Element => {
        if (!isHtmlImg(img) || isTinyImg(img)) return false;
        promoteLazy(img, base);
        return imgUsable(img, base);
      });
    if (!fallback) return;
    const target = scriptedImgFor(n);
    if (!target) return;
    promoteLazy(target, base);
    const picture = target.parent && isElement(target.parent) && target.parent.name.toLowerCase() === "picture" ? target.parent : null;
    const pictureUsable = picture?.children.some((c) => isElement(c) && c.name.toLowerCase() === "source" && usableSrcset(c.attribs.srcset, base)) ?? false;
    if (imgUsable(target, base) || pictureUsable) return;
    const f = fallback.attribs;
    if (usableSrc(f.src, base)) setAttr(target, "src", f.src);
    if (usableSrcset(f.srcset, base)) {
      setAttr(target, "srcset", f.srcset);
      if (f.sizes !== undefined) setAttr(target, "sizes", f.sizes);
    } else if (target.attribs.srcset !== undefined) {
      delAttr(target, "srcset");
    }
    if (target.attribs.alt === undefined && f.alt !== undefined) setAttr(target, "alt", f.alt);
  });
}

/** Generic attribute pass; returns nothing (mutates). URL attributes of specific elements are handled by the caller first. */
function sanitizeAttrs(el: Element, ctx: Ctx, handled: Set<string>): void {
  for (const name of Object.keys(el.attribs)) {
    if (handled.has(name)) continue;
    const lname = name.toLowerCase();
    const value = el.attribs[name];
    if (lname.startsWith("on") || value.includes("<") || DROP_ATTRS.has(lname) || (lname.startsWith("xmlns:") && lname !== "xmlns:xlink")) {
      delAttr(el, name);
      continue;
    }
    if (lname.startsWith("data-") && value.length > MAX_DATA_ATTR) {
      delAttr(el, name);
      continue;
    }
    if (lname === "style") {
      const css = sanitizeCss(value, ctx.base);
      if (css === null) delAttr(el, name);
      else setAttr(el, name, css);
      continue;
    }
    if (lname === "crossorigin") {
      if (value !== "" && value.toLowerCase() !== "anonymous") delAttr(el, name);
      continue;
    }
    if (lname === "srcset") {
      const v = sanitizeSrcset(value, ctx.base);
      if (v) setAttr(el, name, v);
      else delAttr(el, name);
      continue;
    }
    if (lname === "src" || lname === "background" || lname === "href" || lname === "xlink:href") {
      // An empty src loads nothing; resolved, it would fetch the page itself as an image.
      const v = value.trim() ? safeResourceUrl(value, ctx.base, "image") : null;
      if (v) setAttr(el, name, v);
      else delAttr(el, name);
      continue;
    }
  }
}

function walk($: $T, parent: AnyNode, ctx: Ctx): void {
  const kids = "children" in parent ? [...(parent as Element).children] : [];
  for (const n of kids) {
    if (n.type === "text") continue;
    if (!isElement(n)) {
      // comments, CDATA, processing instructions, stray doctypes
      removeNode(n);
      continue;
    }
    const el = n;
    const space = ns(el);
    const name = el.name.toLowerCase();
    if (space !== NS_HTML && space !== NS_SVG) {
      removeNode(el); // MathML and anything else foreign
      continue;
    }
    if (space === NS_SVG) {
      if (!SVG_ALLOWED.has(name)) {
        removeNode(el);
        continue;
      }
      const handled = new Set<string>();
      if (name === "a") {
        sanitizeLink(el, ctx);
        handled.add("href").add("target").add("rel");
      } else {
        for (const h of ["href", "xlink:href"]) {
          const v = el.attribs[h];
          if (v === undefined) continue;
          handled.add(h);
          if (name === "image") {
            const safe = safeResourceUrl(v, ctx.base, "image");
            if (safe) setAttr(el, h, safe);
            else delAttr(el, h);
          } else if (!/^#[\w:.-]+$/.test(v.trim())) {
            delAttr(el, h); // <use>, gradients, patterns: same-document references only
          }
        }
      }
      sanitizeAttrs(el, ctx, handled);
      walk($, el, ctx);
      continue;
    }

    // HTML namespace
    if (DROP_HTML.has(name)) {
      removeNode(el);
      continue;
    }
    if (name === "meta") {
      if (!isOurMeta(el)) removeNode(el);
      continue;
    }
    if (name === "link") {
      const rel = (el.attribs.rel ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const href = rel.length === 1 && rel[0] === "stylesheet" ? safeResourceUrl(el.attribs.href, ctx.base, "none") : null;
      if (!href) {
        removeNode(el);
        continue;
      }
      const media = el.attribs.media;
      const cross = el.attribs.crossorigin;
      for (const k of Object.keys(el.attribs)) delAttr(el, k);
      setAttr(el, "rel", "stylesheet");
      setAttr(el, "href", href);
      if (media && !media.includes("<")) setAttr(el, "media", media);
      if (cross !== undefined && (cross === "" || cross.toLowerCase() === "anonymous")) setAttr(el, "crossorigin", "anonymous");
      continue;
    }
    if (name === "style") {
      const text = el.children.map((c) => (c.type === "text" ? (c as unknown as { data: string }).data : "")).join("");
      const css = sanitizeCss(text, ctx.base);
      if (css === null || el.children.some((c) => c.type !== "text")) {
        removeNode(el);
        continue;
      }
      const media = el.attribs.media;
      for (const k of Object.keys(el.attribs)) delAttr(el, k);
      if (media && !media.includes("<")) setAttr(el, "media", media);
      $(el).text(css);
      continue;
    }
    if (name === "source" && (el.parent as Element | null)?.name !== "picture") {
      removeNode(el);
      continue;
    }
    if (name === "form") el.name = "div";
    if (name === "button") {
      setAttr(el, "type", "button");
    }
    const handled = new Set<string>();
    if (name === "a" || name === "area") {
      sanitizeLink(el, ctx);
      handled.add("href").add("target").add("rel");
    }
    let background: string | null = null;
    if (name === "img" || name === "source") {
      promoteLazy(el, ctx.base);
      if (imgUsable(el, ctx.base)) markLoaded(el);
    } else {
      background = lazyBackground(el.attribs, ctx.base); // read before long data-* are dropped
    }
    if (name === "button") handled.add("type");
    sanitizeAttrs(el, ctx, handled);
    if (background) {
      applyBackground(el, background);
      markLoaded(el);
    }
    for (const k of LAZY_ATTRS) if (el.attribs[k] !== undefined) delAttr(el, k); // used above; nothing else reads them
    walk($, el, ctx);
  }
}

/** Makes sure <head> starts with exactly our <meta> set (other metas were dropped by the walk). */
function ensureHead($: $T): void {
  const head = $("head").first();
  if (!head.length) return;
  head.children("meta").remove();
  const tags = OUR_META.map((m) => `<meta ${Object.entries(m.attrs).map(([k, v]) => `${k}="${v}"`).join(" ")}>`).join("");
  head.prepend(tags);
}

function load(html: string): $T {
  return cheerio.load(html, { scriptingEnabled: false });
}

function serialize($: $T): string {
  const htmlEl = $("html").first();
  return `<!DOCTYPE html>${$.html(htmlEl)}`;
}

function onePass(html: string, ctx: Ctx): string {
  const $ = load(html);
  promoteNoscriptImages($, ctx.base);
  walk($, $.root()[0], ctx);
  ensureHead($);
  return serialize($);
}

function measure(html: string): { textChars: number; images: number } {
  const $ = load(html);
  const body = $("body");
  body.find("style, title").remove();
  const textChars = body.text().replace(/\s+/g, " ").trim().length;
  const images = $("img[src], img[srcset], picture source[srcset]").length;
  return { textChars, images };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const MAX_SANITIZE_ROUNDS = 4;

/** Sanitizes a fetched page. Throws SnapshotUnstableError when the output never stabilises. */
export function sanitizeSnapshotHtml(html: string, opts: SanitizeOptions): SanitizedPage {
  const ctx: Ctx = {
    base: opts.pageUrl,
    linkFor: opts.linkFor,
    internalPrefix: opts.internalPrefix,
    internalRe: opts.internalPrefix
      ? new RegExp(`^${escapeRe(opts.internalPrefix)}(?:/p/[A-Za-z0-9%._~-]+${opts.internalAnchor && /^[A-Za-z][\w-]*$/.test(opts.internalAnchor) ? `|#${opts.internalAnchor}` : ""})?$`)
      : null,
  };
  let prev = onePass(html, ctx);
  for (let round = 2; round <= MAX_SANITIZE_ROUNDS; round++) {
    const next = onePass(prev, ctx);
    if (next === prev) {
      const m = measure(next);
      return { html: next, bytes: Buffer.byteLength(next, "utf8"), ...m, rounds: round };
    }
    prev = next;
  }
  throw new SnapshotUnstableError();
}

// ---------------------------------------------------------------------------------------------------
// Pages we refuse to copy
// ---------------------------------------------------------------------------------------------------

const PAYMENT_TEXT =
  /\b(card ?number|credit card number|debit card number|cvv2?|cvc2?|card security code|card verification|\biban\b|sort code|routing number|bank account number|sign in to (your|online) bank|log ?in to (your|online) bank|online banking|one[- ]time passcode)\b/i;
const PAYMENT_FIELD = /^(cc-|card|cvv|cvc|iban|sortcode|sort_code|routing|account.?number|pan$)/i;

export type SensitiveVerdict = { sensitive: false } | { sensitive: true; why: "password_field" | "payment_field" | "payment_text" };

/**
 * Login / payment / banking look, judged on the RAW page (before anything is stripped): any password
 * field, any card/bank field (autocomplete cc-*, name/id like card/cvv/iban), or payment wording in the
 * visible text.
 */
export function assessSensitivePage(html: string): SensitiveVerdict {
  const $ = load(html);
  if ($('input[type="password" i]').length) return { sensitive: true, why: "password_field" };
  let field = false;
  $("input, select, textarea").each((_, el) => {
    if (field) return;
    const a = (el as Element).attribs;
    for (const v of [a.autocomplete, a.name, a.id]) if (v && PAYMENT_FIELD.test(v.trim())) field = true;
  });
  if (field) return { sensitive: true, why: "payment_field" };
  const body = $("body").clone();
  body.find("script, style, noscript, template").remove();
  const text = body.text().replace(/\s+/g, " ");
  if (PAYMENT_TEXT.test(text)) return { sensitive: true, why: "payment_text" };
  return { sensitive: false };
}

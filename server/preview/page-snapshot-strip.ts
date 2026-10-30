/**
 * "In this preview · GiftFit" strip for store-page snapshots (owner: A19). Server-only, pure.
 *
 * Some store home pages build their product carousels with JavaScript, so the copied HTML has no link to
 * any product GiftFit ingested and a shopper in the preview can't reach our product pages. For such a
 * page (a captured page with zero links mapped to ingested products; never a product page) the snapshot
 * gets ONE clearly GiftFit-labelled strip, deliberately not styled like the store: a box in GiftFit's dark
 * design (night background, gradient "GiftFit" badge; product photos on white), listing up to MAX_STRIP_PRODUCTS ingested products (image, title, price as frozen at
 * ingest), each linking to /s/<key>/snapshot/p/<id>, horizontally scrollable on phones.
 *
 *   Where   at the top of the page's first <main> (or [role=main]); without one, right after the first
 *           <header>; else at the top of <body>.
 *   Styles  one <style> inside the strip, every selector scoped by the strip's id (and `gfpv-` classes),
 *           starting with `all: revert`, so the store's CSS can't restyle it and it can't touch the
 *           store's layout. No script; images are https only and pass the snapshot's resource rules.
 *   Safety  the page with the strip is sanitized again like any snapshot (fixpoint), so the strip is
 *           held to the same rules as the store's own markup.
 *
 * Collection links whose path names a category of the ingested products (/collections/earrings, ...,
 * in the ten widget languages' common slugs) may jump to the strip (`#giftfit-preview-products`).
 *
 * Language: capture has no viewer, so the strip is stored in English; serving localizes it for the
 * viewer (`localizePreviewStrip`, A26) by its own markers (the strip's id + data-giftfit, `.gfpv-label`,
 * `.gfpv-note`, aria-label). Strips stored before A26 carry the same markers, so they are localized too.
 */
import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import type { JewelryCategory } from "@/server/contracts/giftfit";
import type { Locale } from "@/server/i18n";
import { safeResourceUrl } from "./page-snapshot-sanitize";
import type { PreviewProduct } from "./types";

export const PREVIEW_STRIP_ID = "giftfit-preview-products";
export const MAX_STRIP_PRODUCTS = 8;
/** The strip's words per UI locale ("GiftFit" is the brand: never translated). Capture stores English. */
export const STRIP_TEXT: Readonly<Record<Locale, { label: string; note: string }>> = {
  en: { label: "In this preview", note: "Pieces GiftFit found on this store. Open one to see it in the preview." },
  vi: { label: "Trong bản xem trước này", note: "Những món GiftFit tìm thấy ở cửa hàng này. Mở một món để xem trong bản xem trước." },
  ja: { label: "このプレビューの商品", note: "GiftFit がこのストアで見つけたアイテムです。開くとプレビューで表示されます。" },
  ko: { label: "이 미리보기의 상품", note: "GiftFit이 이 스토어에서 찾은 상품이에요. 하나를 열면 미리보기에서 볼 수 있어요." },
  zh: { label: "本预览中的商品", note: "GiftFit 在这家店找到的单品。打开任意一件，即可在预览中查看。" },
  th: { label: "ในตัวอย่างนี้", note: "ชิ้นงานที่ GiftFit พบในร้านนี้ เปิดชิ้นใดก็ได้เพื่อดูในตัวอย่าง" },
  id: { label: "Di pratinjau ini", note: "Produk yang ditemukan GiftFit di toko ini. Buka salah satunya untuk melihatnya di pratinjau." },
  es: { label: "En esta vista previa", note: "Piezas que GiftFit encontró en esta tienda. Abre una para verla en la vista previa." },
  fr: { label: "Dans cet aperçu", note: "Les pièces que GiftFit a trouvées dans cette boutique. Ouvrez-en une pour la voir dans l’aperçu." },
  de: { label: "In dieser Vorschau", note: "Stücke, die GiftFit in diesem Shop gefunden hat. Öffne eines, um es in der Vorschau zu sehen." },
};
export const STRIP_LABEL = STRIP_TEXT.en.label;
const stripAria = (locale: Locale) => `${STRIP_TEXT[locale].label} · GiftFit`;
const MAX_TITLE = 120;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function money(price: number | null, currency: string | null): string | null {
  if (price === null || !currency) return null;
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).format(price);
  } catch {
    return `${price.toFixed(2)} ${currency}`;
  }
}

/** The first image published over https that passes the snapshot's resource rules (no http upgrade here). */
function stripImage(p: Pick<PreviewProduct, "images">): string | null {
  for (const u of p.images) {
    if (!u.startsWith("https://")) continue;
    const safe = safeResourceUrl(u, u, "none");
    if (safe && /^[^\s"'<>\\]+$/.test(safe)) return safe;
  }
  return null;
}

const S = `#${PREVIEW_STRIP_ID}`;
/** Scoped by id: the store's CSS can't reach in (all: revert), and nothing here reaches out. */
export const STRIP_CSS = [
  `${S},${S} *{all:revert;box-sizing:border-box}`,
  `${S}{display:block;position:relative;z-index:1;clear:both;float:none;width:calc(100% - 32px);max-width:1200px;margin:16px auto;padding:12px 16px 14px;border:1px solid #36415a;border-radius:16px;background:#0e121b;color:#eef1f7;font:14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;text-align:start;overflow:hidden}`,
  `${S} .gfpv-head{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin:0;font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#b8c0d0}`,
  `${S} .gfpv-brand{display:inline-block;padding:1px 8px;border-radius:999px;background:linear-gradient(90deg,#f6cf86,#f29ab6,#aa9cff);color:#090b11;letter-spacing:.02em;text-transform:none}`,
  `${S} .gfpv-note{margin:4px 0 10px;font-size:12px;color:#b8c0d0}`,
  `${S} .gfpv-row{display:flex;gap:12px;margin:0;padding:0 0 6px;overflow-x:auto;scroll-snap-type:x proximity}`,
  `${S} .gfpv-card{display:flex;flex:0 0 136px;flex-direction:column;gap:4px;width:136px;min-width:0;color:inherit;text-decoration:none;scroll-snap-align:start}`,
  `${S} .gfpv-media{display:block;width:100%;aspect-ratio:1/1;border-radius:8px;overflow:hidden;background:#fff}`,
  `${S} .gfpv-img{display:block;width:100%;height:100%;max-width:none;margin:0;border:0;object-fit:cover}`,
  `${S} .gfpv-title{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-clamp:2;max-height:2.6em;overflow:hidden;overflow-wrap:anywhere;word-break:break-word;font-size:13px;line-height:1.3}`,
  `${S} .gfpv-price{display:block;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:13px;font-weight:600}`,
  `${S} .gfpv-card:hover .gfpv-title,${S} .gfpv-card:focus-visible .gfpv-title{text-decoration:underline}`,
  `${S} .gfpv-card:focus-visible{outline:2px solid #f6cf86;outline-offset:2px}`,
  `@media (min-width:720px){${S} .gfpv-card{flex-basis:160px;width:160px}}`,
].join("\n");

/**
 * Up to MAX_STRIP_PRODUCTS products: jewelry first, taking the categories in turn (so a category link
 * that jumps to the strip finds its pieces there), store order within a category; then the rest.
 */
export function stripProducts<P extends Pick<PreviewProduct, "category">>(products: readonly P[]): P[] {
  const groups = new Map<string, P[]>();
  for (const p of products) if (p.category !== null) groups.set(p.category, [...(groups.get(p.category) ?? []), p]);
  const out: P[] = [];
  for (let i = 0; out.length < MAX_STRIP_PRODUCTS && [...groups.values()].some((g) => i < g.length); i++) {
    for (const g of groups.values()) if (i < g.length && out.length < MAX_STRIP_PRODUCTS) out.push(g[i]);
  }
  for (const p of products) if (p.category === null && out.length < MAX_STRIP_PRODUCTS) out.push(p);
  return out;
}

/** The strip's markup (sanitized again with the page). `productPath` gives /s/<key>/snapshot/p/<id>. */
export function previewStripHtml(products: readonly PreviewProduct[], productPath: (id: string) => string): string | null {
  const shown = stripProducts(products);
  if (!shown.length) return null;
  const cards = shown.map((p) => {
    const img = stripImage(p);
    const title = p.title.length > MAX_TITLE ? `${p.title.slice(0, MAX_TITLE - 1)}…` : p.title;
    const price = money(p.price, p.currency);
    return (
      `<a class="gfpv-card" href="${esc(productPath(p.id))}" data-giftfit-product="${esc(p.id)}">` +
      `<span class="gfpv-media">${img ? `<img class="gfpv-img" src="${esc(img)}" alt="" loading="lazy">` : ""}</span>` +
      `<span class="gfpv-title">${esc(title)}</span>${price ? `<span class="gfpv-price">${esc(price)}</span>` : ""}</a>`
    );
  });
  return (
    `<section id="${PREVIEW_STRIP_ID}" class="gfpv" data-giftfit="preview-strip" lang="en" aria-label="${esc(stripAria("en"))}">` +
    `<style>${STRIP_CSS}</style>` +
    `<p class="gfpv-head"><span class="gfpv-label">${esc(STRIP_TEXT.en.label)}</span><span aria-hidden="true">·</span><span class="gfpv-brand">GiftFit</span></p>` +
    `<p class="gfpv-note">${esc(STRIP_TEXT.en.note)}</p>` +
    `<div class="gfpv-row">${cards.join("")}</div></section>`
  );
}

const isLive = (el: Element) => {
  for (let p = el.parent; p; p = p.parent) if (p.type === "tag" && ["template", "noscript"].includes((p as Element).name)) return false;
  return true;
};

/** `html` with the strip inserted (see the header for where), or null when the page has no <body>. */
export function insertPreviewStrip(html: string, strip: string): string | null {
  const $ = cheerio.load(html, { scriptingEnabled: false });
  const body = $("body").first();
  if (!body.length) return null;
  const main = $('main, [role="main"]')
    .toArray()
    .find((e) => isLive(e as Element));
  if (main) $(main).prepend(strip);
  else {
    const header = $("body header")
      .toArray()
      .find((e) => isLive(e as Element));
    if (header) $(header).after(strip);
    else body.prepend(strip);
  }
  return `<!DOCTYPE html>${$.html($("html").first())}`;
}

/** Removes the strip cards of products the owner removed from the preview (and an emptied strip). */
export function withoutStripProducts(html: string, removedIds: readonly string[]): string {
  if (!removedIds.length || !html.includes("data-giftfit-product")) return html;
  const removed = new Set(removedIds);
  const $ = cheerio.load(html, { scriptingEnabled: false });
  const strip = $(`#${PREVIEW_STRIP_ID}`);
  let changed = false;
  strip.find("[data-giftfit-product]").each((_, el) => {
    if (removed.has((el as Element).attribs["data-giftfit-product"])) {
      $(el).remove();
      changed = true;
    }
  });
  if (!changed) return html;
  if (!strip.find("[data-giftfit-product]").length) strip.remove();
  return `<!DOCTYPE html>${$.html($("html").first())}`;
}

/**
 * The served home page with the GiftFit strip in the viewer's language (A26): label, note and aria-label
 * swapped, `lang` set. The strip is found by its markers (id + data-giftfit="preview-strip", then
 * `.gfpv-label` / `.gfpv-note` inside it), so English strips stored before A26 (no `lang`) are localized
 * as well. English, or a page without the strip, is returned as is. The result stays a sanitizer fixpoint.
 */
export function localizePreviewStrip(html: string, locale: Locale): string {
  if (locale === "en" || !html.includes(PREVIEW_STRIP_ID)) return html;
  const $ = cheerio.load(html, { scriptingEnabled: false });
  const strip = $(`section#${PREVIEW_STRIP_ID}[data-giftfit="preview-strip"]`).first();
  if (!strip.length) return html;
  const text = STRIP_TEXT[locale];
  strip.attr("lang", locale).attr("aria-label", stripAria(locale));
  strip.find(".gfpv-label").first().text(text.label);
  strip.find(".gfpv-note").first().text(text.note);
  return `<!DOCTYPE html>${$.html($("html").first())}`;
}

// ---------------------------------------------------------------------------------------------------
// Category collections
// ---------------------------------------------------------------------------------------------------

/** Common collection slugs per category (en, de, es, fr, id, ja, ko, th, vi, zh); ASCII ones diacritic-free. */
const CATEGORY_WORDS: Record<JewelryCategory, string[]> = {
  earring: ["earring", "earrings", "ear-rings", "studs", "hoops", "ohrring", "ohrringe", "ohrstecker", "pendientes", "aretes", "boucles-d-oreilles", "boucles-doreilles", "anting", "anting-anting", "bong-tai", "イヤリング", "ピアス", "耳环", "耳環", "귀걸이", "ต่างหู"],
  necklace: ["necklace", "necklaces", "pendant", "pendants", "halskette", "halsketten", "ketten", "collares", "collar", "colliers", "collier", "kalung", "day-chuyen", "ネックレス", "项链", "項鍊", "목걸이", "สร้อยคอ"],
  ring: ["ring", "rings", "ringe", "anillos", "anillo", "bagues", "bague", "cincin", "nhan", "指輪", "リング", "戒指", "반지", "แหวน"],
  bracelet: ["bracelet", "bracelets", "bangle", "bangles", "cuffs", "armband", "armbander", "armbaender", "pulseras", "pulsera", "gelang", "vong-tay", "ブレスレット", "手链", "手鍊", "팔찌", "สร้อยข้อมือ"],
  watch: ["watch", "watches", "uhren", "uhr", "relojes", "reloj", "montres", "montre", "jam-tangan", "dong-ho", "腕時計", "手表", "手錶", "시계", "นาฬิกา"],
};
const COLLECTION_SEGMENTS = new Set(["collections", "collection", "product-category", "category", "categories"]);
const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/[\s_+]+/g, "-");

/**
 * The jewelry category a collection path names ("/en/collections/gold-earrings" → "earring"), or null.
 * `path` is decoded and lower-case; only a collection's own page counts (nothing after its slug).
 */
export function collectionCategory(path: string): JewelryCategory | null {
  const segs = path.replace(/\/+$/, "").split("/");
  const i = segs.findIndex((s) => COLLECTION_SEGMENTS.has(s));
  if (i < 0 || i !== segs.length - 2) return null;
  const slug = `-${fold(segs[i + 1])}-`;
  const raw = segs[i + 1].normalize("NFC"); // CJK/Thai words compare unfolded (NFD splits kana marks)
  // Bracelet before necklace: "สร้อยข้อมือ" (bracelet) and "สร้อยคอ" (necklace) share a prefix.
  for (const cat of ["bracelet", "earring", "necklace", "ring", "watch"] as const) {
    for (const w of CATEGORY_WORDS[cat]) {
      if (/^[\x00-\x7f]+$/.test(w) ? slug.includes(`-${w}-`) : raw.includes(w)) return cat;
    }
  }
  return null;
}

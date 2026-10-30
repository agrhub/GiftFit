/**
 * Grounding check: every non-empty field an extractor returns must be supported by the page itself.
 * This is how "never invent fields" is enforced in code, independent of the model's instructions.
 * Product-specific fields are checked against the MAIN product region (page.mainText, related products,
 * header banners and footers removed) plus JSON-LD / meta, so a value borrowed from a "you may also
 * like" card or a "free shipping over $150" banner is rejected. Page-level fields (title, category,
 * brand) may also come from the breadcrumb / header, so they are checked against the whole page.
 * - text fields: the value occurs in the text (case-, accent-, whitespace- and quote-insensitive);
 * - description: ≥ 80% of its words occur in the main text;
 * - price: the same amount is printed in the main region (any thousands/decimal format) or in
 *   JSON-LD / meta;
 * - currency: its code, or a symbol for it, appears in the main region or JSON-LD / meta;
 * - images: only URLs present in the page's image list (query string ignored).
 * Unsupported values become null (or are removed from `images`) and are reported as `DroppedField`s.
 */
import type { RenderedPage } from "./html";
import { parseAmount } from "./normalise";
import type { DroppedField, ExtractedProduct } from "./types";

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‘’“”″"']/g, "")
    .replace(/[‐-―]/g, "-")
    .replace(/[^a-z0-9$€£₫¥.,%-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const CURRENCY_SYMBOLS: Record<string, string[]> = {
  USD: ["$", "usd", "us$"],
  EUR: ["€", "eur"],
  GBP: ["£", "gbp"],
  VND: ["₫", "vnd", "đ"],
  JPY: ["¥", "jpy"],
  INR: ["₹", "inr"],
  CAD: ["cad", "ca$"],
  AUD: ["aud", "a$"],
  SGD: ["sgd", "s$"],
};

function structuredStrings(page: RenderedPage): string {
  const parts: string[] = Object.values(page.meta);
  const visit = (v: unknown) => {
    if (typeof v === "string" || typeof v === "number") parts.push(String(v));
    else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") Object.values(v).forEach(visit);
  };
  page.jsonLd.forEach(visit);
  return parts.join("\n");
}

const stripQuery = (u: string) => u.split(/[?#]/)[0];

export function groundProduct(p: ExtractedProduct, page: RenderedPage): { product: ExtractedProduct; dropped: DroppedField[] } {
  const structured = structuredStrings(page);
  const raw = `${page.mainText}\n${structured}`;
  const hay = fold(raw);
  const pageHay = fold(`${page.text}\n${structured}`);
  const words = new Set(hay.split(" "));
  const PAGE_LEVEL = new Set(["title", "category", "brand"]);
  const dropped: DroppedField[] = [];
  const out: ExtractedProduct = { ...p, images: [...p.images] };

  const textFields = ["title", "metal", "stone", "category", "length", "sku", "brand"] as const;
  for (const f of textFields) {
    const v = out[f];
    if (v === null) continue;
    const needle = fold(v);
    if (!needle || !(PAGE_LEVEL.has(f) ? pageHay : hay).includes(needle)) {
      dropped.push({ field: f, value: v, reason: "value not found on the page" });
      out[f] = null;
    }
  }

  if (out.description !== null) {
    const ws = fold(out.description)
      .split(" ")
      .filter((w) => w.length >= 3);
    const hit = ws.filter((w) => words.has(w) || words.has(w.replace(/[.,]+$/, ""))).length;
    if (ws.length === 0 || hit / ws.length < 0.8) {
      dropped.push({ field: "description", value: out.description, reason: "description is not taken from the page" });
      out.description = null;
    }
  }

  if (out.price !== null) {
    const amounts = (raw.match(/\d[\d.,\s  ]*\d|\d/g) ?? []).map((s) => parseAmount(s.trim())).filter((n): n is number => n !== null);
    if (!amounts.some((a) => Math.abs(a - (out.price as number)) < 0.005)) {
      dropped.push({ field: "price", value: out.price, reason: "amount not printed on the page" });
      out.price = null;
    }
  }

  if (out.currency !== null) {
    const code = out.currency.toUpperCase();
    const marks = CURRENCY_SYMBOLS[code] ?? [code.toLowerCase()];
    const lowerRaw = raw.toLowerCase();
    if (!marks.some((m) => lowerRaw.includes(m))) {
      dropped.push({ field: "currency", value: out.currency, reason: "currency not shown on the page" });
      out.currency = null;
    }
  }

  const known = new Set(page.images.map(stripQuery));
  const keep: string[] = [];
  for (const img of out.images) {
    let abs = img;
    try {
      abs = new URL(img, page.url).href;
    } catch {
      /* keep raw for the check */
    }
    if (known.has(stripQuery(abs))) {
      if (!keep.includes(abs)) keep.push(abs);
    } else dropped.push({ field: "images", value: img, reason: "image URL not on the page" });
  }
  out.images = keep;
  return { product: out, dropped };
}

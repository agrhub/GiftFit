/**
 * Normalisation: `RawProduct` (as written on the page) → `IngestedSku` (GiftFit vocabulary from
 * lib/contracts/giftfit.ts). Every mapping is a keyword rule over text that IS on the page (title,
 * stated metal, description, platform tags); when no rule fires the field stays empty and is listed
 * in `missing`. Nothing is guessed from prices, images or other products.
 */
import type { JewelryCategory } from "@/db/schema";
import type { CatalogSku, EarringShape, GiftFitAttributes, Metal, NecklaceStyle } from "@/lib/contracts/giftfit";
import { METALS } from "@/lib/contracts/giftfit";
import { METAL_TONE } from "@/lib/verticals/jewelry";
import type { Coverage, IngestedSku, RawProduct } from "./types";

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[‐-―]/g, "-").replace(/\s+/g, " ").trim();

/** Free-text metal → canonical key. Order matters (two-tone before single golds, white/rose before plain gold). */
export function canonicalMetal(text: string | null | undefined): Metal | null {
  const t = norm(text);
  if (!t) return null;
  const direct = t.replace(/[\s-]+/g, "_");
  if ((METALS as readonly string[]).includes(direct)) return direct as Metal;
  if (/two[- ]?tone|tri[- ]?colou?r|mixed metals?|(yellow|rose) (and|&) white gold|white (and|&) (yellow|rose) gold/.test(t)) return "mixed_two_tone";
  if (/\b(rose|pink|red) gold\b/.test(t)) return "rose_gold";
  if (/\bwhite gold\b/.test(t)) return "white_gold";
  if (/\bplatinum\b/.test(t) && !/platinum[- ]plated/.test(t)) return "platinum";
  if (/\bgold\b/.test(t) && !/\bgold[- ]?(tone|colou?red)\b/.test(t)) return "yellow_gold";
  if (/\b(sterling )?silver\b|\b925\b|\bargentium\b/.test(t)) return "silver";
  return null;
}

const CATEGORY_RULES: [JewelryCategory, RegExp][] = [
  ["watch", /\bwatch(es)?\b|\btimepiece\b/],
  ["earring", /\bear-?rings?\b|\bstuds?\b|\bhoops?\b|\bhuggies?\b|\bear ?cuffs?\b|\bdrops? earrings?\b|\bchandeliers?\b/],
  ["necklace", /\bnecklaces?\b|\bpendants?\b|\bchokers?\b|\blockets?\b|\blariats?\b|\bchains?\b|\bcollars?\b/],
  ["bracelet", /\bbracelets?\b|\bbangles?\b|\bcuffs?\b|\banklets?\b/],
  ["ring", /\brings?\b|\bsolitaire\b|\bband\b/],
];

export function inferCategory(...texts: (string | null | undefined)[]): JewelryCategory | null {
  for (const text of texts) {
    const t = norm(text);
    if (!t) continue;
    for (const [cat, re] of CATEGORY_RULES) if (re.test(t)) return cat;
  }
  return null;
}

const EARRING_RULES: [EarringShape, RegExp][] = [
  ["chandelier_short", /\b(short|wide|petite) chandelier|chandelier\b.*\b(short|wide)\b/],
  ["chandelier", /\bchandelier/],
  ["geometric_angular", /\bgeometric|\bsquare\b|\bhexagon|\boctagon|\bangular\b|\bbaguette\b|\bbar studs?\b/],
  ["hoop_oval_curved", /\b(oval|elongated|curved|teardrop) hoops?\b/],
  ["hoop_round_large", /\b(large|big|statement|chunky|oversized|wide) (round )?hoops?\b/],
  ["hoop_small_medium", /\bhuggies?\b|\bhoops?\b/],
  ["stud_statement", /\b(cluster|statement|button|oversized|flower|cocktail) (stud|earring)s?\b|\bclusters?\b/],
  ["drop_wide_bottom", /\b(bell|fan|triangle|tassel) (drop|earring)s?\b|\bwide[- ]bottom/],
  ["drop_long_narrow", /\b(linear|threader|long|bar|line) (drop|dangle|earring)s?\b|\bthreaders?\b|\blinear\b/],
  ["drop_teardrop", /\bteardrops?\b|\bpear[- ]shaped?\b|\bdrops?\b|\bdangles?\b/],
  ["stud_small", /\bstuds?\b|\bsolitaire earrings?\b/],
];

export function inferEarringShape(...texts: (string | null | undefined)[]): EarringShape | null {
  for (const text of texts) {
    const t = norm(text);
    if (!t) continue;
    for (const [shape, re] of EARRING_RULES) if (re.test(t)) return shape;
  }
  return null;
}

const NECKLACE_RULES: [NecklaceStyle, RegExp][] = [
  ["choker_heavy", /\b(heavy|chunky|statement|thick) chokers?\b/],
  ["choker", /\bchokers?\b/],
  ["collar_bib_horizontal", /\bbib\b|\bcollar\b|\bhorizontal bar\b/],
  ["pendant_v_y", /\blariat|\by[- ]necklace|\bv[- ]?(shaped )?pendant|\bv[- ]shape|\bdrop pendant/],
  ["geometric_angular", /\bgeometric|\b(square|triangle|triangular|hexagon) pendant/],
  ["large_stone", /\b(large|statement|cocktail|oversized|bold) (\w+ )?(stone|gem|gemstone|emerald|sapphire|ruby|pendant)\b/],
  ["pendant_curved", /\blocket|\b(round|oval|circle|disc|coin|heart) pendant|\bcurved\b/],
  ["long_vertical", /\b(opera|rope|long) (length )?(chain|necklace)\b|\bsautoir\b/],
  ["thin_chain", /\b(thin|fine|delicate|dainty|cable|box|snake|paperclip) chain\b|\bchain necklace\b/],
];

export function inferNecklaceStyle(lengthIn: number | null, ...texts: (string | null | undefined)[]): NecklaceStyle | null {
  for (const text of texts) {
    const t = norm(text);
    if (!t) continue;
    for (const [style, re] of NECKLACE_RULES) if (re.test(t)) return style;
  }
  if (lengthIn !== null && lengthIn >= 28) return "long_vertical";
  return null;
}

/** "18 in", "18\"", "18 inches", "45 cm", "450mm" → inches (1 decimal). */
export function parseLengthInches(text: string | null | undefined): number | null {
  const t = norm(text).replace(/[”″]/g, '"');
  if (!t) return null;
  const m = /(\d+(?:[.,]\d+)?)\s*(inches|inch|in\b|"|cm\b|centimet(?:er|re)s?|mm\b)/.exec(t);
  if (!m) return null;
  const n = parseFloat(m[1].replace(",", "."));
  const unit = m[2];
  const inches = unit.startsWith("c") ? n / 2.54 : unit === "mm" ? n / 25.4 : n;
  return inches > 0 && inches < 60 ? Math.round(inches * 10) / 10 : null;
}

const SYMBOLS: Record<string, string> = { $: "USD", "US$": "USD", "€": "EUR", "£": "GBP", "₫": "VND", "¥": "JPY", "₹": "INR" };
const CODES = ["USD", "EUR", "GBP", "VND", "JPY", "INR", "CAD", "AUD", "SGD"];

/** "1,250.00" / "1.250,00" / "1 250" / "65" → number. */
export function parseAmount(s: string): number | null {
  let t = s.replace(/[\s  ]/g, "");
  if (!/\d/.test(t)) return null;
  const lastComma = t.lastIndexOf(",");
  const lastDot = t.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    const dec = lastComma > lastDot ? "," : ".";
    t = t.replace(dec === "," ? /\./g : /,/g, "").replace(",", ".");
  } else if (lastComma >= 0) {
    t = /,\d{2}$/.test(t) ? t.replace(",", ".") : t.replace(/,/g, "");
  } else if (/^\d{1,3}(\.\d{3})+$/.test(t)) {
    // "1.250" / "2.500.000": dot as thousands separator (EU, VND).
    t = t.replace(/\./g, "");
  }
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** First price with an explicit currency marker in the text, e.g. "$1,250.00", "€310", "310 EUR". */
export function parsePrice(text: string | null | undefined): { price: number; currency: string } | null {
  if (!text) return null;
  const re = /(US\$|[$€£₫¥₹]|\b(?:USD|EUR|GBP|VND|JPY|INR|CAD|AUD|SGD)\b)\s?(\d[\d.,\s ]*\d|\d)|(\d[\d.,\s ]*\d|\d)\s?([€₫]|\b(?:USD|EUR|GBP|VND|JPY|INR|CAD|AUD|SGD)\b)/;
  const m = re.exec(text);
  if (!m) return null;
  const marker = (m[1] ?? m[4]).trim();
  const amount = parseAmount((m[2] ?? m[3]).trim());
  if (amount === null) return null;
  return { price: amount, currency: SYMBOLS[marker] ?? (CODES.includes(marker) ? marker : "USD") };
}

export function normaliseCurrency(c: string | null | undefined): string | null {
  const t = (c ?? "").trim();
  if (!t) return null;
  if (SYMBOLS[t]) return SYMBOLS[t];
  const up = t.toUpperCase();
  return /^[A-Z]{3}$/.test(up) ? up : null;
}

const STYLE_WORDS = ["minimal", "classic", "statement", "boho", "vintage", "modern", "romantic", "everyday"];

/** `key::value` tags (Shopify convention, docs/ingest-policy.md) → map. */
export function tagMap(tags: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tag of tags) {
    const m = /^\s*([a-z_]+)::\s*(.+?)\s*$/i.exec(tag);
    if (m) out[m[1].toLowerCase()] = m[2];
  }
  return out;
}

function slugify(s: string): string {
  return norm(s)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
export { slugify };

export function normaliseProduct(raw: RawProduct): IngestedSku {
  const tags = tagMap(raw.tags);
  const category = (inferCategory(tags.category, raw.category, raw.title) as JewelryCategory | null) ?? null;
  const metal = canonicalMetal(tags.metal) ?? canonicalMetal(raw.metal) ?? canonicalMetal(raw.title);
  const lengthIn =
    parseLengthInches(tags.length ?? raw.length) ??
    (category === "necklace" ? (parseLengthInches(raw.title) ?? parseLengthInches(raw.description)) : null);
  const stoneRaw = tags.stone ?? raw.stone;
  const stone = stoneRaw ? (/^(none|no stone|n\/a|-)$/i.test(stoneRaw.trim()) ? "none" : norm(stoneRaw)) : undefined;
  const styleTag = tags.style ? norm(tags.style) : STYLE_WORDS.find((w) => norm(`${raw.title} ${raw.description ?? ""}`).includes(w));

  const attributes: Partial<GiftFitAttributes> & Record<string, unknown> = {
    ...(category ? { category } : {}),
    ...(metal ? { metal, metal_tone: METAL_TONE[metal] } : {}),
    ...(stone ? { stone } : {}),
    style: styleTag ?? "unspecified",
    occasions: [],
    // The YouCam 2d-vto image spec is not checked at ingest; A6/A2 tooling flips this after a check.
    vto_spec_ok: false,
    vto_image: raw.images[0] ?? "",
    ingest_tier: raw.tier,
  };
  if (raw.metal) attributes.metal_text = raw.metal;
  if (category === "earring") {
    const shape = (tags.earring_shape as EarringShape | undefined) ?? inferEarringShape(raw.title, raw.description);
    if (shape) attributes.earring_shape = shape;
  }
  if (category === "necklace") {
    if (lengthIn !== null) attributes.necklace_length_in = lengthIn;
    const style = (tags.necklace_style as NecklaceStyle | undefined) ?? inferNecklaceStyle(lengthIn, raw.title, raw.description);
    if (style) attributes.necklace_style = style;
  }

  const currency = normaliseCurrency(raw.currency);
  const missing: string[] = [];
  if (!raw.title) missing.push("title");
  if (!category) missing.push("category");
  if (!metal) missing.push("metal");
  if (raw.price === null) missing.push("price");
  if (raw.price !== null && !currency) missing.push("currency");
  if (raw.images.length === 0) missing.push("images");
  const hard = missing.length === 0;
  if (category === "earring" && !attributes.earring_shape) missing.push("earring_shape");
  if (category === "necklace" && !attributes.necklace_style) missing.push("necklace_style");

  return {
    externalId: raw.externalId,
    title: raw.title ?? "",
    category,
    price: raw.price,
    currency,
    images: raw.images,
    attributes: attributes as IngestedSku["attributes"],
    sourceUrl: raw.sourceUrl,
    tier: raw.tier,
    missing,
    complete: hard,
  };
}

export function coverage(skus: IngestedSku[]): Coverage {
  const withMetal = skus.filter((s) => s.attributes.metal).length;
  const withPrice = skus.filter((s) => s.price !== null).length;
  const withImages = skus.filter((s) => s.images.length > 0).length;
  const withAll3 = skus.filter((s) => s.attributes.metal && s.price !== null && s.images.length > 0).length;
  return { total: skus.length, withMetal, withPrice, withImages, withAll3, ratio: skus.length ? withAll3 / skus.length : 0 };
}

/** The contract view (`CatalogSku`) of a complete SKU; null when a required field is missing. */
export function toCatalogSku(s: IngestedSku, storeId: string, id: string): CatalogSku | null {
  if (!s.complete || !s.category || s.price === null || !s.currency) return null;
  return {
    id,
    storeId,
    title: s.title,
    category: s.category,
    price: s.price,
    currency: s.currency,
    images: s.images,
    attributes: s.attributes as GiftFitAttributes,
    sourceUrl: s.sourceUrl,
  };
}

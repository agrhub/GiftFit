/**
 * Deterministic DOM extractor (no LLM). Used when ANTHROPIC_API_KEY is absent, as the INGEST_FIXTURE=1
 * default, and as a cross-check for the Claude extractor. It reads only the main product region:
 * header, footer, nav, aside and "related / you may also like" sections are removed first, so prices
 * and metals of other products cannot leak in. Values are copied as written; normalise.ts maps them.
 */
import * as cheerio from "cheerio";
import { imageUrls, mainRegion, visibleText, type RenderedPage, type Sel } from "../html";
import { groundProduct } from "../grounding";
import { parsePrice } from "../normalise";
import { productFromJsonLd } from "../tier2-jsonld";
import type { ExtractedProduct } from "../types";
import type { ExtractionResult, Extractor } from "./types";

const LABELS: [keyof ExtractedProduct, RegExp][] = [
  ["metal", /^(metal|material|metal type|precious metal)$/i],
  ["stone", /^(stone|gemstone|gem|main stone|center stone)$/i],
  ["length", /^(length|chain length|necklace length)$/i],
  ["sku", /^(sku|item( no\.?| number)?|style( no\.?| number)?|product code|ref(erence)?)$/i],
  ["category", /^(category|type|product type)$/i],
  ["brand", /^(brand|designer)$/i],
];
const METAL_PHRASE =
  /\b((?:\d{1,2}\s?(?:k|kt|ct|karat|carat)\s)?(?:solid\s)?(?:yellow|white|rose|pink)?\s?gold(?:\s(?:vermeil|plated|filled))?|(?:yellow|white|rose)\s(?:and|&)\s(?:yellow|white|rose)\sgold|two[- ]tone(?:\s(?:yellow|white|rose)?\s?gold)?|sterling silver|silver|platinum|stainless steel|titanium)\b/i;
const STONE_PHRASE =
  /\b((?:freshwater|akoya|south sea|lab[- ]grown|natural|white|blue|pink|green)?\s?(?:pearls?|diamonds?|sapphires?|emeralds?|rub(?:y|ies)|morganite|topaz|opal|amethyst|garnet|aquamarine|moissanite|cubic zirconia|peridot|tanzanite|onyx))\b/i;

function labelledSpecs($: cheerio.CheerioAPI, root: Sel): Partial<Record<keyof ExtractedProduct, string>> {
  const pairs: [string, string][] = [];
  root.find("dt").each((_, el) => {
    pairs.push([$(el).text(), $(el).next("dd").text()]);
  });
  root.find("tr").each((_, el) => {
    const cells = $(el).children("th,td");
    if (cells.length >= 2) pairs.push([$(cells[0]).text(), $(cells[1]).text()]);
  });
  root.find("li,p").each((_, el) => {
    const m = /^\s*([A-Za-z .]{2,24}):\s*(.+?)\s*$/.exec($(el).text());
    if (m) pairs.push([m[1], m[2]]);
  });
  const out: Partial<Record<keyof ExtractedProduct, string>> = {};
  for (const [k, v] of pairs) {
    const key = k.replace(/\s+/g, " ").trim();
    const val = v.replace(/\s+/g, " ").trim();
    if (!val) continue;
    for (const [field, re] of LABELS) if (re.test(key) && !(field in out)) out[field] = val;
  }
  return out;
}

function priceIn($: cheerio.CheerioAPI, root: Sel): { price: number; currency: string } | null {
  const candidates = root.find('[itemprop="price"],[data-price],[class*="price"],[id*="price"]').not('s,del,[class*="compare"],[class*="was"],[class*="old"]');
  for (const el of candidates.toArray()) {
    const $el = $(el);
    if ($el.find('[class*="price"]').length) continue; // prefer the innermost price node
    const content = $el.attr("content");
    const currency = $el.closest("[itemscope]").find('[itemprop="priceCurrency"]').attr("content");
    if (content && currency) {
      const p = parsePrice(`${currency} ${content}`);
      if (p) return p;
    }
    const p = parsePrice($el.text());
    if (p) return p;
  }
  return null;
}

export function extractHeuristic(page: RenderedPage): ExtractedProduct {
  const fromLd = productFromJsonLd(page.jsonLd, page.url);
  const $ = cheerio.load(page.html);
  const root = mainRegion($);
  const specs = labelledSpecs($, root);
  const title = root.find("h1").first().text().replace(/\s+/g, " ").trim() || page.meta["og:title"] || null;
  const descEl = root.find('[itemprop="description"],[class*="description"],[data-description]').first();
  const description =
    (descEl.length ? descEl.text() : root.find("p").filter((_, p) => $(p).text().trim().length > 60).first().text()).replace(/\s+/g, " ").trim() || null;
  const text = visibleText($, root);
  const titleAndDesc = `${title ?? ""}\n${description ?? ""}`;
  const price = priceIn($, root);
  const images = imageUrls($, page.url, root).filter((u) => !/logo|icon|sprite|placeholder|badge/i.test(u));
  const crumbs = $("[aria-label*=readcrumb] li, .breadcrumb li, .breadcrumbs li").toArray().map((li) => $(li).text().trim());
  const lengthLine = text.split("\n").find((l) => /length|chain|\d\s?(in|inch|inches|cm|")\b/i.test(l) && /\d\s?(in\b|inch|inches|cm\b|")/i.test(l));
  const lengthMatch = lengthLine ? /(\d+(?:[.,]\d+)?\s?(?:inches|inch|in\b|cm\b|"))/i.exec(lengthLine) : null;

  const heur: ExtractedProduct = {
    title,
    price: price?.price ?? null,
    currency: price?.currency ?? null,
    images,
    metal: specs.metal ?? METAL_PHRASE.exec(titleAndDesc)?.[1]?.trim() ?? null,
    stone: specs.stone ?? STONE_PHRASE.exec(titleAndDesc)?.[1]?.trim() ?? null,
    category: specs.category ?? (crumbs.length >= 2 ? crumbs[crumbs.length - 2] : null),
    length: specs.length ?? lengthMatch?.[1] ?? null,
    sku: specs.sku ?? null,
    brand: specs.brand ?? null,
    description: description ? description.slice(0, 600) : null,
  };
  if (!fromLd) return heur;
  // JSON-LD wins where it has a value; the DOM fills the gaps.
  const merged = { ...heur } as ExtractedProduct;
  for (const k of Object.keys(fromLd) as (keyof ExtractedProduct)[]) {
    const v = fromLd[k];
    if (Array.isArray(v) ? v.length : v !== null) (merged as unknown as Record<string, unknown>)[k] = v;
  }
  return merged;
}

export class HeuristicExtractor implements Extractor {
  readonly name = "heuristic";
  async extract(page: RenderedPage): Promise<ExtractionResult> {
    return groundProduct(extractHeuristic(page), page);
  }
}

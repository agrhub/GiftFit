/**
 * Platform detection (docs/ingest-policy.md "Detection heuristics"). Picks the lowest tier that works:
 *   Tier 1 Shopify  — Shopify response headers or storefront markers on the home page, confirmed by a
 *                     `/products.json` probe that returns a products array.
 *   Tier 2 JSON-LD  — product URLs found in the sitemap(s) and the first product page carries a
 *                     schema.org Product (or og:type=product) with a name.
 *   Tier 3 render   — everything else, notably client-rendered stores (a near-empty body with an app
 *                     root such as #root, #app or #__next and script bundles).
 */
import * as cheerio from "cheerio";
import { pageFromHtml, visibleText } from "./html";
import type { HttpResponse } from "./politeness";
import { productFromJsonLd, productFromOpenGraph } from "./tier2-jsonld";
import type { IngestTier, Platform } from "./types";

export interface HomeSignals {
  shopify: boolean;
  clientRendered: boolean;
  productJsonLd: boolean;
  signals: string[];
}

const SHOPIFY_HEADERS = ["x-shopify-stage", "x-shopid", "x-sorting-hat-shopid", "x-shardid"];

export function homeSignals(res: Pick<HttpResponse, "headers" | "body" | "url">): HomeSignals {
  const signals: string[] = [];
  for (const h of SHOPIFY_HEADERS) if (res.headers[h] !== undefined) signals.push(`header:${h}`);
  if (/shopify/i.test(res.headers["powered-by"] ?? "")) signals.push("header:powered-by=Shopify");
  const body = res.body;
  if (/cdn\.shopify\.com|cdn\/shop\//i.test(body)) signals.push("html:cdn.shopify.com");
  if (/\bShopify\.(theme|shop|currency)\b/.test(body)) signals.push("html:Shopify.* globals");
  if (/\.myshopify\.com/i.test(body)) signals.push("html:myshopify.com");
  const shopify = signals.length > 0;

  const $ = cheerio.load(body);
  const text = visibleText($);
  const appRoot = $("#root, #app, #__next, [data-reactroot], [ng-app], #___gatsby").length > 0;
  const scripts = $("script[src]").length + $("script:not([src])").length;
  const clientRendered = appRoot && scripts > 0 && text.length < 400;
  if (clientRendered) signals.push(`html:app-root with ${text.length} chars of server text`);

  const page = pageFromHtml(body, res.url);
  const productJsonLd = Boolean(productFromJsonLd(page.jsonLd, page.url)?.title ?? productFromOpenGraph(page)?.title);
  if (productJsonLd) signals.push("html:Product JSON-LD/OG");
  return { shopify, clientRendered, productJsonLd, signals };
}

export const PLATFORM_TIER: Record<Exclude<Platform, "unknown">, IngestTier> = { shopify: 1, jsonld: 2, render: 3 };

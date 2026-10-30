/**
 * Ingest pipeline: detect → discover → extract → normalise → embed → store. Every network access goes
 * through one `PoliteFetcher` (robots, ≤ 1 req/s/host, 24 h cache, page cap), including Playwright
 * navigations. Per-URL failures are recorded and skipped; host-level failures (robots disallow of the
 * store root, 403/429 stop, page cap) end the run with status "error" after storing what was done.
 */
import { homeSignals } from "./detect";
import type { Embedder } from "./embed";
import { skuEmbeddingText } from "./embed";
import type { Extractor } from "./extract/types";
import { pageFromHtml } from "./html";
import { coverage, normaliseProduct, slugify } from "./normalise";
import { HostStoppedError, PageCapError, RobotsDisallowedError, type PoliteFetcher } from "./politeness";
import type { Renderer } from "./render";
import type { CatalogSink } from "./store";
import { ingestShopify, isShopifyCatalog } from "./tier1-shopify";
import { discoverFromSitemaps, isProductUrl, rawFromTier2 } from "./tier2-jsonld";
import type { DroppedField, IngestedSku, IngestProgress, IngestReport, IngestTier, Platform, RawProduct } from "./types";

export interface IngestOptions {
  url: string;
  tier?: IngestTier | "auto";
  maxProducts?: number;
  /** Listing pages to render while discovering product links (Tier 3). */
  maxListingPages?: number;
  storeName?: string;
}

export interface IngestDeps {
  fetcher: PoliteFetcher;
  renderer?: Renderer;
  extractor: Extractor;
  embedder: Embedder;
  sink: CatalogSink;
  onProgress?: (p: IngestProgress) => void;
}

export interface IngestResult extends IngestReport {
  storeId: string;
  status: "done" | "error";
  fatal?: string;
}

export const DEFAULT_MAX_PRODUCTS = 300;
export const DEFAULT_MAX_LISTING_PAGES = 30;
const PAGINATION_RE = /[?&]page=\d+|\/page\/\d+\/?$/i;

const isFatal = (e: unknown) => e instanceof HostStoppedError || e instanceof PageCapError;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface Detection {
  platform: Platform;
  tier: IngestTier;
  signals: string[];
  /** Product URLs found during detection (sitemaps), reused by Tier 2/3. */
  productUrls: string[];
}

export async function detect(storeBase: string, fetcher: PoliteFetcher, maxUrls: number): Promise<Detection> {
  const home = await fetcher.get(storeBase);
  if (home.status !== 200) throw new Error(`store home returned HTTP ${home.status}`);
  const s = homeSignals(home);
  if (s.shopify && (await isShopifyCatalog(fetcher, storeBase))) {
    return { platform: "shopify", tier: 1, signals: [...s.signals, "probe:/products.json ok"], productUrls: [] };
  }
  const productUrls = await discoverFromSitemaps(fetcher, storeBase, maxUrls);
  const signals = [...s.signals, `sitemap:${productUrls.length} product URLs`];
  if (productUrls.length && !s.clientRendered) {
    const sample = await fetcher.get(productUrls[0]);
    if (sample.status === 200 && rawFromTier2(pageFromHtml(sample.body, sample.url))) {
      return { platform: "jsonld", tier: 2, signals: [...signals, "sample product page has Product JSON-LD/OG"], productUrls };
    }
  }
  return { platform: "render", tier: 3, signals, productUrls };
}

/** Render listing pages (home + pagination) and collect same-host product links. */
export async function discoverRenderedProductUrls(
  storeBase: string,
  renderer: Renderer,
  fetcher: PoliteFetcher,
  maxListingPages: number,
  maxUrls: number,
): Promise<string[]> {
  const queue = [storeBase];
  const seen = new Set<string>();
  const products: string[] = [];
  while (queue.length && seen.size < maxListingPages && products.length < maxUrls) {
    const url = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    const page = await renderer.render(url);
    for (const link of page.links) {
      if (!(await fetcher.isAllowed(link))) continue;
      if (PAGINATION_RE.test(link)) {
        if (!seen.has(link) && !queue.includes(link)) queue.push(link);
      } else if (isProductUrl(link) && !products.includes(link)) products.push(link);
    }
  }
  return products.slice(0, maxUrls);
}

const slugOf = (url: string) => new URL(url).pathname.split("/").filter(Boolean).pop() ?? url;

export async function runIngest(opts: IngestOptions, deps: IngestDeps): Promise<IngestResult> {
  const storeBase = new URL("/", opts.url).href;
  const maxProducts = opts.maxProducts ?? DEFAULT_MAX_PRODUCTS;
  const progress: IngestProgress = { phase: "detect", discovered: 0, processed: 0, skus: 0, errors: 0 };
  const emit = (patch: Partial<IngestProgress>) => {
    Object.assign(progress, patch);
    deps.onProgress?.({ ...progress });
  };
  const storeId = await deps.sink.upsertStore({ url: storeBase, name: opts.storeName ?? new URL(storeBase).host, platform: "unknown" });
  await deps.sink.updateStore(storeId, { ingestStatus: "running", ingestProgress: progress, error: null });
  emit({});

  const errors: { url: string; error: string }[] = [];
  const dropped: { url: string; fields: DroppedField[] }[] = [];
  const raws: RawProduct[] = [];
  let detection: Detection = { platform: "unknown" as Platform, tier: 3, signals: [], productUrls: [] };
  let fatal: string | undefined;

  try {
    detection = await detect(storeBase, deps.fetcher, maxProducts);
    if (opts.tier && opts.tier !== "auto") detection = { ...detection, tier: opts.tier, signals: [...detection.signals, `forced:tier${opts.tier}`] };
    await deps.sink.updateStore(storeId, { platform: detection.platform, ingestTier: detection.tier });

    if (detection.tier === 1) {
      emit({ phase: "extract" });
      raws.push(...(await ingestShopify(deps.fetcher, storeBase, { maxProducts, onPage: (_p, n) => emit({ discovered: n, processed: n }) })));
    } else {
      emit({ phase: "discover" });
      let urls = detection.productUrls;
      if (detection.tier === 3 && urls.length === 0) {
        if (!deps.renderer) throw new Error("Tier 3 needs a renderer");
        urls = await discoverRenderedProductUrls(storeBase, deps.renderer, deps.fetcher, opts.maxListingPages ?? DEFAULT_MAX_LISTING_PAGES, maxProducts);
      }
      urls = urls.slice(0, maxProducts);
      emit({ phase: "extract", discovered: urls.length });
      for (const url of urls) {
        try {
          let raw: RawProduct | null = null;
          if (detection.tier === 2) {
            const res = await deps.fetcher.get(url);
            if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
            raw = rawFromTier2(pageFromHtml(res.body, url));
            if (!raw) throw new Error("no Product JSON-LD / Open Graph on page");
          } else {
            if (!deps.renderer) throw new Error("Tier 3 needs a renderer");
            const page = await deps.renderer.render(url);
            const { product, dropped: d } = await deps.extractor.extract(page);
            if (d.length) dropped.push({ url, fields: d });
            if (!product.title) throw new Error("extractor found no product title");
            raw = { ...product, sourceUrl: url, externalId: product.sku ? slugify(product.sku) : slugOf(url), tier: 3, tags: [] };
          }
          raws.push(raw);
        } catch (e) {
          if (isFatal(e)) throw e;
          errors.push({ url, error: msg(e) });
          emit({ errors: errors.length });
        }
        emit({ processed: progress.processed + 1 });
      }
    }
  } catch (e) {
    fatal = msg(e);
    if (!(isFatal(e) || e instanceof RobotsDisallowedError)) errors.push({ url: storeBase, error: fatal });
  }

  emit({ phase: "normalise" });
  const byId = new Map<string, IngestedSku>();
  for (const r of raws) byId.set(r.externalId, normaliseProduct(r));
  const skus = [...byId.values()];

  emit({ phase: "embed", skus: skus.length });
  let embeddings: number[][] = [];
  try {
    embeddings = skus.length ? await deps.embedder.embed(skus.map(skuEmbeddingText), "document") : [];
  } catch (e) {
    errors.push({ url: storeBase, error: `embedding failed: ${msg(e)}` });
  }

  emit({ phase: "store" });
  const written = await deps.sink.upsertSkus(
    storeId,
    skus.map((s, i) => ({ ...s, embedding: embeddings[i] ?? null })),
  );
  const status = fatal ? "error" : "done";
  emit({ phase: status === "done" ? "done" : "error", skus: written, message: fatal });
  await deps.sink.updateStore(storeId, {
    ingestStatus: status,
    ingestProgress: progress,
    skuCount: written,
    error: fatal ?? null,
    lastIngestedAt: new Date(),
  });

  return {
    storeId,
    status,
    fatal,
    storeUrl: storeBase,
    platform: detection.platform,
    tier: detection.tier,
    detectionSignals: detection.signals,
    discovered: progress.discovered,
    skus,
    coverage: coverage(skus),
    dropped,
    errors,
    extractor: detection.tier === 3 ? deps.extractor.name : detection.tier === 2 ? "jsonld" : "shopify",
  };
}

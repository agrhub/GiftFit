/**
 * The catalog the retailer side works with (owner: A6). Today that is the Aurum catalog the Fit
 * Engine serves without a database (ADR-020): data/aurum/catalog.json, the same rows A10's Aurum
 * ingest produces. A Fit Request can only shortlist SKUs the Fit Engine knows, so the plugin's
 * lookup uses exactly this set. Ingested stores join once ingest writes to Postgres (A6.md request).
 *
 * Product data only: no recipient data passes through here.
 */
import rawCatalog from "@/data/aurum/catalog.json";
import storeInfo from "@/data/aurum/store.json";
import type { CatalogSku } from "@/lib/contracts/giftfit";

export type RetailSku = CatalogSku & { attributes: CatalogSku["attributes"] & { sku?: string; slug?: string } };

export interface RetailStore {
  id: string;
  /** Short key used by the script tag's data-store attribute. */
  key: string;
  name: string;
  skus: readonly RetailSku[];
}

const AURUM: RetailStore = { id: storeInfo.id, key: "aurum", name: storeInfo.name, skus: rawCatalog as unknown as RetailSku[] };
const STORES: readonly RetailStore[] = [AURUM];

export const DEFAULT_STORE = AURUM;

/** Resolve a store by key ("aurum") or id (UUID). */
export function findStore(keyOrId: string | null | undefined): RetailStore | undefined {
  const k = (keyOrId ?? "").trim().toLowerCase();
  if (!k) return undefined;
  return STORES.find((s) => s.key === k || s.id.toLowerCase() === k);
}

/** What a PDP tells us about its product (JSON-LD, Open Graph or data-giftfit-sku). */
export interface ProductHints {
  sku?: string | null;
  url?: string | null;
  name?: string | null;
}

const norm = (s: string) => s.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");

/** Last non-empty path segment of a URL (or path), e.g. ".../p/halo-drop-earrings" → "halo-drop-earrings". */
function lastSegment(url: string): string | undefined {
  try {
    const u = new URL(url, "http://x.invalid");
    const parts = u.pathname.split("/").filter(Boolean);
    return parts.length ? decodeURIComponent(parts[parts.length - 1]).toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Match a PDP to a catalog SKU: SKU code / catalog id / slug first, then the URL's last path
 * segment as a slug or SKU, then the exact product name. Returns undefined when nothing matches
 * (the plugin then shows no button).
 */
export function matchProduct(store: RetailStore, hints: ProductHints): RetailSku | undefined {
  const byKey = new Map<string, RetailSku>();
  for (const s of store.skus) {
    byKey.set(s.id.toLowerCase(), s);
    if (s.attributes.sku) byKey.set(s.attributes.sku.toLowerCase(), s);
    if (s.attributes.slug) byKey.set(s.attributes.slug.toLowerCase(), s);
  }
  const sku = hints.sku?.trim().toLowerCase();
  if (sku && byKey.has(sku)) return byKey.get(sku);
  const seg = hints.url ? lastSegment(hints.url) : undefined;
  if (seg && byKey.has(seg)) return byKey.get(seg);
  const name = hints.name ? norm(hints.name) : "";
  if (name) return store.skus.find((s) => norm(s.title) === name);
  return undefined;
}

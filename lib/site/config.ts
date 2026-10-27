/**
 * The GiftFit site around the service (owner: A6, P8.2b). The main origin is the GiftFit home; the
 * only storefront is the separate demo store (demo-store/, Cloud Run service giftfit-demo-store).
 *
 *   GIFTFIT_DEMO_STORE_URL  origin of the demo store, read at request time
 *                           (default: the deployed giftfit-demo-store service).
 *
 * Old storefront paths on the main origin answer 308 to the demo store (storeRedirect below):
 *   /p/<id | slug | sku>        → <store>/p/<slug>       (every Aurum design has a page there)
 *   /plugin-demo/<id | slug>    → <store>/p/<slug>
 *   /c/<category slug>          → <store>/c/<slug>
 *   /cart, unknown ids/slugs    → <store>/
 */
import rawCatalog from "@/data/aurum/catalog.json";

type Env = Record<string, string | undefined>;

export const DEFAULT_DEMO_STORE_URL = "https://giftfit-demo-store-469920173665.us-central1.run.app";
export const STORE_CATEGORY_SLUGS = ["earrings", "necklaces", "rings", "bracelets", "watches"] as const;

export function demoStoreUrl(env: Env = process.env): string {
  const raw = env.GIFTFIT_DEMO_STORE_URL?.trim();
  if (raw) {
    try {
      const u = new URL(raw);
      if ((u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password) return u.origin;
    } catch {
      /* fall through to the default */
    }
  }
  return DEFAULT_DEMO_STORE_URL;
}

type RawSku = { id: string; attributes: { sku?: string; slug?: string } };
const SLUGS = new Map<string, string>();
for (const s of rawCatalog as unknown as RawSku[]) {
  const slug = s.attributes.slug;
  if (!slug) continue;
  for (const k of [s.id, slug, s.attributes.sku]) if (k) SLUGS.set(k.toLowerCase(), slug);
}

/** Demo store slug for a catalog id, slug or SKU (case-insensitive), or undefined. */
export function storeSlugFor(idOrSlug: string): string | undefined {
  let key = idOrSlug;
  try {
    key = decodeURIComponent(idOrSlug);
  } catch {
    /* keep it raw */
  }
  return SLUGS.get(key.trim().toLowerCase());
}

export type StoreRedirectKind = "product" | "category" | "home";

/** Absolute demo-store URL for an old storefront path. */
export function storeRedirectTarget(kind: StoreRedirectKind, value = "", env: Env = process.env): string {
  const base = demoStoreUrl(env);
  if (kind === "product") {
    const slug = storeSlugFor(value);
    return slug ? `${base}/p/${encodeURIComponent(slug)}` : `${base}/`;
  }
  if (kind === "category") {
    const c = value.toLowerCase();
    return (STORE_CATEGORY_SLUGS as readonly string[]).includes(c) ? `${base}/c/${c}` : `${base}/`;
  }
  return `${base}/`;
}

/** 308 Permanent Redirect (method and body kept), cacheable for a day. */
export function storeRedirect(kind: StoreRedirectKind, value?: string): Response {
  return new Response(null, { status: 308, headers: { Location: storeRedirectTarget(kind, value), "Cache-Control": "public, max-age=86400" } });
}

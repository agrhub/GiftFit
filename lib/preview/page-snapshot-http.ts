/**
 * Serving store-page snapshots (owner: A15). GET /s/<key>/snapshot and /s/<key>/snapshot/p/<id> return
 * ONLY the sanitized HTML, framed by /s/<key> in an <iframe sandbox> (no allow-scripts, no
 * allow-same-origin, no allow-forms). Headers on every answer, 404s included:
 *
 *   Content-Security-Policy: default-src 'none'; img-src https: data:; style-src https: 'unsafe-inline';
 *                            font-src https: data:; frame-ancestors 'self'      (no script-src at all)
 *   X-Content-Type-Options: nosniff · X-Robots-Tag: noindex, nofollow · Referrer-Policy: no-referrer
 *   Cache-Control: private, no-store
 *
 * A page is served only while its preview is live (not expired), ready and in snapshot mode. A product
 * the preview shows but whose page wasn't captured gets a plain GiftFit product card (same headers).
 * Cards of products the owner removed are taken out of the home page's GiftFit strip when served, and the
 * strip's words follow the viewer's Accept-Language (the first of the ten UI locales by q, else English;
 * A26), so the home page also answers Vary: Accept-Language.
 */
import { parseAcceptLanguage, recipientLocale } from "@/lib/i18n/recipient";
import { defaultPreviewRepo, PREVIEW_KEY_RE, type PreviewRecord, type PreviewRepo } from "./repo";
import { snapshotBasePath } from "./page-snapshot";
import { defaultPageSnapshotStore, HOME_PAGE_ID, productPageId, type PageSnapshotStore } from "./page-snapshot-store";
import { LINK_REL } from "./page-snapshot-sanitize";
import { localizePreviewStrip, withoutStripProducts } from "./page-snapshot-strip";
import type { PreviewProduct } from "./types";

export const SNAPSHOT_CSP = "default-src 'none'; img-src https: data:; style-src https: 'unsafe-inline'; font-src https: data:; frame-ancestors 'self'";

export const SNAPSHOT_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": SNAPSHOT_CSP,
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "private, no-store",
});

/**
 * The outer page's iframe sandbox. Deliberately WITHOUT allow-scripts (nothing in the copy may run),
 * allow-same-origin (the copy gets an opaque origin: no cookies, storage or DOM access to GiftFit) and
 * allow-forms (nothing may be submitted). allow-popups is needed for the copy's links, which all open the
 * merchant's real pages with target="_blank"; allow-popups-to-escape-sandbox lets those merchant pages
 * work normally in their new tab instead of inheriting this sandbox. No top navigation is allowed.
 */
export const SNAPSHOT_IFRAME_SANDBOX = "allow-popups allow-popups-to-escape-sandbox";

/** Snapshot mode for a ready preview record. */
export const inSnapshotMode = (rec: Pick<PreviewRecord, "state" | "snapshot"> | null | undefined): boolean => rec?.state === "ready" && rec.snapshot?.mode === "snapshot";

const notFound = () => new Response("<!DOCTYPE html><title>Not found</title><p>Not found.</p>", { status: 404, headers: { ...SNAPSHOT_HEADERS } });
const html = (body: string, extra: Record<string, string> = {}) => new Response(body, { status: 200, headers: { ...SNAPSHOT_HEADERS, ...extra } });

export interface SnapshotServeDeps {
  repo?: PreviewRepo;
  store?: PageSnapshotStore;
  nowMs?: number;
  /** The viewer's Accept-Language header (home page: the GiftFit strip's language). */
  acceptLanguage?: string | null;
}

async function liveSnapshotRecord(key: string, deps: SnapshotServeDeps): Promise<PreviewRecord | null> {
  if (!PREVIEW_KEY_RE.test(key)) return null;
  const rec = await (deps.repo ?? defaultPreviewRepo()).get(key, deps.nowMs);
  return inSnapshotMode(rec) ? rec : null;
}

export async function serveSnapshotHome(key: string, deps: SnapshotServeDeps = {}): Promise<Response> {
  const rec = await liveSnapshotRecord(key, deps);
  if (!rec) return notFound();
  const page = await (deps.store ?? defaultPageSnapshotStore()).get(key, HOME_PAGE_ID, deps.nowMs);
  if (!page) return notFound();
  // The GiftFit strip (page-snapshot-strip.ts) never lists a product the owner removed since the capture,
  // and reads in the viewer's language (stored in English: capture has no viewer).
  const locale = recipientLocale({ browserLanguages: parseAcceptLanguage(deps.acceptLanguage) });
  return html(localizePreviewStrip(withoutStripProducts(page.html, rec.settings.removedProductIds ?? []), locale), { Vary: "Accept-Language" });
}

export async function serveSnapshotProduct(key: string, rawProductId: string, deps: SnapshotServeDeps = {}): Promise<Response> {
  const rec = await liveSnapshotRecord(key, deps);
  if (!rec) return notFound();
  let id: string;
  try {
    id = decodeURIComponent(rawProductId);
  } catch {
    return notFound();
  }
  const removed = new Set(rec.settings.removedProductIds ?? []);
  const product = rec.products.find((p) => p.id === id && !removed.has(p.id));
  if (!product) return notFound();
  if (rec.snapshot?.productPages.includes(id)) {
    const page = await (deps.store ?? defaultPageSnapshotStore()).get(key, productPageId(id), deps.nowMs);
    if (page) return html(page.html);
  }
  return html(productCardHtml(key, rec, product));
}

// ---------------------------------------------------------------------------------------------------
// Plain product card (GiftFit's own markup, no merchant HTML)
// ---------------------------------------------------------------------------------------------------

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function money(price: number | null, currency: string | null): string | null {
  if (price === null || !currency) return null;
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).format(price);
  } catch {
    return `${price.toFixed(2)} ${currency}`;
  }
}

export function productCardHtml(key: string, rec: Pick<PreviewRecord, "domain" | "storeName">, p: PreviewProduct): string {
  const img = p.images.find((u) => u.startsWith("https://"));
  const price = money(p.price, p.currency);
  const url = p.url.startsWith("https://") ? p.url : null;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer"><title>${esc(p.title)}</title><style>
body{margin:0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1c1917;background:#fff}
main{max-width:960px;margin:0 auto;padding:24px 16px;display:grid;gap:24px}
@media(min-width:720px){main{grid-template-columns:1fr 1fr}}
img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:12px;background:#f5f5f4}
h1{font-size:28px;line-height:1.2;margin:0 0 8px}
a{color:inherit}
.btn{display:inline-block;margin-top:16px;padding:12px 24px;border-radius:999px;background:#1c1917;color:#fff;text-decoration:none}
.muted{color:#78716c;font-size:14px}
</style></head><body><main>
<p class="muted" style="grid-column:1/-1;margin:0"><a href="${esc(snapshotBasePath(key))}">← ${esc(rec.storeName ?? rec.domain)}</a></p>
<div>${img ? `<img src="${esc(img)}" alt="${esc(p.title)}">` : ""}</div>
<div><h1>${esc(p.title)}</h1>${price ? `<p>${esc(price)}</p>` : ""}${p.summary ? `<p class="muted">${esc(p.summary)}</p>` : ""}
${url ? `<a class="btn" href="${esc(url)}" target="_blank" rel="${LINK_REL}">View on ${esc(rec.domain)}</a>` : ""}</div>
</main></body></html>`;
}

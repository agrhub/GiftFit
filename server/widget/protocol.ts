/**
 * Widget postMessage protocol v1 (owner: A6, ADR-046). Browser-safe, no server imports.
 *
 * Two parties: the LOADER (client/plugin/giftfit.js, running in the store's page) and the FRAME
 * (/w, served by GiftFit inside an iframe the loader created). Every message is a plain object
 *
 *   { source: "giftfit-widget", v: 1, type: <type>, ...fields }
 *
 * Origin checks, both ways:
 *   - loader → frame: postMessage(msg, APP_ORIGIN) only; the loader accepts a message only when
 *     event.origin === APP_ORIGIN AND event.source === its own iframe's contentWindow.
 *   - frame → loader: postMessage(msg, parentOrigin) only, where parentOrigin is the `parent` query
 *     parameter (an exact http(s) origin, on GIFTFIT_WIDGET_ORIGINS when that is set, and equal to
 *     location.ancestorOrigins[0] where the browser exposes it); the frame accepts a message only when
 *     event.origin === parentOrigin AND event.source === window.parent.
 *
 * What crosses the boundary: product facts from the store page (host → frame) and UI state (frame →
 * host). Never a token, a request id, an email address or anything about the recipient: the host page
 * only learns that a gift link was created ("sent").
 *
 * Host → frame:
 *   context  { product: PdpSummary | null, page: { lang?, url? } }   after `ready`, and on SPA navigation
 *   open     {}                                                      GiftFit.openWidget()
 *   close    {}                                                      GiftFit.closeWidget()
 * Frame → host:
 *   ready    {}                                     the frame listens; the loader replies with `context`
 *   resize   { mode: "launcher" | "tip" | "panel" } fixed sizes chosen by the loader, never pixels
 *   sent     {}                                     a Fit Request was created (host event giftfit:sent)
 *   close    {}                                     the shopper closed the panel
 */

export const WIDGET_SOURCE = "giftfit-widget";
export const WIDGET_PROTOCOL_VERSION = 1;

export const FRAME_MODES = ["launcher", "tip", "panel"] as const;
export type FrameMode = (typeof FRAME_MODES)[number];

/** Sanitised product facts read from a store's product page (JSON-LD, Open Graph or DOM). */
export interface PdpSummary {
  title: string;
  price?: number;
  currency?: string;
  /** Absolute http(s) URL of the product image on the store. */
  image?: string;
  /** Absolute http(s) URL of the product page (no query or fragment). */
  url?: string;
  sku?: string;
  /** Which detector found it. */
  source: "json-ld" | "open-graph" | "dom" | "data-attribute";
}

export interface HostPageInfo {
  lang?: string;
  url?: string;
}

export type HostMessage =
  | { type: "context"; product: PdpSummary | null; page: HostPageInfo }
  | { type: "open" }
  | { type: "close" };

export type FrameMessage = { type: "ready" } | { type: "resize"; mode: FrameMode } | { type: "sent" } | { type: "close" };

export const PDP_LIMITS = { title: 160, sku: 64, url: 512, currency: 3, maxPrice: 10_000_000 } as const;

/** Collapses whitespace, drops control and bidi-override characters, caps the length. */
export function cleanText(v: unknown, max: number): string | undefined {
  if (typeof v !== "string" && typeof v !== "number") return undefined;
  const s = String(v)
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
  return s || undefined;
}

/** An absolute http(s) URL without credentials; `stripQuery` drops ?query and #fragment. */
export function cleanUrl(v: unknown, stripQuery = false): string | undefined {
  if (typeof v !== "string" || v.length > 2048) return undefined;
  try {
    const u = new URL(v.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
    if (u.username || u.password) return undefined;
    if (stripQuery) {
      u.search = "";
      u.hash = "";
    }
    const s = u.toString();
    return s.length <= PDP_LIMITS.url ? s : undefined;
  } catch {
    return undefined;
  }
}

/** "1,299.00" / "245" / 245 → number; nonsense or out of range → undefined. */
export function cleanPrice(v: unknown): number | undefined {
  let n: number;
  if (typeof v === "number") n = v;
  else if (typeof v === "string") {
    if (/^\s*-/.test(v)) return undefined;
    const s = v.replace(/[^\d.,]/g, "");
    if (!s) return undefined;
    // "1.299,00" (comma decimals) vs "1,299.00": the last separator with 1–2 digits after it is the decimal point.
    const m = /^(.*?)[.,](\d{1,2})$/.exec(s);
    n = m ? Number(`${m[1].replace(/[.,]/g, "")}.${m[2]}`) : Number(s.replace(/[.,]/g, ""));
  } else return undefined;
  return Number.isFinite(n) && n > 0 && n <= PDP_LIMITS.maxPrice ? Math.round(n * 100) / 100 : undefined;
}

export function cleanCurrency(v: unknown): string | undefined {
  return typeof v === "string" && /^[A-Za-z]{3}$/.test(v.trim()) ? v.trim().toUpperCase() : undefined;
}

const SOURCES: ReadonlySet<PdpSummary["source"]> = new Set(["json-ld", "open-graph", "dom", "data-attribute"]);

/** Re-validates a product summary from the (untrusted) host page; null when it has no title. */
export function sanitizePdp(raw: unknown): PdpSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const title = cleanText(r.title, PDP_LIMITS.title);
  if (!title) return null;
  const out: PdpSummary = { title, source: SOURCES.has(r.source as PdpSummary["source"]) ? (r.source as PdpSummary["source"]) : "dom" };
  const price = cleanPrice(r.price);
  if (price !== undefined) out.price = price;
  const currency = cleanCurrency(r.currency);
  if (currency) out.currency = currency;
  const image = cleanUrl(r.image);
  if (image) out.image = image;
  const url = cleanUrl(r.url, true);
  if (url) out.url = url;
  const sku = cleanText(r.sku, PDP_LIMITS.sku);
  if (sku) out.sku = sku;
  return out;
}

/** Parses a host → frame message (already origin-checked); null for anything malformed. */
export function parseHostMessage(data: unknown): HostMessage | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.source !== WIDGET_SOURCE || d.v !== WIDGET_PROTOCOL_VERSION || typeof d.type !== "string") return null;
  if (d.type === "open" || d.type === "close") return { type: d.type };
  if (d.type === "context") {
    const page = (d.page && typeof d.page === "object" ? d.page : {}) as Record<string, unknown>;
    const lang = cleanText(page.lang, 35);
    const url = cleanUrl(page.url, true);
    return { type: "context", product: sanitizePdp(d.product), page: { ...(lang ? { lang } : {}), ...(url ? { url } : {}) } };
  }
  return null;
}

/** Envelope for frame → host messages. */
export function frameMessage(msg: FrameMessage): Record<string, unknown> {
  return { source: WIDGET_SOURCE, v: WIDGET_PROTOCOL_VERSION, ...msg };
}

/** Parses a frame → host message (the loader's rules, mirrored here for tests and docs). */
export function parseFrameMessage(data: unknown): FrameMessage | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.source !== WIDGET_SOURCE || d.v !== WIDGET_PROTOCOL_VERSION) return null;
  if (d.type === "ready" || d.type === "sent" || d.type === "close") return { type: d.type };
  if (d.type === "resize" && (FRAME_MODES as readonly string[]).includes(d.mode as string)) return { type: "resize", mode: d.mode as FrameMode };
  return null;
}

/** A plain http(s) origin exactly as given (no path, query, credentials), or null. */
export function exactOrigin(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.username || u.password) return null;
    return u.origin === raw.replace(/\/$/, "") ? u.origin : null;
  } catch {
    return null;
  }
}

export interface MessageEventLike {
  origin: string;
  source: unknown;
  data: unknown;
}

/**
 * The frame's inbound check: the message must come from the expected parent window AND the
 * expected origin, then parse as a v1 host message.
 */
export function acceptHostMessage(e: MessageEventLike, parentOrigin: string | null, parentWindow: unknown): HostMessage | null {
  if (!parentOrigin || e.origin !== parentOrigin || !parentWindow || e.source !== parentWindow) return null;
  return parseHostMessage(e.data);
}

/**
 * Where the browser tells us who framed us (Chromium, WebKit: location.ancestorOrigins), the claimed
 * parent must be the direct ancestor. Browsers without ancestorOrigins (Firefox) rely on the
 * frame-ancestors CSP and the allow-list instead.
 */
export function parentMatchesAncestor(parentOrigin: string, ancestorOrigins: ArrayLike<string> | undefined | null): boolean {
  if (!ancestorOrigins || ancestorOrigins.length === 0) return true;
  return ancestorOrigins[0] === parentOrigin;
}

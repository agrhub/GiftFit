/**
 * Widget runtime configuration (owner: A6). Read at REQUEST time (middleware and the /w page), so a
 * Cloud Run env change takes effect without a rebuild.
 *
 *   GIFTFIT_WIDGET_ORIGINS   Store origins allowed to embed the widget, comma/space separated, e.g.
 *                            "https://giftfit-demo-store-xyz.a.run.app https://shop.example".
 *                            Used for the /w frame-ancestors CSP and the frame's postMessage allow-list.
 *                            GiftFit's own origin is always allowed. Unset or "*" = any https/http
 *                            origin (demo convenience; set it in production).
 *   GIFTFIT_FB_APP_ID        Optional Facebook app id: Messenger share uses the web Send Dialog with it,
 *                            else the fb-messenger:// mobile scheme.
 */

type Env = Record<string, string | undefined>;

/** A plain origin, or undefined for anything else (paths, wildcards, credentials). */
function originOf(raw: string): string | undefined {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
    if (u.username || u.password) return undefined;
    return u.origin;
  } catch {
    return undefined;
  }
}

/** The configured allow-list, or "*" when every origin is allowed. */
export function widgetOrigins(env: Env = process.env): string[] | "*" {
  const raw = env.GIFTFIT_WIDGET_ORIGINS?.trim();
  if (!raw || raw === "*") return "*";
  const list = raw
    .split(/[\s,]+/)
    .map((s) => originOf(s))
    .filter((s): s is string => Boolean(s));
  return [...new Set(list)];
}

/**
 * Store-URL previews (ADR-055): for `store=preview:<key>` whose preview is READY, the widget may run on
 * any https page (the owner's live site, through the bookmarklet), so both the frame-ancestors list and
 * the parent check also accept any https origin. Normal stores keep the strict allow-list. A preview
 * that is missing, expired or not ready gets the normal-store policy.
 */
export function isAnyHttpsOrigin(origin: string): boolean {
  const o = originOf(origin);
  return o === origin && o.startsWith("https://");
}

/**
 * May a page on `origin` host the widget? `self` is GiftFit's own origin (the request's), and
 * APP_BASE_URL's origin is always allowed too, so the GiftFit home page can show the assistant
 * whatever GIFTFIT_WIDGET_ORIGINS says.
 */
export function isWidgetOriginAllowed(origin: string | null | undefined, self?: string | null, env: Env = process.env, opts: { previewReady?: boolean } = {}): boolean {
  if (!origin) return false;
  const o = originOf(origin);
  if (!o || o !== origin) return false;
  if (opts.previewReady && isAnyHttpsOrigin(o)) return true;
  if (self && o === self) return true;
  const appBase = env.APP_BASE_URL?.trim() ? originOf(env.APP_BASE_URL.trim()) : undefined;
  if (appBase && o === appBase) return true;
  const list = widgetOrigins(env);
  return list === "*" ? true : list.includes(o);
}

/** The value of `Content-Security-Policy: frame-ancestors …` for /w. */
export function widgetFrameAncestors(env: Env = process.env, opts: { previewReady?: boolean } = {}): string {
  const list = widgetOrigins(env);
  if (list === "*") return "*";
  const appBase = env.APP_BASE_URL?.trim() ? originOf(env.APP_BASE_URL.trim()) : undefined;
  return ["'self'", ...(opts.previewReady ? ["https:"] : []), ...new Set([...(appBase ? [appBase] : []), ...list])].join(" ");
}

export function facebookAppId(env: Env = process.env): string | undefined {
  const id = env.GIFTFIT_FB_APP_ID?.trim();
  return id && /^\d{5,20}$/.test(id) ? id : undefined;
}

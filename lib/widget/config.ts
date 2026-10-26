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

/** May a page on `origin` host the widget? `self` is GiftFit's own origin (always allowed). */
export function isWidgetOriginAllowed(origin: string | null | undefined, self?: string | null, env: Env = process.env): boolean {
  if (!origin) return false;
  const o = originOf(origin);
  if (!o || o !== origin) return false;
  if (self && o === self) return true;
  const list = widgetOrigins(env);
  return list === "*" ? true : list.includes(o);
}

/** The value of `Content-Security-Policy: frame-ancestors …` for /w. */
export function widgetFrameAncestors(env: Env = process.env): string {
  const list = widgetOrigins(env);
  return list === "*" ? "*" : ["'self'", ...list].join(" ");
}

export function facebookAppId(env: Env = process.env): string | undefined {
  const id = env.GIFTFIT_FB_APP_ID?.trim();
  return id && /^\d{5,20}$/.test(id) ? id : undefined;
}

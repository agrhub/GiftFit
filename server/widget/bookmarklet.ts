/**
 * "Try it on your live site" bookmarklet for store-URL previews (owner: A6, ADR-055). Pure.
 *
 * In the user's OWN browser, on the page they are looking at, it adds exactly one
 *   <script src="<APP>/giftfit.js" data-store="preview:<key>" async data-giftfit-bookmarklet>
 * GiftFit never fetches, proxies or re-serves that page. Clicking again just opens the assistant.
 * When the page's Content Security Policy blocks the script or the widget frame (a
 * `securitypolicyviolation` for the GiftFit origin, or the script's error event), it shows a small
 * in-page notice linking back to the preview store, then removes it after 15 s.
 */
import { PREVIEW_KEY_RE } from "@/server/preview/repo";

/** Notice text (English: the bookmark runs on the merchant's page, outside GiftFit's i18n). */
export const BOOKMARKLET_BLOCKED_TEXT = "This site's security settings block the GiftFit preview here.";
export const BOOKMARKLET_BLOCKED_LINK = "Open your preview store";

function origin(raw: string): string {
  const u = new URL(raw);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("app origin must be http(s)");
  return u.origin;
}

/** The bookmarklet's JavaScript source (no `javascript:` prefix), for tests and the link. */
export function bookmarkletSource(appOrigin: string, key: string, previewUrl: string): string {
  if (!PREVIEW_KEY_RE.test(key)) throw new Error("invalid preview key");
  const A = JSON.stringify(origin(appOrigin));
  const S = JSON.stringify(`preview:${key}`);
  const P = JSON.stringify(new URL(previewUrl).toString());
  const T = JSON.stringify(BOOKMARKLET_BLOCKED_TEXT + " ");
  const L = JSON.stringify(BOOKMARKLET_BLOCKED_LINK);
  return `(function(){var A=${A},S=${S},P=${P},d=document,w=window;
if(w.GiftFit&&w.GiftFit.loaded){try{w.GiftFit.openWidget()}catch(e){}return}
if(d.querySelector("script[data-giftfit-bookmarklet]"))return;
function note(){if(d.getElementById("giftfit-bookmarklet-note"))return;var n=d.createElement("div");n.id="giftfit-bookmarklet-note";n.setAttribute("role","status");
n.style.cssText="all:initial;position:fixed;z-index:2147483647;right:16px;bottom:16px;max-width:320px;padding:12px 14px;background:#1f1a17;color:#fbf8f3;font:14px/1.4 system-ui,sans-serif;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.3)";
n.appendChild(d.createTextNode(${T}));var a=d.createElement("a");a.href=P;a.target="_blank";a.rel="noopener noreferrer";a.textContent=${L};a.style.cssText="color:#e9cf8a;text-decoration:underline";n.appendChild(a);
(d.body||d.documentElement).appendChild(n);setTimeout(function(){n.remove()},15000)}
d.addEventListener("securitypolicyviolation",function(e){if(String(e.blockedURI||"").indexOf(A)===0)note()});
var s=d.createElement("script");s.src=A+"/giftfit.js";s.async=true;s.setAttribute("data-store",S);s.setAttribute("data-giftfit-bookmarklet","");s.onerror=note;
(d.head||d.documentElement).appendChild(s)})();`.replace(/\n/g, "");
}

/** The `javascript:` URL to put in a draggable link (set it with setAttribute: React refuses javascript: hrefs). */
export function bookmarkletHref(appOrigin: string, key: string, previewUrl: string): string {
  return `javascript:${encodeURIComponent(bookmarkletSource(appOrigin, key, previewUrl))}`;
}

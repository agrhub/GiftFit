/**
 * E-card theme and share links for a gift link (owner: A6, ADR-046). Browser-safe.
 *
 * Share targets use each messenger's public URL scheme only (no SDKs, no app scripts):
 *   - WhatsApp:  https://wa.me/?text=<text>                       (official "click to chat" link)
 *   - Messenger: https://www.facebook.com/dialog/send?app_id&link&redirect_uri  when a Facebook app id
 *                is configured (web Send Dialog), else fb-messenger://share/?link=<url> (mobile app)
 *   - Zalo:      Zalo has no SDK-free share URL (its official share button needs the Zalo JS SDK and an
 *                Official Account id), so the widget uses the Web Share sheet where available (Zalo is a
 *                target there on phones) and otherwise copies the message and opens Zalo Web
 *                (https://chat.zalo.me/) to paste it.
 * The recipient link itself always comes from the server's response (APP_BASE_URL-based origin).
 */
import type { Occasion } from "@/lib/contracts/giftfit";
import { OCCASION_THEMES, type CardLang } from "@/lib/email/templates";
import { t } from "@/lib/i18n";

export const MAX_CARD_MESSAGE = 600;
export const MAX_GIVER_NAME = 60;
export const ZALO_WEB_URL = "https://chat.zalo.me/";

export interface CardTheme {
  occasion: Occasion;
  accent: string;
  tint: string;
  headline: string;
}

export function cardTheme(occasion: string | null | undefined, lang: CardLang): CardTheme {
  const key = (occasion && occasion in OCCASION_THEMES ? occasion : "just_because") as Occasion;
  const th = OCCASION_THEMES[key];
  return { occasion: key, accent: th.accent, tint: th.tint, headline: th.headline[lang] };
}

/** One line, no control characters, capped (for names). */
export function cleanName(v: unknown, max = MAX_GIVER_NAME): string {
  return typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim() : "";
}

/** Keeps line breaks, drops other control characters, caps the length. */
export function cleanMessage(v: unknown, max = MAX_CARD_MESSAGE): string {
  if (typeof v !== "string") return "";
  return v
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max)
    .trim();
}

/** http(s) only; anything else is refused so no share builder can be fed a javascript: link. */
function assertHttpUrl(link: string): string {
  const u = new URL(link);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("share link must be http(s)");
  return u.toString();
}

export interface ShareTextInput {
  lang: CardLang;
  occasion: string | null | undefined;
  message?: string;
  link: string;
}

/** The text a messenger share carries: headline, the giver's message, the link. */
export function shareText(i: ShareTextInput): string {
  const link = assertHttpUrl(i.link);
  const message = cleanMessage(i.message);
  return t(i.lang, "share.text", { headline: cardTheme(i.occasion, i.lang).headline, message: message ? `${message}\n` : "", link });
}

export function whatsappShareUrl(text: string): string {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

export function messengerShareUrl(link: string, opts: { appId?: string } = {}): string {
  const url = assertHttpUrl(link);
  if (opts.appId && /^\d{5,20}$/.test(opts.appId)) {
    const q = new URLSearchParams({ app_id: opts.appId, link: url, redirect_uri: url });
    return `https://www.facebook.com/dialog/send?${q.toString()}`;
  }
  return `fb-messenger://share/?link=${encodeURIComponent(url)}`;
}

export interface ShareLinks {
  whatsapp: string;
  messenger: string;
  zaloWeb: string;
  text: string;
}

export function shareLinks(i: ShareTextInput & { facebookAppId?: string }): ShareLinks {
  const text = shareText(i);
  return { text, whatsapp: whatsappShareUrl(text), messenger: messengerShareUrl(i.link, { appId: i.facebookAppId }), zaloWeb: ZALO_WEB_URL };
}

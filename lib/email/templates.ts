/**
 * Email templates (owner: A12): the recipient's gift card and the giver's "Fit Report ready" note.
 *
 * - Every interpolated value is HTML-escaped; free text is cleaned and capped.
 * - Each template returns an HTML body AND a plain-text alternative.
 * - No images, no remote resources, no tracking pixels, no click-tracking redirects: the only
 *   links are the CTA (built from appBaseUrl) and nothing else.
 * - Footer: "Didn't expect this? Ignore it — the link expires in 72 h. Report abuse: reply to this email."
 * - Languages (ADR-057): the ten widget languages (copy.ts), English for anything else.
 */
import type { Occasion } from "../contracts/giftfit";
import { sanitizeHeaderText } from "./address";
import { cleanText, escapeHtml, escapeMultiline, safeHref } from "./escape";
import { appBaseUrl, giverReportUrl, recipientUrl } from "./links";
import { LOCALES, normalizeLocale, type Locale } from "@/lib/i18n";
import { EMAIL_COPY, HEADLINES, LINK_TTL_HOURS } from "./copy";

/** Card / e-mail language: any widget language (the giver's conversation language, ADR-057). */
export type CardLang = Locale;
export const CARD_LANGS: readonly CardLang[] = LOCALES;
export { LINK_TTL_HOURS };

export const MAX_GIVER_NAME = 60;
export const MAX_RECIPIENT_NAME = 60;
export const MAX_PERSONAL_MESSAGE = 600;

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

interface Theme {
  accent: string;
  tint: string;
  headline: Record<CardLang, string>;
}

const THEME_COLORS: Record<Occasion, { accent: string; tint: string }> = {
  anniversary: { accent: "#b4234d", tint: "#fdf0f3" },
  birthday: { accent: "#c2410c", tint: "#fff4ec" },
  wedding: { accent: "#8a6d3b", tint: "#faf6ee" },
  holiday: { accent: "#2b7a3e", tint: "#eff8f1" },
  graduation: { accent: "#1c4e80", tint: "#eef4fa" },
  thank_you: { accent: "#5f3dc4", tint: "#f4f0fd" },
  just_because: { accent: "#0b7285", tint: "#ecf8fa" },
};

export const OCCASION_THEMES: Record<Occasion, Theme> = Object.fromEntries(
  (Object.keys(THEME_COLORS) as Occasion[]).map((o) => [o, { ...THEME_COLORS[o], headline: HEADLINES[o] }]),
) as Record<Occasion, Theme>;

export function themeFor(occasion: string | null | undefined): Theme & { occasion: Occasion } {
  const key = (occasion && occasion in OCCASION_THEMES ? occasion : "just_because") as Occasion;
  return { ...OCCASION_THEMES[key], occasion: key };
}

/** Any language tag → its card language: one of the ten widget languages, else English. */
export function normalizeLang(lang: unknown): CardLang {
  return normalizeLocale(lang) ?? "en";
}

const COPY = EMAIL_COPY;

/** Name for subjects and greetings: one line, no control characters, capped. */
function cleanName(v: unknown, max: number): string {
  return sanitizeHeaderText(cleanText(v, max * 2), max);
}

interface LayoutInput {
  lang: CardLang;
  accent: string;
  tint: string;
  preheader: string;
  /** Already-escaped HTML. */
  bodyHtml: string;
  ctaLabel: string;
  ctaUrl: string;
}

function layout(i: LayoutInput): string {
  const c = COPY[i.lang];
  const href = safeHref(i.ctaUrl);
  return `<!doctype html>
<html lang="${i.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only">
<title>GiftFit</title>
</head>
<body style="margin:0;padding:0;background:#f6f5f3;color:#1f1d1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(i.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f5f3;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;border-top:6px solid ${i.accent};">
<tr><td style="padding:28px 28px 8px 28px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:${i.accent};font-weight:600;">GiftFit</td></tr>
<tr><td style="padding:0 28px 8px 28px;font-size:16px;line-height:1.55;">${i.bodyHtml}</td></tr>
<tr><td style="padding:16px 28px 8px 28px;" align="left">
<a href="${href}" style="display:inline-block;background:${i.accent};color:#ffffff;text-decoration:none;font-weight:600;font-size:16px;padding:12px 22px;border-radius:8px;">${escapeHtml(i.ctaLabel)}</a>
</td></tr>
<tr><td style="padding:8px 28px 24px 28px;font-size:13px;line-height:1.5;color:#5b5750;">${escapeHtml(c.linkFallback)}<br><a href="${href}" style="color:${i.accent};word-break:break-all;">${escapeHtml(i.ctaUrl)}</a></td></tr>
<tr><td style="padding:16px 28px 28px 28px;border-top:1px solid #ece9e4;font-size:12px;line-height:1.5;color:#77726a;background:${i.tint};border-radius:0 0 12px 12px;">${escapeHtml(c.footer)}<br>${escapeHtml(c.footerNoList)}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function textFooter(lang: CardLang): string {
  const c = COPY[lang];
  return `--\n${c.footer}\n${c.footerNoList}`;
}

export interface GiftCardEmailInput {
  occasion: Occasion | string | null | undefined;
  lang?: CardLang | string;
  giverName?: string;
  recipientName?: string;
  /** The giver's personal message (plain text; escaped here, line breaks kept). */
  message?: string;
  /** The recipient token for {base}/r/{token}. */
  recipientToken: string;
  /** false for a gift without a try-on (store-URL previews, ADR-055): no "camera" or "photos" copy. */
  tryOn?: boolean;
  /** Origin for links; default appBaseUrl() (APP_BASE_URL, else localhost). Pass appBaseUrl(req) in routes. */
  baseUrl?: string;
}

export function giftCardEmail(input: GiftCardEmailInput): RenderedEmail {
  const lang = normalizeLang(input.lang);
  const c = COPY[lang];
  const theme = themeFor(input.occasion);
  const giver = cleanName(input.giverName, MAX_GIVER_NAME);
  const recipient = cleanName(input.recipientName, MAX_RECIPIENT_NAME);
  const message = cleanText(input.message, MAX_PERSONAL_MESSAGE);
  const url = recipientUrl(input.recipientToken, input.baseUrl ?? appBaseUrl());
  const headline = theme.headline[lang];
  const intro = c.giftIntro(giver, recipient);
  const body = input.tryOn === false ? c.giftBodyNoTryOn(giver) : c.giftBody(giver);

  const quote = message
    ? `<p style="margin:16px 0 4px 0;font-size:13px;color:#5b5750;">${escapeHtml(c.giftMessageLabel(giver))}</p>
<blockquote style="margin:0 0 16px 0;padding:12px 16px;background:${theme.tint};border-left:4px solid ${theme.accent};border-radius:6px;font-style:italic;">${escapeMultiline(message)}</blockquote>`
    : "";
  const bodyHtml = `<h1 style="margin:0 0 12px 0;font-size:26px;line-height:1.25;color:${theme.accent};">${escapeHtml(headline)}</h1>
<p style="margin:0 0 12px 0;">${escapeHtml(intro)}</p>
${quote}<p style="margin:0 0 4px 0;">${escapeHtml(body)}</p>`;

  const text = [
    headline,
    "",
    intro,
    ...(message ? ["", `${c.giftMessageLabel(giver)}:`, ...message.split("\n").map((l) => `> ${l}`)] : []),
    "",
    body,
    "",
    `${c.giftCta}: ${url}`,
    "",
    textFooter(lang),
  ].join("\n");

  return {
    subject: sanitizeHeaderText(c.giftSubject(giver)),
    html: layout({ lang, accent: theme.accent, tint: theme.tint, preheader: intro, bodyHtml, ctaLabel: c.giftCta, ctaUrl: url }),
    text,
  };
}

export interface FitReportReadyEmailInput {
  lang?: CardLang | string;
  giverName?: string;
  recipientName?: string;
  /** The giver token for {base}/g/{token}. */
  giverToken: string;
  occasion?: Occasion | string | null;
  /** false for a gift without a try-on (store-URL previews, ADR-055): no "trying on" copy. */
  tryOn?: boolean;
  baseUrl?: string;
}

export function fitReportReadyEmail(input: FitReportReadyEmailInput): RenderedEmail {
  const lang = normalizeLang(input.lang);
  const c = COPY[lang];
  const theme = themeFor(input.occasion);
  const giver = cleanName(input.giverName, MAX_GIVER_NAME);
  const recipient = cleanName(input.recipientName, MAX_RECIPIENT_NAME);
  const url = giverReportUrl(input.giverToken, input.baseUrl ?? appBaseUrl());
  const subject = sanitizeHeaderText(c.reportSubject(recipient));
  const noTryOn = input.tryOn === false;
  const intro = noTryOn ? c.reportIntroNoTryOn(giver, recipient) : c.reportIntro(giver, recipient);
  const reportBody = noTryOn ? c.reportBodyNoTryOn : c.reportBody;
  const bodyHtml = `<h1 style="margin:0 0 12px 0;font-size:24px;line-height:1.25;color:${theme.accent};">${escapeHtml(subject)}</h1>
<p style="margin:0 0 12px 0;">${escapeHtml(intro)}</p>
<p style="margin:0 0 4px 0;">${escapeHtml(reportBody)}</p>`;
  const text = [subject, "", intro, "", reportBody, "", `${c.reportCta}: ${url}`, "", textFooter(lang)].join("\n");
  return {
    subject,
    html: layout({ lang, accent: theme.accent, tint: theme.tint, preheader: intro, bodyHtml, ctaLabel: c.reportCta, ctaUrl: url }),
    text,
  };
}

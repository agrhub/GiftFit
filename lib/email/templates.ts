/**
 * Email templates (owner: A12): the recipient's gift card and the giver's "Fit Report ready" note.
 *
 * - Every interpolated value is HTML-escaped; free text is cleaned and capped.
 * - Each template returns an HTML body AND a plain-text alternative.
 * - No images, no remote resources, no tracking pixels, no click-tracking redirects: the only
 *   links are the CTA (built from appBaseUrl) and nothing else.
 * - Footer: "Didn't expect this? Ignore it — the link expires in 72 h. Report abuse: reply to this email."
 */
import type { Occasion } from "../contracts/giftfit";
import { sanitizeHeaderText } from "./address";
import { cleanText, escapeHtml, escapeMultiline, safeHref } from "./escape";
import { appBaseUrl, giverReportUrl, recipientUrl } from "./links";

export type CardLang = "en" | "vi";
export const CARD_LANGS: readonly CardLang[] = ["en", "vi"];

export const MAX_GIVER_NAME = 60;
export const MAX_RECIPIENT_NAME = 60;
export const MAX_PERSONAL_MESSAGE = 600;
export const LINK_TTL_HOURS = 72;

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

export const OCCASION_THEMES: Record<Occasion, Theme> = {
  anniversary: { accent: "#b4234d", tint: "#fdf0f3", headline: { en: "Happy anniversary", vi: "Chúc mừng kỷ niệm" } },
  birthday: { accent: "#c2410c", tint: "#fff4ec", headline: { en: "Happy birthday", vi: "Chúc mừng sinh nhật" } },
  wedding: { accent: "#8a6d3b", tint: "#faf6ee", headline: { en: "Congratulations on your wedding", vi: "Chúc mừng ngày cưới" } },
  holiday: { accent: "#2b7a3e", tint: "#eff8f1", headline: { en: "Happy holidays", vi: "Chúc mừng ngày lễ" } },
  graduation: { accent: "#1c4e80", tint: "#eef4fa", headline: { en: "Congratulations, graduate", vi: "Chúc mừng tốt nghiệp" } },
  thank_you: { accent: "#5f3dc4", tint: "#f4f0fd", headline: { en: "Thank you", vi: "Cảm ơn bạn" } },
  just_because: { accent: "#0b7285", tint: "#ecf8fa", headline: { en: "A little something for you", vi: "Một món quà nhỏ dành cho bạn" } },
};

export function themeFor(occasion: string | null | undefined): Theme & { occasion: Occasion } {
  const key = (occasion && occasion in OCCASION_THEMES ? occasion : "just_because") as Occasion;
  return { ...OCCASION_THEMES[key], occasion: key };
}

export function normalizeLang(lang: unknown): CardLang {
  return lang === "vi" ? "vi" : "en";
}

const COPY = {
  en: {
    footer: `Didn't expect this? Ignore it — the link expires in ${LINK_TTL_HOURS} h. Report abuse: reply to this email.`,
    footerNoList: "This is a one-off message about a single gift. We have not added you to any mailing list.",
    giftSubject: (giver: string) => (giver ? `${giver} sent you a gift card` : "You've received a GiftFit gift card"),
    giftIntro: (giver: string, recipient: string) =>
      `${recipient ? `Hi ${recipient}, ` : ""}${giver || "Someone"} would like to find the jewelry that suits you best.`,
    giftBody: (giver: string) =>
      `Try a few pieces on with your phone camera and heart the ones you love. ${giver || "The sender"} sees only which pieces suit you, never your photos.`,
    giftBodyNoTryOn: (giver: string) => `Look through a few pieces from the store and heart the ones you love. No photo is needed; ${giver || "the sender"} sees only which pieces you hearted.`,
    giftMessageLabel: (giver: string) => `A message from ${giver || "the sender"}`,
    giftCta: "Open your gift",
    reportSubject: (recipient: string) => (recipient ? `${recipient}'s Fit Report is ready` : "Your Fit Report is ready"),
    reportIntro: (giver: string, recipient: string) =>
      `${giver ? `Hi ${giver}, ` : ""}${recipient || "Your recipient"} has finished trying on. Your Fit Report shows which pieces suit them best and why.`,
    reportIntroNoTryOn: (giver: string, recipient: string) =>
      `${giver ? `Hi ${giver}, ` : ""}${recipient || "Your recipient"} has sent their hearts. Your Fit Report shows which pieces they loved and why.`,
    reportBody: "Their photos are never shared with you; the report contains scores and short reasons only.",
    reportBodyNoTryOn: "No photo of them was taken; the report contains their hearts, scores and short reasons only.",
    reportCta: "See the Fit Report",
    linkFallback: "If the button does not work, copy this link into your browser:",
  },
  vi: {
    footer: `Không mong đợi email này? Hãy bỏ qua — liên kết hết hạn sau ${LINK_TTL_HOURS} giờ. Báo cáo lạm dụng: trả lời email này.`,
    footerNoList: "Đây là thư gửi một lần cho một món quà. Chúng tôi không thêm bạn vào danh sách thư nào.",
    giftSubject: (giver: string) => (giver ? `${giver} đã gửi bạn một thiệp quà` : "Bạn nhận được một thiệp quà GiftFit"),
    giftIntro: (giver: string, recipient: string) =>
      `${recipient ? `Chào ${recipient}, ` : ""}${giver || "Một người"} muốn tìm món trang sức hợp với bạn nhất.`,
    giftBody: (giver: string) =>
      `Hãy thử vài món bằng camera điện thoại và thả tim những món bạn thích. ${giver || "Người gửi"} chỉ biết món nào hợp với bạn, không bao giờ thấy ảnh của bạn.`,
    giftBodyNoTryOn: (giver: string) => `Hãy xem vài món của cửa hàng và thả tim những món bạn thích. Không cần chụp ảnh; ${giver || "người gửi"} chỉ biết bạn đã thả tim món nào.`,
    giftMessageLabel: (giver: string) => `Lời nhắn từ ${giver || "người gửi"}`,
    giftCta: "Mở quà của bạn",
    reportSubject: (recipient: string) => (recipient ? `Fit Report của ${recipient} đã sẵn sàng` : "Fit Report của bạn đã sẵn sàng"),
    reportIntro: (giver: string, recipient: string) =>
      `${giver ? `Chào ${giver}, ` : ""}${recipient || "Người nhận"} đã thử xong. Fit Report cho biết món nào hợp nhất và vì sao.`,
    reportIntroNoTryOn: (giver: string, recipient: string) =>
      `${giver ? `Chào ${giver}, ` : ""}${recipient || "Người nhận"} đã thả tim xong. Fit Report cho biết họ thích món nào và vì sao.`,
    reportBody: "Ảnh của người nhận không bao giờ được chia sẻ với bạn; báo cáo chỉ có điểm số và lý do ngắn gọn.",
    reportBodyNoTryOn: "Không có ảnh nào của người nhận được chụp; báo cáo chỉ có món họ thả tim, điểm số và lý do ngắn gọn.",
    reportCta: "Xem Fit Report",
    linkFallback: "Nếu nút không hoạt động, hãy sao chép liên kết này vào trình duyệt:",
  },
} as const;

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

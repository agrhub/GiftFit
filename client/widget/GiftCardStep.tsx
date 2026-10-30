"use client";
/**
 * After the Fit Request exists (owner: A6): a themed e-card per occasion (server/email OCCASION_THEMES)
 * with the giver's message in the card language they pick, then share (copy, QR, WhatsApp, Messenger,
 * Zalo, Web Share), "Send by email" (POST /api/widget/send-card), the optional "tell me when the Fit
 * Report is ready" address (POST /api/widget/notify) and the giver's private report link.
 * Tokens stay in this frame: nothing here is posted to the host page.
 *
 * The message starts as the occasion's default in the card language (card.defaultMessage.<occasion>)
 * and follows occasion and card-language changes until the giver edits it. The step scrolls; the
 * e-card never shrinks (shrink-0), since a flex child with overflow-hidden would collapse to its border.
 * The card starts in the widget's language, which follows the giver's conversation (ADR-057: one of the
 * ten widget languages, English for any other); the picker offers all ten (CARD_LANGS), and the e-card,
 * share text and e-mails use the one picked.
 */
import { useEffect, useId, useMemo, useState } from "react";
import type { CreateFitRequestResponse } from "@/server/contracts/api";
import { CARD_LANGS, normalizeLang, type CardLang } from "@/server/email/templates";
import { formatMoney, t as translate, type Locale, type MessageKey } from "@/server/i18n";
import { cardTheme, cleanMessage, cleanName, MAX_CARD_MESSAGE, MAX_GIVER_NAME, shareLinks } from "@/server/widget/share";
import { QrCode } from "@/client/gift/QrCode";

export interface GiftCardStepProps {
  locale: Locale;
  tr: (key: MessageKey, vars?: Record<string, string | number>) => string;
  result: CreateFitRequestResponse;
  occasion: string;
  /** Origin for links (APP_BASE_URL on the server, else this frame's origin). */
  baseUrl: string;
  facebookAppId?: string;
  onNewGift(): void;
  fetchImpl?: typeof fetch;
}

const recipientTokenOf = (path: string) => path.split("/").filter(Boolean).pop() ?? "";
const EMAIL_RE = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;

async function postJson(fetchImpl: typeof fetch, url: string, body: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, data };
}

export function GiftCardStep({ locale, tr, result, occasion, baseUrl, facebookAppId, onNewGift, fetchImpl }: GiftCardStepProps) {
  const ids = { lang: useId(), msg: useId(), name: useId(), to: useId(), me: useId() };
  const doFetch = fetchImpl ?? fetch;
  const [cardLang, setCardLang] = useState<CardLang>(normalizeLang(locale));
  /** null until the giver edits the message: until then it is the occasion's default. */
  const [edited, setEdited] = useState<string | null>(null);
  const [giverName, setGiverName] = useState("");
  const [status, setStatus] = useState("");
  const [showQr, setShowQr] = useState(false);
  const [canShare, setCanShare] = useState(false);
  const [to, setTo] = useState("");
  const [emailState, setEmailState] = useState<{ busy: boolean; msg?: string; ok?: boolean }>({ busy: false });
  const [me, setMe] = useState("");
  const [notifyState, setNotifyState] = useState<{ busy: boolean; msg?: string; ok?: boolean }>({ busy: false });

  useEffect(() => setCanShare(typeof navigator !== "undefined" && typeof navigator.share === "function"), []);

  const link = `${baseUrl}${result.recipientPath}`;
  const reportLink = `${baseUrl}${result.giverReportPath}`;
  const theme = cardTheme(occasion, cardLang);
  const ct = (key: MessageKey, vars?: Record<string, string | number>) => translate(cardLang, key, vars);
  const defaultMessage = ct(`card.defaultMessage.${theme.occasion}` as MessageKey);
  const message = edited ?? defaultMessage;
  const cleanMsg = cleanMessage(message);
  const name = cleanName(giverName);
  const links = useMemo(() => shareLinks({ lang: cardLang, occasion, message: cleanMsg, link, facebookAppId }), [cardLang, occasion, cleanMsg, link, facebookAppId]);

  async function copy(text: string, ok: string) {
    try {
      await navigator.clipboard.writeText(text);
      setStatus(ok);
      return true;
    } catch {
      setStatus(tr("share.copyFailed"));
      return false;
    }
  }

  async function nativeShare() {
    try {
      await navigator.share({ title: theme.headline, text: links.text });
    } catch {
      /* closed */
    }
  }

  async function zalo() {
    if (canShare) return nativeShare();
    if (await copy(links.text, tr("share.zaloCopied"))) window.open(links.zaloWeb, "_blank", "noopener,noreferrer");
  }

  async function sendEmail(e: React.FormEvent) {
    e.preventDefault();
    if (!EMAIL_RE.test(to.trim())) return setEmailState({ busy: false, msg: tr("email.invalid") });
    setEmailState({ busy: true });
    try {
      const { status: code, data } = await postJson(doFetch, "/api/widget/send-card", {
        giverToken: result.giverToken,
        recipientToken: recipientTokenOf(result.recipientPath),
        to: to.trim(),
        lang: cardLang,
        message: cleanMsg || undefined,
        giverName: name || undefined,
      });
      if (code === 200) setEmailState({ busy: false, ok: true, msg: data.delivery === "logged" ? tr("email.logged") : tr("email.sent") });
      else setEmailState({ busy: false, msg: tr(code === 429 ? "email.rateLimited" : data.error === "invalid_email" ? "email.invalid" : "email.error") });
    } catch {
      setEmailState({ busy: false, msg: tr("email.error") });
    }
  }

  async function notifyMe(e: React.FormEvent) {
    e.preventDefault();
    if (!EMAIL_RE.test(me.trim())) return setNotifyState({ busy: false, msg: tr("email.invalid") });
    setNotifyState({ busy: true });
    try {
      const { status: code, data } = await postJson(doFetch, "/api/widget/notify", { giverToken: result.giverToken, email: me.trim(), lang: locale, giverName: name || undefined });
      if (code === 200 && data.saved) setNotifyState({ busy: false, ok: true, msg: tr("notify.saved") });
      else if (code === 200 && data.ready) setNotifyState({ busy: false, ok: true, msg: tr("launcher.tipReady") });
      else setNotifyState({ busy: false, msg: tr(code === 429 ? "email.rateLimited" : code === 400 ? "email.invalid" : "email.error") });
    } catch {
      setNotifyState({ busy: false, msg: tr("email.error") });
    }
  }

  const field = "w-full rounded-xl border border-line-strong bg-white px-3 py-2 text-base text-ink placeholder:text-muted focus-visible:outline-2 focus-visible:outline-ink";
  // An address field beside its button: at least 10rem wide, else the button (long in de, fr, id) wraps below it.
  const inlineField = "min-w-0 flex-[1_1_10rem]";
  const pill = "inline-flex min-h-11 items-center justify-center rounded-full border border-line-strong bg-white px-4 text-sm text-ink hover:border-ink";

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto bg-ivory p-4 [&>*]:shrink-0" data-testid="widget-card-step">
      <div>
        <h2 className="font-display text-2xl text-ink">{tr("card.heading")}</h2>
        <p className="text-sm text-ink-soft">{tr("card.ready")}</p>
      </div>

      <div className="grid grid-cols-1 gap-3">
        <label htmlFor={ids.lang} className="text-sm font-medium text-ink">
          {tr("card.language")}
          <select id={ids.lang} value={cardLang} onChange={(e) => setCardLang(e.target.value as CardLang)} className={`${field} mt-1`} data-testid="widget-card-lang">
            {CARD_LANGS.map((l) => (
              <option key={l} value={l}>
                {tr(`lang.${l}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor={ids.msg} className="text-sm font-medium text-ink">
          {tr("card.message")}
          <textarea id={ids.msg} value={message} onChange={(e) => setEdited(e.target.value)} maxLength={MAX_CARD_MESSAGE} rows={3} placeholder={defaultMessage} className={`${field} mt-1 resize-none`} data-testid="widget-card-message" />
        </label>
        <label htmlFor={ids.name} className="text-sm font-medium text-ink">
          {tr("card.giverName")}
          <input id={ids.name} value={giverName} onChange={(e) => setGiverName(e.target.value)} maxLength={MAX_GIVER_NAME} autoComplete="given-name" className={`${field} mt-1`} />
        </label>
      </div>

      {/* The e-card, as the recipient will see it (same theme as the e-mail). */}
      <figure aria-label={tr("card.preview")} lang={cardLang} className="shrink-0 overflow-hidden rounded-2xl bg-white shadow-sm" style={{ borderTop: `6px solid ${theme.accent}` }} data-testid="widget-ecard" data-occasion={theme.occasion}>
        <div className="p-5">
          <p className="text-xs font-semibold tracking-[0.18em] uppercase" style={{ color: theme.accent }}>
            GiftFit
          </p>
          <p className="mt-2 font-display text-3xl leading-tight" style={{ color: theme.accent }}>
            {theme.headline}
          </p>
          <p className="mt-2 text-sm text-ink">{ct("card.intro", { giver: name || ct("card.someone") })}</p>
          {cleanMsg && (
            <blockquote className="mt-3 rounded-md px-3 py-2 text-sm whitespace-pre-wrap italic text-ink" style={{ background: theme.tint, borderLeft: `4px solid ${theme.accent}` }}>
              <span className="sr-only">{ct("card.messageFrom", { giver: name || ct("card.someone") })}: </span>
              {cleanMsg}
            </blockquote>
          )}
          <p className="mt-3 text-xs text-ink-soft">{ct(result.tryOn === false ? "card.bodyNoTryOn" : "card.body")}</p>
          <span className="mt-3 inline-block rounded-lg px-4 py-2 text-sm font-semibold text-white" style={{ background: theme.accent }}>
            {ct("card.cta")}
          </span>
        </div>
      </figure>

      {result.products?.length ? (
        // Store-URL previews (ADR-055): the giver's pieces from the frozen snapshot (merchant images, no Referer).
        <ul aria-label={tr("card.pieces")} className="flex flex-col gap-2" data-testid="widget-card-pieces">
          {result.products.map((p) => (
            <li key={p.catalogId} className="flex items-center gap-3 rounded-xl border border-line bg-white p-2">
              {p.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={p.image} alt="" width={48} height={48} loading="lazy" referrerPolicy="no-referrer" className="h-12 w-12 shrink-0 rounded-lg object-cover" />
              ) : null}
              <div className="min-w-0">
                <a href={p.url} target="_blank" rel="noopener noreferrer nofollow" className="block truncate text-sm text-ink underline-offset-2 hover:underline">
                  {p.title}
                </a>
                {p.price !== null && p.currency ? <p className="text-xs text-muted">{formatMoney(locale, p.price, p.currency)}</p> : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      <section aria-label={tr("share.heading")} className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-ink">{tr("share.heading")}</h3>
        <input readOnly value={link} aria-label={tr("share.heading")} onFocus={(e) => e.currentTarget.select()} className={`${field} text-sm`} data-testid="widget-share-link" />
        <div className="flex flex-wrap gap-2">
          <button type="button" className={pill} onClick={() => void copy(link, tr("share.copied"))} data-testid="widget-copy">
            {tr("share.copy")}
          </button>
          <button type="button" className={pill} aria-expanded={showQr} onClick={() => setShowQr((v) => !v)}>
            {tr("share.qr")}
          </button>
          <a className={pill} href={links.whatsapp} target="_blank" rel="noopener noreferrer" data-testid="widget-share-whatsapp">
            {tr("share.whatsapp")}
          </a>
          <a className={pill} href={links.messenger} target="_blank" rel="noopener noreferrer" data-testid="widget-share-messenger">
            {tr("share.messenger")}
          </a>
          <button type="button" className={pill} onClick={() => void zalo()} data-testid="widget-share-zalo">
            {tr("share.zalo")}
          </button>
          {canShare && (
            <button type="button" className={pill} onClick={() => void nativeShare()}>
              {tr("share.more")}
            </button>
          )}
        </div>
        {showQr && (
          <div className="self-start rounded-xl bg-white p-2">
            <QrCode value={link} label={tr("share.qrLabel")} size={160} />
          </div>
        )}
        <p role="status" className="min-h-5 text-xs text-sage">
          {status}
        </p>
      </section>

      <form onSubmit={sendEmail} className="flex flex-col gap-2" aria-label={tr("email.heading")}>
        <h3 className="text-sm font-semibold text-ink">{tr("email.heading")}</h3>
        <label htmlFor={ids.to} className="sr-only">
          {tr("email.to")}
        </label>
        <div className="flex flex-wrap gap-2">
          <input id={ids.to} type="email" inputMode="email" autoComplete="off" placeholder={tr("email.to")} value={to} onChange={(e) => setTo(e.target.value)} className={`${field} ${inlineField}`} data-testid="widget-email-to" />
          <button type="submit" disabled={emailState.busy || !to.trim()} className="min-h-11 shrink-0 rounded-full bg-ink px-4 text-sm font-medium text-ivory disabled:opacity-50" data-testid="widget-email-send">
            {emailState.busy ? tr("email.sending") : tr("email.send")}
          </button>
        </div>
        <p className="text-[11px] leading-4 text-muted">{tr("email.privacy")}</p>
        {emailState.msg && (
          <p role={emailState.ok ? "status" : "alert"} className={`text-sm ${emailState.ok ? "text-sage" : "text-rose"}`} data-testid="widget-email-result">
            {emailState.msg}
          </p>
        )}
      </form>

      <section className="flex flex-col gap-2 rounded-2xl border border-line bg-white p-4" aria-label={tr("report.private")}>
        <h3 className="text-sm font-semibold text-ink">{tr("report.private")}</h3>
        <a href={reportLink} target="_blank" rel="noopener noreferrer" className="min-h-11 rounded-full border border-ink px-4 py-3 text-center text-sm font-medium text-ink hover:bg-ink hover:text-ivory" data-testid="widget-report-link">
          {tr("report.open")}
        </a>
        <p className="text-xs text-ink-soft">{tr("notify.browser")}</p>
        <form onSubmit={notifyMe} className="mt-2 flex flex-col gap-2" aria-label={tr("notify.heading")}>
          <label htmlFor={ids.me} className="text-sm font-medium text-ink">
            {tr("notify.heading")}
          </label>
          <div className="flex flex-wrap gap-2">
            <input id={ids.me} type="email" inputMode="email" autoComplete="email" placeholder={tr("notify.email")} value={me} onChange={(e) => setMe(e.target.value)} className={`${field} ${inlineField}`} data-testid="widget-notify-email" />
            <button type="submit" disabled={notifyState.busy || !me.trim()} className="min-h-11 shrink-0 rounded-full border border-ink px-4 text-sm font-medium text-ink disabled:opacity-50" data-testid="widget-notify-save">
              {tr("notify.save")}
            </button>
          </div>
          <p className="text-[11px] leading-4 text-muted">{tr("notify.privacy")}</p>
          {notifyState.msg && (
            <p role={notifyState.ok ? "status" : "alert"} className={`text-sm ${notifyState.ok ? "text-sage" : "text-rose"}`} data-testid="widget-notify-result">
              {notifyState.msg}
            </p>
          )}
        </form>
      </section>

      <button type="button" onClick={onNewGift} className="min-h-11 rounded-full border border-line-strong px-6 text-sm text-ink-soft">
        {tr("report.newGift")}
      </button>
    </div>
  );
}

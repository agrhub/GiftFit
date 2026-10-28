"use client";
/**
 * The widget's Concierge conversation (owner: A6). State and streaming come from A7's
 * useConciergeChat (same /api/concierge NDJSON contract as ConciergePanel); this file is the compact,
 * translated UI. The page context (product facts only) rides along with every message.
 * Voice (A4, P8.3): an optional push-to-talk mic next to Send; the transcript is sent as the
 * shopper's message (marked "said by voice"), and each finished reply is handed to `voice.onReply`.
 */
import Image from "next/image";
import { useEffect, useId, useRef, useState } from "react";
import type { GiftBrief } from "@/lib/contracts/api";
import { CONCIERGE_LIMITS, type ConciergePageContext } from "@/lib/concierge/types";
import { formatMoney, type Locale, type MessageKey } from "@/lib/i18n";
import { useConciergeChat, type ConciergeTurn, type ConciergeTurnError } from "@/components/gift/concierge/useConciergeChat";
import type { CharacterState } from "./CharacterSlot";
import { MicButton, type MicPhase } from "./voice/MicButton";
import { micSupported } from "./voice/recorder";

export interface WidgetChatVoice {
  /** The widget's UI language, sent with each clip (chirp_3 identifies the spoken language itself). */
  lang: Locale;
  sessionId: string;
  onMicStart(): void;
  onMicPhase(p: MicPhase): void;
  /** A reply finished streaming (not stopped, no error): speak it if voice is on, in its own language. */
  onReply(text: string): void;
  /** The shopper sent a new message: stop any speech. */
  onSend(): void;
}

export interface WidgetChatProps {
  locale: Locale;
  tr: (key: MessageKey, vars?: Record<string, string | number>) => string;
  context?: ConciergePageContext;
  /** Title of the matched product (quick replies "Gift this piece" / "Help me choose"). */
  productTitle?: string;
  onBrief(brief: GiftBrief, suggestionTitles: string[]): void;
  /** Every message the shopper sends (the UI follows its language when that is clear); `spokenLang` for the mic's. */
  onUserMessage?(text: string, spokenLang?: string): void;
  /** The page / browser language (BCP 47) sent to the Concierge for messages whose language is unclear. */
  langHint?: string;
  /** Character state + mouth amplitude while replies stream. */
  onActivity?(state: CharacterState, mouth: number): void;
  fetchImpl?: typeof fetch;
  voice?: WidgetChatVoice;
  /** "preview:<key>" for a store-URL preview (ADR-055): the Concierge grounds on that catalog. */
  store?: string;
  /** The preview owner's greeting (Admin v0), shown instead of the default intro. */
  greeting?: string;
  /** The preview owner's accent colour for the Send button. */
  accent?: string;
  /** false for a non-jewelry preview: product suggestions only, no gift brief. */
  giftable?: boolean;
}

/** Store images on a preview are the merchant's own URLs: plain <img>, no Referer, never proxied. */
function ProductImage({ src, size = 56 }: { src: string; size?: number }) {
  if (src.startsWith("/")) return <Image src={src} alt="" width={size} height={size} className="h-14 w-14 shrink-0 object-contain" />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="" width={size} height={size} loading="lazy" referrerPolicy="no-referrer" className="h-14 w-14 shrink-0 rounded object-cover" />;
}

function errorKey(err: ConciergeTurnError): MessageKey {
  return err.kind === "rate_limited" ? "chat.errorRate" : err.kind === "too_long" ? "chat.errorTooLong" : "chat.errorGeneric";
}

export function WidgetChat({ locale, tr, context, productTitle, onBrief, onUserMessage, langHint, onActivity, fetchImpl, voice, store, greeting, accent, giftable = true }: WidgetChatProps) {
  const ids = { input: useId(), hint: useId() };
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState("");
  const { turns, busy, send, stop } = useConciergeChat({ fetchImpl, context, store, lang: langHint ?? locale, onSettled: () => inputRef.current?.focus() });
  const activity = useRef(onActivity);
  useEffect(() => {
    activity.current = onActivity;
  }, [onActivity]);
  const voiceRef = useRef(voice);
  useEffect(() => {
    voiceRef.current = voice;
  }, [voice]);
  // Mic support is known only in the browser (after hydration).
  const [canRecord, setCanRecord] = useState(false);
  useEffect(() => setCanRecord(micSupported()), []);
  /** Indexes of user turns that came from the mic. */
  const [voiceTurns, setVoiceTurns] = useState<ReadonlySet<number>>(new Set());

  useEffect(() => {
    const el = logRef.current;
    if (el && typeof el.scrollTo === "function") el.scrollTo({ top: el.scrollHeight });
  }, [turns]);

  // Spoken replies: hand each finished reply to the voice layer once.
  const spokenFor = useRef(0);
  useEffect(() => {
    const t = turns[turns.length - 1];
    if (busy || !t || t.role !== "assistant" || t.pending || t.stopped || t.error || spokenFor.current === t.id) return;
    spokenFor.current = t.id;
    if (t.text.trim()) voiceRef.current?.onReply(t.text);
  }, [busy, turns]);

  // Character: thinking until the first words arrive, then talking with a text-driven mouth.
  const last = turns[turns.length - 1];
  const lastLen = last?.role === "assistant" ? last.text.length : 0;
  useEffect(() => {
    if (!busy) {
      activity.current?.("idle", 0);
      return;
    }
    if (lastLen === 0) {
      activity.current?.("thinking", 0);
      return;
    }
    activity.current?.("talking", 0.35 + ((lastLen * 7) % 10) / 15);
    const t = setTimeout(() => activity.current?.("talking", 0.1), 140);
    return () => clearTimeout(t);
  }, [busy, lastLen]);

  const submit = (raw: string, viaVoice = false, spokenLang?: string) => {
    const text = raw.trim();
    if (!text || busy) return;
    onUserMessage?.(text, spokenLang);
    voiceRef.current?.onSend();
    if (viaVoice) setVoiceTurns((s) => new Set(s).add(turns.length));
    setDraft("");
    void send(text);
  };

  const renderTurn = (t: ConciergeTurn, i: number) => {
    if (t.role === "user")
      return (
        <div key={t.id} className="ml-8 self-end rounded-2xl rounded-br-sm bg-ink px-3 py-2 text-sm whitespace-pre-wrap text-ivory" data-testid={voiceTurns.has(i) ? "widget-voice-turn" : undefined}>
          {voiceTurns.has(i) && <span className="mb-0.5 block text-[10px] tracking-wide text-ivory/70 uppercase">{tr("voice.heard")}</span>}
          <span className="sr-only">{tr("chat.you")}: </span>
          {t.text}
        </div>
      );
    const final = t.final;
    return (
      <article key={t.id} aria-label={tr("chat.assistant")} className="mr-4 flex flex-col gap-2 self-start rounded-2xl rounded-bl-sm border border-line bg-white px-3 py-2 text-sm text-ink">
        <p className="whitespace-pre-wrap">
          <span className="sr-only">{tr("chat.assistant")}: </span>
          {t.text || (t.pending ? <span className="text-muted">{tr("chat.thinking")}</span> : t.stopped ? tr("chat.stopped") : null)}
        </p>
        {t.tools.length > 0 && (
          <details className="text-xs text-muted">
            <summary className="cursor-pointer rounded py-1 hover:text-ink">{tr("chat.howSearched", { count: t.tools.length })}</summary>
            <ol className="mt-1 list-decimal space-y-0.5 pl-5">
              {t.tools.map((x, i) => (
                <li key={i}>{x.summary}</li>
              ))}
            </ol>
          </details>
        )}
        {final?.degraded && <p className="rounded-lg bg-blush px-3 py-2 text-xs text-rose">{tr("chat.quickMode")}</p>}
        {final && final.suggestions.length > 0 && (
          <ul aria-label={tr("chat.suggested")} className="flex flex-col gap-2">
            {final.suggestions.map((s) => (
              <li key={s.catalogId} className="flex gap-3 rounded-xl border border-line p-2">
                {s.image && <ProductImage src={s.image} />}
                <div className="min-w-0">
                  <p className="font-display text-base leading-tight">{s.title}</p>
                  <p className="text-xs text-muted">
                    {tr(`category.${s.category}` as MessageKey)} · {tr("chat.from", { price: formatMoney(locale, s.fromPrice, s.currency) })}
                  </p>
                  <p className="mt-1 text-xs text-ink-soft">{s.reason}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
        {final?.products && final.products.length > 0 && (
          <ul aria-label={tr("chat.suggested")} className="flex flex-col gap-2" data-testid="widget-product-suggestions">
            {final.products.map((p) => (
              <li key={p.productId} className="flex gap-3 rounded-xl border border-line p-2">
                {p.image && <ProductImage src={p.image} />}
                <div className="min-w-0">
                  <p className="font-display text-base leading-tight">{p.title}</p>
                  {p.price !== null && p.currency && <p className="text-xs text-muted">{formatMoney(locale, p.price, p.currency)}</p>}
                  <p className="mt-1 text-xs text-ink-soft">{p.reason}</p>
                  <a href={p.url} target="_blank" rel="noopener noreferrer nofollow" className="mt-1 inline-block text-xs text-ink underline underline-offset-2">
                    {tr("chat.viewProduct")}
                  </a>
                </div>
              </li>
            ))}
          </ul>
        )}
        {final && !giftable && !final.brief && t.id === turns[turns.length - 1]?.id && <p className="text-[11px] text-muted">{tr("preview.suggestOnly")}</p>}
        {final?.brief && (
          <div className="rounded-xl border border-gold/60 bg-cream/60 p-3">
            <p className="mb-2 text-xs font-semibold tracking-[0.18em] text-gold-deep uppercase">{tr("chat.draftBrief")}</p>
            <p className="text-sm text-ink">
              {tr(`occasion.${final.brief.occasion}` as MessageKey)} · {tr("brief.budgetValue", { price: formatMoney(locale, final.brief.budgetMax, final.brief.currency) })}
            </p>
            <button
              type="button"
              data-testid="widget-use-brief"
              onClick={() => onBrief(final.brief!, final.suggestions.map((s) => s.title))}
              className="mt-2 min-h-11 w-full rounded-full bg-ink px-5 text-sm font-medium text-ivory hover:bg-ink-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            >
              {tr("chat.useBrief")}
            </button>
          </div>
        )}
        {t.error && (
          <p role="alert" className="text-sm text-rose">
            {tr(errorKey(t.error), { max: CONCIERGE_LIMITS.maxMessageChars })}
          </p>
        )}
      </article>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={(e) => e.key === "Escape" && busy && (e.stopPropagation(), stop())}>
      <div ref={logRef} role="log" aria-live="polite" aria-relevant="additions text" aria-busy={busy} aria-label={tr("chat.log")} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto bg-ivory p-3">
        <p className="mr-4 self-start rounded-2xl rounded-bl-sm border border-line bg-white px-3 py-2 text-sm text-ink" data-testid="widget-intro">
          {productTitle ? tr("chat.introPdp", { title: productTitle }) : (greeting ?? tr("chat.intro"))}
        </p>
        {turns.length === 0 && productTitle && giftable && (
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => submit(tr("chat.giftThisMessage", { title: productTitle }))} className="min-h-11 rounded-full border border-ink bg-white px-4 text-sm text-ink hover:bg-ink hover:text-ivory">
              {tr("chat.giftThis")}
            </button>
            <button type="button" onClick={() => submit(tr("chat.helpChooseMessage"))} className="min-h-11 rounded-full border border-line-strong bg-white px-4 text-sm text-ink-soft hover:border-ink">
              {tr("chat.helpChoose")}
            </button>
          </div>
        )}
        {turns.map(renderTurn)}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(draft);
        }}
        className="relative flex items-end gap-2 border-t border-line bg-white p-3"
      >
        <div className="min-w-0 flex-1">
          <label htmlFor={ids.input} className="sr-only">
            {tr("chat.inputLabel")}
          </label>
          <textarea
            id={ids.input}
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={() => !busy && activity.current?.("listening", 0)}
            onBlur={() => !busy && activity.current?.("idle", 0)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit(draft);
              }
            }}
            rows={2}
            maxLength={CONCIERGE_LIMITS.maxMessageChars}
            aria-describedby={ids.hint}
            placeholder={tr("chat.placeholder")}
            lang={locale}
            className="w-full resize-none rounded-xl border border-line-strong bg-white px-3 py-2 text-base text-ink placeholder:text-muted focus-visible:outline-2 focus-visible:outline-ink"
          />
          <p id={ids.hint} className="text-[11px] leading-4 text-muted">
            {tr("chat.hint")}
          </p>
        </div>
        {voice && canRecord && (
          <MicButton
            tr={tr}
            lang={voice.lang}
            sessionId={voice.sessionId}
            disabled={busy}
            fetchImpl={fetchImpl}
            onStart={voice.onMicStart}
            onPhase={voice.onMicPhase}
            onTranscript={(text, spokenLang) => submit(text, true, spokenLang)}
          />
        )}
        {busy ? (
          <button type="button" onClick={stop} className="mb-5 min-h-11 rounded-full border border-ink px-4 text-sm font-medium text-ink">
            {tr("chat.stop")}
          </button>
        ) : (
          <button type="submit" disabled={!draft.trim()} style={accent ? { backgroundColor: accent } : undefined} className="mb-5 min-h-11 rounded-full bg-ink px-5 text-sm font-medium text-ivory hover:bg-ink-soft disabled:opacity-50">
            {tr("chat.send")}
          </button>
        )}
      </form>
    </div>
  );
}

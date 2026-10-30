"use client";
/**
 * Gift Concierge chat panel (owner: A7, ADR-040). Text chat with streamed replies, a collapsed tool
 * transcript, grounded suggestion cards and a "Use this brief" button that hands the DRAFT brief to
 * `onBrief` (the Giver Panel pre-fills from it; nothing is created here). Keyboard: Enter sends,
 * Shift+Enter adds a line, Esc stops a reply. The conversation is an aria-live log.
 * Conversation state lives in useConciergeChat (shared with the embeddable widget, A6).
 */
import Image from "next/image";
import { useEffect, useId, useRef, useState } from "react";
import type { GiftBrief } from "@/lib/contracts/api";
import { CONCIERGE_LIMITS, type ConciergeToolName } from "@/lib/concierge/types";
import { METAL_LABELS, OCCASION_LABELS, formatPrice, humanize } from "@/components/store/format";
import { useConciergeChat, type ConciergeTurnError } from "./useConciergeChat";

export const CONCIERGE_EXAMPLES = [
  "Anniversary gift for my wife. She loves minimal, delicate pieces and mostly wears gold. Budget around $300.",
  "Mình muốn tặng mẹ quà sinh nhật, khoảng 2 triệu. Mẹ thích kiểu cổ điển, sang trọng.",
];

export interface ConciergePanelProps {
  /** Called when the giver taps "Use this brief". */
  onBrief: (brief: GiftBrief) => void;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  examples?: readonly string[];
  title?: string;
  className?: string;
}

const TOOL_LABEL: Record<ConciergeToolName, string> = {
  search_catalog: "Catalog search",
  fit_preview: "Design check",
  check_budget_and_metals: "Budget check",
  create_fit_request: "Draft brief",
};

function errorText(err: ConciergeTurnError): string {
  if (err.kind === "rate_limited") return `You've sent a lot of messages. Please try again${err.retryAfterSec ? ` in about ${Math.ceil(err.retryAfterSec / 60)} min` : " later"}.`;
  if (err.kind === "too_long") return `That message is too long (max ${CONCIERGE_LIMITS.maxMessageChars} characters).`;
  return "The concierge couldn't answer just now. Please try again.";
}

function BriefSummary({ brief }: { brief: GiftBrief }) {
  const rows: Array<[string, string]> = [
    ["Mode", brief.mode === "help_me_choose" ? "Help me choose (GiftFit picks 6–8 pieces)" : "I have ideas"],
    ["Occasion", OCCASION_LABELS[brief.occasion]],
    ["Budget", `Up to ${formatPrice(brief.budgetMax, brief.currency)}`],
  ];
  if (brief.categories?.length) rows.push(["Categories", brief.categories.map(humanize).join(", ")]);
  if (brief.styleHints?.length) rows.push(["Style", brief.styleHints.map(humanize).join(", ")]);
  if (brief.metalLock?.length) rows.push(["Metals", brief.metalLock.map((m) => METAL_LABELS[m]).join(", ")]);
  if (brief.genderPresentation) rows.push(["Pieces", humanize(brief.genderPresentation)]);
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ConciergePanel({ onBrief, endpoint, fetchImpl, examples = CONCIERGE_EXAMPLES, title = "Ask the gift concierge", className = "" }: ConciergePanelProps) {
  const ids = { heading: useId(), input: useId(), hint: useId() };
  const [draft, setDraft] = useState("");
  const [usedBriefTurn, setUsedBriefTurn] = useState<number | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const chat = useConciergeChat({ endpoint, fetchImpl, onSettled: () => inputRef.current?.focus() });
  const { turns, busy, stop } = chat;

  useEffect(() => {
    const el = logRef.current;
    if (el && typeof el.scrollTo === "function") el.scrollTo({ top: el.scrollHeight });
  }, [turns]);

  const send = async (raw: string) => {
    if (!raw.trim() || busy) return;
    setDraft("");
    await chat.send(raw);
  };

  return (
    <section aria-labelledby={ids.heading} className={`flex flex-col gap-4 rounded-2xl border border-line bg-white p-4 sm:p-6 ${className}`} onKeyDown={(e) => e.key === "Escape" && busy && stop()}>
      <header>
        <h2 id={ids.heading} className="font-display text-2xl text-ink">
          {title}
        </h2>
        <p className="mt-1 text-sm text-ink-soft">Tell me who it&apos;s for, the occasion and a budget, in any language. I&apos;ll suggest pieces from this store and draft a gift brief for you to confirm.</p>
      </header>

      <div ref={logRef} role="log" aria-live="polite" aria-relevant="additions text" aria-busy={busy} aria-label="Conversation" tabIndex={turns.length ? 0 : -1} className="flex max-h-[60vh] min-h-24 flex-col gap-3 overflow-y-auto rounded-xl bg-ivory p-3 focus-visible:outline-2 focus-visible:outline-ink">
        {turns.length === 0 && <p className="text-sm text-muted">No messages yet.</p>}
        {turns.map((t) =>
          t.role === "user" ? (
            <div key={t.id} className="ml-8 self-end rounded-2xl rounded-br-sm bg-ink px-4 py-2 text-sm whitespace-pre-wrap text-ivory">
              <span className="sr-only">You: </span>
              {t.text}
            </div>
          ) : (
            <article key={t.id} aria-label="Concierge reply" className="mr-4 flex flex-col gap-3 self-start rounded-2xl rounded-bl-sm border border-line bg-white px-4 py-3 text-sm text-ink">
              <p className="whitespace-pre-wrap">
                <span className="sr-only">Concierge: </span>
                {t.text || (t.pending ? <span className="text-muted">Thinking…</span> : t.stopped ? "(stopped)" : null)}
              </p>
              {t.tools.length > 0 && (
                <details className="text-xs text-muted">
                  <summary className="cursor-pointer rounded py-1 hover:text-ink focus-visible:outline-2 focus-visible:outline-ink">
                    How I searched ({t.tools.length} step{t.tools.length === 1 ? "" : "s"})
                  </summary>
                  <ol className="mt-1 list-decimal space-y-0.5 pl-5">
                    {t.tools.map((x, i) => (
                      <li key={i}>
                        <span className="font-medium text-ink-soft">{TOOL_LABEL[x.name]}:</span> {x.summary}
                      </li>
                    ))}
                  </ol>
                </details>
              )}
              {t.final && t.final.degraded && (
                <p className="rounded-lg bg-blush px-3 py-2 text-xs text-rose">Quick mode: the AI assistant is unavailable right now, so these picks come from simple catalog filters.</p>
              )}
              {t.final?.notes?.length ? (
                <ul className="text-xs text-muted">
                  {t.final.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              ) : null}
              {t.final && t.final.suggestions.length > 0 && (
                <ul aria-label="Suggested pieces" className="grid gap-2 sm:grid-cols-3">
                  {t.final.suggestions.map((s) => (
                    <li key={s.catalogId} className="flex gap-3 rounded-xl border border-line p-2 sm:flex-col">
                      {s.image && <Image src={s.image} alt="" width={72} height={72} className="h-16 w-16 shrink-0 object-contain sm:h-20 sm:w-full" />}
                      <div className="min-w-0">
                        <p className="font-display text-base leading-tight">{s.title}</p>
                        <p className="text-xs text-muted">
                          {humanize(s.style)} {humanize(s.category).toLowerCase()} · from {formatPrice(s.fromPrice, s.currency)}
                        </p>
                        <p className="text-xs text-muted">{s.eligibleMetals.map((m) => METAL_LABELS[m.metal]).join(", ")}</p>
                        <p className="mt-1 text-xs text-ink-soft">{s.reason}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {t.final?.brief && (
                <div className="rounded-xl border border-gold/60 bg-cream/60 p-3">
                  <p className="mb-2 text-xs font-semibold tracking-[0.18em] text-gold-deep uppercase">Draft gift brief</p>
                  <BriefSummary brief={t.final.brief} />
                  <button
                    type="button"
                    onClick={() => {
                      onBrief(t.final!.brief!);
                      setUsedBriefTurn(t.id);
                    }}
                    className="mt-3 min-h-11 w-full gf-cta rounded-full bg-ink px-5 text-sm font-medium text-ivory hover:bg-ink-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink sm:w-auto"
                  >
                    Use this brief
                  </button>
                  {usedBriefTurn === t.id && (
                    <p role="status" className="mt-2 text-xs text-sage">
                      Brief added. Review it before sending; nothing has been sent yet.
                    </p>
                  )}
                </div>
              )}
              {t.error && (
                <p role="alert" className="text-sm text-rose">
                  {errorText(t.error)}
                </p>
              )}
            </article>
          ),
        )}
      </div>

      {turns.length === 0 && examples.length > 0 && (
        <div>
          <p className="mb-2 text-xs text-muted">Try an example:</p>
          <ul className="flex flex-col gap-2">
            {examples.map((ex) => (
              <li key={ex}>
                <button type="button" onClick={() => void send(ex)} disabled={busy} className="min-h-11 w-full rounded-xl border border-line-strong bg-white px-3 py-2 text-left text-sm text-ink-soft hover:border-ink focus-visible:outline-2 focus-visible:outline-ink disabled:opacity-60">
                  {ex}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send(draft);
        }}
        className="flex flex-col gap-2 sm:flex-row sm:items-end"
      >
        <div className="flex-1">
          <label htmlFor={ids.input} className="mb-1 block text-sm font-medium text-ink">
            Your message
          </label>
          <textarea
            id={ids.input}
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send(draft);
              }
            }}
            rows={2}
            maxLength={CONCIERGE_LIMITS.maxMessageChars}
            aria-describedby={ids.hint}
            placeholder="e.g. Birthday gift for my sister, earrings under $150"
            className="w-full resize-y rounded-xl border border-line-strong bg-white px-3 py-2 text-base text-ink placeholder:text-muted focus-visible:outline-2 focus-visible:outline-ink"
          />
          <p id={ids.hint} className="text-xs text-muted">
            Enter to send, Shift+Enter for a new line. Never share photos or personal details here.
          </p>
        </div>
        {busy ? (
          <button type="button" onClick={stop} className="min-h-11 rounded-full border border-ink px-5 text-sm font-medium text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">
            Stop
          </button>
        ) : (
          <button type="submit" disabled={!draft.trim()} className="min-h-11 gf-cta rounded-full bg-ink px-6 text-sm font-medium text-ivory hover:bg-ink-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:opacity-50">
            Send
          </button>
        )}
      </form>
    </section>
  );
}

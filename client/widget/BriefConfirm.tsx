"use client";
/**
 * Confirm the Concierge's DRAFT brief and create the Fit Request (owner: A6). Default "Help me choose";
 * "I have ideas" when the shopper wants to gift the product they are looking at (or the Concierge
 * drafted specific pieces). Nothing is created before the giver presses the button.
 */
import { useId, useState } from "react";
import type { CreateFitRequestBody, GiftBrief } from "@/server/contracts/api";
import { formatMoney, type Locale, type MessageKey } from "@/server/i18n";

export interface MatchedProduct {
  id: string;
  title: string;
  price: number;
  currency: string;
  image?: string;
  /** Store-URL previews: false when the product is not jewelry with a metal (no Fit Request for it). */
  giftable?: boolean;
}

export interface BriefConfirmProps {
  locale: Locale;
  tr: (key: MessageKey, vars?: Record<string, string | number>) => string;
  brief: GiftBrief;
  match: MatchedProduct | null;
  /** Set for a store-URL preview (ADR-055): the request is created for that preview. */
  previewKey?: string;
  /**
   * A16: whether the recipient will be offered a try-on (decided on the server for this browser: the public site
   * is hearts-only, the owner's recording session and mock mode try on). Absent = previews hearts-only (legacy).
   */
  tryOn?: boolean;
  suggestionTitles: string[];
  busy: boolean;
  error?: string;
  onCreate(body: CreateFitRequestBody): void;
  onBack(): void;
}

type Choice = "help" | "ideas";

/** The create body for a confirmed brief (pure; exported for tests). */
export function fitRequestBody(brief: GiftBrief, choice: Choice, match: MatchedProduct | null, previewKey?: string): CreateFitRequestBody {
  const common = {
    ...(previewKey ? { storeId: `preview:${previewKey}` } : {}),
    occasion: brief.occasion,
    currency: brief.currency,
    ...(brief.metalLock?.length ? { metalLock: [...brief.metalLock] } : {}),
  };
  if (choice === "help") {
    return {
      ...common,
      mode: "help_me_choose",
      budgetMax: brief.budgetMax,
      shortlistIds: [],
      ...(brief.categories?.length ? { categories: [...brief.categories] } : {}),
      ...(brief.styleHints?.length ? { styleHints: [...brief.styleHints] } : {}),
      ...(brief.genderPresentation ? { genderPresentation: brief.genderPresentation } : {}),
    };
  }
  const ids = [...new Set([...(match ? [match.id] : []), ...(brief.shortlistIds ?? [])])].slice(0, 4);
  // Gifting the piece on the page: the cap must at least cover it.
  const budgetMax = match && match.currency === brief.currency ? Math.max(brief.budgetMax, match.price) : brief.budgetMax;
  return { ...common, mode: "i_have_ideas", budgetMax, shortlistIds: ids };
}

export function BriefConfirm({ locale, tr, brief, match, previewKey, tryOn, suggestionTitles, busy, error, onCreate, onBack }: BriefConfirmProps) {
  const noTryOn = tryOn === undefined ? Boolean(previewKey) : !tryOn;
  const legend = useId();
  const ideasPossible = Boolean(match) || Boolean(brief.shortlistIds?.length);
  const [choice, setChoice] = useState<Choice>(brief.mode === "i_have_ideas" && ideasPossible ? "ideas" : "help");
  const ideasTitle = match?.title ?? suggestionTitles.slice(0, 2).join(", ");

  const rows: Array<[string, string]> = [
    [tr("brief.occasion"), tr(`occasion.${brief.occasion}` as MessageKey)],
    [tr("brief.budget"), tr("brief.budgetValue", { price: formatMoney(locale, brief.budgetMax, brief.currency) })],
  ];
  if (brief.categories?.length) rows.push([tr("brief.categories"), brief.categories.map((c) => tr(`category.${c}` as MessageKey)).join(", ")]);
  if (brief.metalLock?.length) rows.push([tr("brief.metals"), brief.metalLock.map((m) => tr(`metal.${m}` as MessageKey)).join(", ")]);
  if (brief.styleHints?.length) rows.push([tr("brief.style"), brief.styleHints.join(", ")]);

  const option = (value: Choice, label: string) => (
    <label className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border p-3 text-sm ${choice === value ? "border-ink bg-white" : "border-line bg-white/60"}`}>
      <input type="radio" name="gf-mode" value={value} checked={choice === value} onChange={() => setChoice(value)} className="mt-0.5 accent-ink" data-testid={`widget-mode-${value}`} />
      <span>{label}</span>
    </label>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto bg-ivory p-4" data-testid="widget-brief">
      <h2 className="font-display text-2xl text-ink">{tr("brief.title")}</h2>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted">{k}</dt>
            <dd className="text-ink">{v}</dd>
          </div>
        ))}
      </dl>
      <fieldset aria-labelledby={legend} className="flex flex-col gap-2">
        <legend id={legend} className="mb-1 text-sm font-medium text-ink">
          {tr(noTryOn ? "brief.modeLegendNoTryOn" : "brief.modeLegend")}
        </legend>
        {option("help", tr("brief.modeHelp"))}
        {ideasPossible && option("ideas", tr(noTryOn ? "brief.modeIdeasNoTryOn" : "brief.modeIdeas", { title: ideasTitle }))}
      </fieldset>
      <p className="text-xs leading-5 text-ink-soft">{tr(noTryOn ? "brief.privacyNoTryOn" : "brief.privacy")}</p>
      {previewKey && noTryOn && (
        <p className="rounded-xl border border-gold/60 bg-cream px-3 py-2 text-xs leading-5 text-ink" data-testid="widget-no-tryon">
          {tr("preview.noTryOn")}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-rose">
          {error}
        </p>
      )}
      <div className="mt-auto flex flex-col gap-2">
        <button
          type="button"
          disabled={busy}
          data-testid="widget-create"
          onClick={() => onCreate(fitRequestBody(brief, choice, match, previewKey))}
          className="min-h-11 rounded-full bg-ink px-6 text-sm font-medium text-ivory hover:bg-ink-soft disabled:opacity-60"
        >
          {busy ? tr("brief.creating") : tr("brief.create")}
        </button>
        <button type="button" onClick={onBack} disabled={busy} className="min-h-11 rounded-full border border-line-strong px-6 text-sm text-ink-soft">
          {tr("brief.back")}
        </button>
      </div>
    </div>
  );
}

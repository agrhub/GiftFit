"use client";
/**
 * Giver Panel (owner: A4; modes by A3, ADR-045). Two modes: "Help me choose" (default): occasion,
 * budget cap, categories, optional metal lock, style hints and presentation, and GiftFit curates
 * 6–8 real pieces; "I have ideas": occasion, budget, a shortlist of 1–4 pieces mixed with look-alikes.
 * Then "Send a Fit Request". A parent can pre-fill the form with a `brief` (the Gift Concierge's GiftBrief).
 * A native modal <dialog>: focus moves in, Esc closes, focus returns to the trigger, the page
 * behind is inert. Bottom sheet on phones, side panel from md up.
 */
import Image from "next/image";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  CreateFitRequestResponse,
  GiftBrief,
  GiftMode,
} from "@/lib/contracts/api";
import { OCCASIONS, type Occasion } from "@/lib/contracts/giftfit";
import storeInfo from "@/data/aurum/store.json";
import {
  METAL_LABELS,
  OCCASION_LABELS,
  formatPrice,
} from "@/components/store/format";
import { ApiError, type GiftApi, friendlyError, loadGiftApi } from "./api";
import {
  BUDGET_PRESETS,
  type BudgetPresetId,
  CATEGORY_OPTIONS,
  type GiftPiece,
  type GiverDraft,
  MAX_SHORTLIST,
  METAL_LOCKS,
  MODE_OPTIONS,
  PRESENTATION_OPTIONS,
  STYLE_HINT_OPTIONS,
  draftFromBrief,
  eligibleVariants,
  modeOf,
  suggestPieces,
  toRequestBody,
  toggle,
  validateDraft,
  variantsOf,
} from "./giverDraft";
import { ConciergePanel } from "./concierge/ConciergePanel";
import { FitRequestSent } from "./FitRequestSent";
import { saveRequest } from "./savedRequests";
import { GiftIcon, CloseIcon } from "./icons";

export interface GiverPanelProps {
  open: boolean;
  onClose: () => void;
  /** Pieces to start the shortlist with (the PDP product, or the bag). */
  initialPieces: GiftPiece[];
  /** Catalog for suggestions; loaded lazily when omitted. */
  catalog?: readonly GiftPiece[];
  api?: GiftApi;
  /** Starting mode (ADR-045). Default "help_me_choose". */
  initialMode?: GiftMode;
  /**
   * Pre-fill from a structured gift brief (the Gift Concierge hands one over, ADR-040/045). Applied
   * whenever a new brief object is passed; the giver still reviews and sends.
   */
  brief?: GiftBrief | null;
}

type Phase =
  | { kind: "form" }
  | { kind: "sending" }
  | {
      kind: "sent";
      result: CreateFitRequestResponse;
      titles: string[];
      curated: boolean;
    };

const emptyDraft = (
  mode: GiftMode,
  initialPieces: GiftPiece[],
): GiverDraft => ({
  mode,
  occasion: null,
  budgetPreset: null,
  metalLock: "any",
  customMax: "",
  shortlist: initialPieces.slice(0, MAX_SHORTLIST),
  categories: [],
  styleHints: [],
  presentation: "any",
});

const segment = (checked: boolean) =>
  `flex min-h-11 cursor-pointer items-center justify-center rounded-full px-3 text-sm font-medium transition-colors focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ink ${
    checked ? "bg-ink text-ivory" : "text-ink-soft hover:text-ink"
  }`;

const chip = (checked: boolean) =>
  `flex min-h-11 cursor-pointer items-center justify-center rounded-full border px-4 text-sm transition-colors focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ink ${
    checked
      ? "border-ink bg-ink text-ivory"
      : "border-line-strong bg-white text-ink hover:border-ink"
  }`;

/** "3 metals · from $245" for a design, counting only metals inside the cap and lock. */
function pieceSummary(
  p: GiftPiece,
  cap: number | null,
  lock: GiverDraft["metalLock"],
): string {
  const vs = eligibleVariants(p, cap, lock);
  const list = vs.length ? vs : variantsOf(p);
  const from = formatPrice(Math.min(...list.map((v) => v.price)), p.currency);
  return list.length === 1
    ? `${METAL_LABELS[list[0].metal]} · ${from}`
    : `${list.length} metals · from ${from}`;
}

export function GiverPanel({
  open,
  onClose,
  initialPieces,
  catalog: catalogProp,
  api: apiProp,
  initialMode = "help_me_choose",
  brief,
}: GiverPanelProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const occasionRef = useRef<HTMLFieldSetElement>(null);
  const budgetRef = useRef<HTMLFieldSetElement>(null);
  const shortlistRef = useRef<HTMLDivElement>(null);
  const ids = {
    title: useId(),
    occasion: useId(),
    budget: useId(),
    shortlist: useId(),
    search: useId(),
    max: useId(),
    mode: useId(),
  };

  const [draft, setDraft] = useState<GiverDraft>(() =>
    emptyDraft(initialMode, initialPieces),
  );
  const [showErrors, setShowErrors] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "form" });
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<readonly GiftPiece[]>(
    catalogProp ?? [],
  );
  const [query, setQuery] = useState("");
  const [suggestLimit, setSuggestLimit] = useState(6);
  const [announce, setAnnounce] = useState("");

  // Open/close the native dialog.
  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (open && !d.open) {
      if (typeof d.showModal === "function") d.showModal();
      else d.setAttribute("open", "");
      headingRef.current?.focus();
    } else if (!open && d.open) {
      if (typeof d.close === "function") d.close();
      else d.removeAttribute("open");
    }
  }, [open]);

  useEffect(() => {
    if (catalogProp || !open || catalog.length) return;
    let alive = true;
    import("@/components/store/catalog").then((m) => {
      if (alive) setCatalog(m.PRODUCTS);
    });
    return () => {
      alive = false;
    };
  }, [catalogProp, open, catalog.length]);

  // A new brief (from a parent, or from the Gift Concierge opened inside this panel) pre-fills the
  // form; the giver reviews and sends.
  const [conciergeOpen, setConciergeOpen] = useState(false);
  const [conciergeBrief, setConciergeBrief] = useState<GiftBrief | null>(null);
  const appliedBrief = conciergeBrief ?? brief;
  useEffect(() => {
    if (!appliedBrief) return;
    setDraft((d) => draftFromBrief(appliedBrief, d, catalog));
    setPhase({ kind: "form" });
    setShowErrors(false);
    setSubmitError(null);
    // Only a new brief object re-applies; catalog loading later must not overwrite the giver's edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedBrief]);

  const mode = modeOf(draft);
  const helpMode = mode === "help_me_choose";
  const check = useMemo(() => validateDraft(draft), [draft]);
  const suggestions = useMemo(
    () => suggestPieces(catalog, draft, query, suggestLimit),
    [catalog, draft, query, suggestLimit],
  );
  const full = draft.shortlist.length >= MAX_SHORTLIST;

  const update = (patch: Partial<GiverDraft>) =>
    setDraft((d) => ({ ...d, ...patch }));
  const addPiece = (p: GiftPiece) => {
    if (full) return;
    update({ shortlist: [...draft.shortlist, p] });
    setAnnounce(
      `${p.title} added. ${draft.shortlist.length + 1} of ${MAX_SHORTLIST} pieces.`,
    );
  };
  const removePiece = (p: GiftPiece) => {
    update({ shortlist: draft.shortlist.filter((x) => x.id !== p.id) });
    setAnnounce(
      `${p.title} removed. ${draft.shortlist.length - 1} of ${MAX_SHORTLIST} pieces.`,
    );
  };

  const close = useCallback(() => {
    // After a successful send, the next open starts a fresh request.
    if (phase.kind === "sent") {
      setPhase({ kind: "form" });
      setShowErrors(false);
      setDraft(emptyDraft(initialMode, initialPieces));
    }
    onClose();
  }, [onClose, phase.kind, initialPieces, initialMode]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    if (!check.ok) {
      setShowErrors(true);
      const first = check.errors.occasion
        ? occasionRef.current
        : check.errors.budget
          ? budgetRef.current
          : helpMode
            ? null
            : shortlistRef.current;
      first?.querySelector<HTMLElement>("input, button")?.focus();
      return;
    }
    setPhase({ kind: "sending" });
    try {
      const api = apiProp ?? (await loadGiftApi());
      const result = await api.createFitRequest(
        toRequestBody(draft, storeInfo.id),
      );
      const titles = helpMode
        ? [`${result.carouselSize} pieces picked by GiftFit`]
        : draft.shortlist.map((p) => p.title);
      saveRequest({
        giverReportPath: result.giverReportPath,
        recipientPath: result.recipientPath,
        expiresAt: result.expiresAt,
        createdAt: new Date().toISOString(),
        occasion: draft.occasion!,
        titles,
      });
      setPhase({ kind: "sent", result, titles, curated: helpMode });
    } catch (err) {
      setPhase({ kind: "form" });
      setSubmitError(
        err instanceof ApiError && err.status === 422
          ? helpMode
            ? "Not enough pieces fit this budget and choice. Raise the cap, pick more kinds of piece or allow any metal."
            : /variant|eligib|metal|budget|cap/i.test(
                  `${err.code} ${err.message}`,
                )
              ? "One of your designs has no metal within your budget and metal choice. Raise the cap, change the metal or remove that design."
              : "We couldn't find enough similar pieces to keep your picks a surprise. Try a higher cap or a design from another category."
          : friendlyError(err),
      );
    }
  }

  const err = showErrors ? check.errors : {};

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={ids.title}
      onClose={close}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === dialogRef.current) close();
      }}
      className="gf-sheet fixed inset-x-0 bottom-0 top-auto h-auto w-full md:inset-y-0 md:left-auto md:right-0 md:h-dvh md:max-h-dvh md:w-[30rem]"
    >
      <div className="gf-sheet-panel flex max-h-[92dvh] flex-col overflow-hidden rounded-t-2xl bg-ivory text-ink shadow-2xl md:h-dvh md:max-h-dvh md:rounded-none">
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 pb-4 pt-5">
          <div>
            <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.22em] text-gold-deep">
              <GiftIcon className="h-4 w-4" /> Gift it right
            </p>
            <h2
              id={ids.title}
              ref={headingRef}
              tabIndex={-1}
              className="mt-2 font-display text-3xl leading-tight focus:outline-none"
            >
              {phase.kind === "sent"
                ? "Your Fit Request is ready"
                : "Let them try it on, privately"}
            </h2>
          </div>
          <button
            type="button"
            onClick={close}
            className="-mr-2 grid h-11 w-11 shrink-0 place-items-center rounded-full text-ink-soft hover:bg-cream hover:text-ink"
            aria-label="Close Gift it right"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </header>

        {conciergeOpen && phase.kind !== "sent" ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6" data-testid="giver-concierge">
            <button
              type="button"
              onClick={() => setConciergeOpen(false)}
              className="mb-4 min-h-11 text-sm text-ink underline decoration-gold underline-offset-4"
            >
              Back to the form
            </button>
            <ConciergePanel
              onBrief={(b) => {
                setConciergeBrief(b);
                setConciergeOpen(false);
              }}
            />
          </div>
        ) : phase.kind === "sent" ? (
          <FitRequestSent
            result={phase.result}
            titles={phase.titles}
            onDone={close}
            curated={phase.curated}
          />
        ) : (
          <form
            noValidate
            onSubmit={submit}
            className="flex min-h-0 flex-1 flex-col"
            aria-describedby={submitError ? `${ids.title}-err` : undefined}
          >
            <div className="min-h-0 flex-1 space-y-8 overflow-y-auto px-5 py-6">
              <fieldset aria-describedby={`${ids.mode}-hint`}>
                <legend className="sr-only">How do you want to choose?</legend>
                <div
                  className="grid grid-cols-2 gap-1 rounded-full border border-line-strong bg-white p-1"
                  data-testid="mode-switch"
                >
                  {MODE_OPTIONS.map((m) => (
                    <label key={m.id} className={segment(mode === m.id)}>
                      <input
                        type="radio"
                        name="gift-mode"
                        value={m.id}
                        checked={mode === m.id}
                        onChange={() => {
                          update({ mode: m.id });
                          setSubmitError(null);
                        }}
                        className="sr-only"
                        data-testid={`mode-${m.id}`}
                      />
                      {m.label}
                    </label>
                  ))}
                </div>
                <p
                  id={`${ids.mode}-hint`}
                  className="mt-3 text-sm leading-6 text-ink-soft"
                >
                  {helpMode
                    ? "Set a budget and the occasion. GiftFit picks 6 different pieces; they try them on with an AI preview and heart their favourites. You'll see their taste and what fits. You'll never see their photos."
                    : "They'll try on 6 pieces with an AI preview and heart their favourites. You'll get fit scores. You'll never see their photos."}
                </p>
                {helpMode ? (
                  <p className="mt-2 text-xs text-muted">
                    Not sure what to set?{" "}
                    <button
                      type="button"
                      onClick={() => setConciergeOpen(true)}
                      className="min-h-11 text-ink underline decoration-gold underline-offset-4"
                      data-testid="open-concierge"
                    >
                      Ask the gift concierge
                    </button>
                  </p>
                ) : null}
                {helpMode && initialPieces.length > 0 ? (
                  <p className="mt-2 text-xs text-muted">
                    Already have {initialPieces[0].title} in mind?{" "}
                    <button
                      type="button"
                      onClick={() => update({ mode: "i_have_ideas" })}
                      className="min-h-11 text-ink underline decoration-gold underline-offset-4"
                      data-testid="use-my-picks"
                    >
                      Use my picks instead
                    </button>
                  </p>
                ) : null}
              </fieldset>

              <fieldset
                ref={occasionRef}
                aria-describedby={
                  err.occasion ? `${ids.occasion}-err` : undefined
                }
                aria-invalid={err.occasion ? true : undefined}
              >
                <legend className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">
                  Occasion
                </legend>
                <div className="mt-3 flex flex-wrap gap-2">
                  {OCCASIONS.map((o: Occasion) => (
                    <label key={o} className={chip(draft.occasion === o)}>
                      <input
                        type="radio"
                        name="occasion"
                        value={o}
                        checked={draft.occasion === o}
                        onChange={() => update({ occasion: o })}
                        className="sr-only"
                        data-testid={`occasion-${o}`}
                      />
                      {OCCASION_LABELS[o]}
                    </label>
                  ))}
                </div>
                {err.occasion ? (
                  <p
                    id={`${ids.occasion}-err`}
                    className="mt-2 text-sm text-rose"
                  >
                    {err.occasion}
                  </p>
                ) : null}
              </fieldset>

              <fieldset
                ref={budgetRef}
                aria-describedby={err.budget ? `${ids.budget}-err` : undefined}
                aria-invalid={err.budget ? true : undefined}
              >
                <legend className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">
                  Budget cap
                </legend>
                <p className="mt-1 text-xs text-muted">
                  They only see metals priced within it, so anything they love
                  is affordable.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {[
                    ...BUDGET_PRESETS,
                    { id: "custom" as const, label: "Custom" },
                  ].map((b) => (
                    <label
                      key={b.id}
                      className={chip(draft.budgetPreset === b.id)}
                    >
                      <input
                        type="radio"
                        name="budget"
                        value={b.id}
                        checked={draft.budgetPreset === b.id}
                        onChange={() =>
                          update({ budgetPreset: b.id as BudgetPresetId })
                        }
                        className="sr-only"
                        data-testid={`budget-${b.id}`}
                      />
                      {b.label}
                    </label>
                  ))}
                </div>
                {draft.budgetPreset === "custom" ? (
                  <div className="mt-3 grid grid-cols-2 gap-3">
                    <label htmlFor={ids.max} className="text-sm text-ink-soft">
                      Maximum ($)
                      <input
                        id={ids.max}
                        inputMode="numeric"
                        type="number"
                        min={1}
                        value={draft.customMax}
                        onChange={(e) => update({ customMax: e.target.value })}
                        className="mt-1 block min-h-11 w-full rounded-lg border border-line-strong bg-white px-3 text-ink"
                      />
                    </label>
                  </div>
                ) : null}
                {err.budget ? (
                  <p
                    id={`${ids.budget}-err`}
                    className="mt-2 text-sm text-rose"
                  >
                    {err.budget}
                  </p>
                ) : null}
              </fieldset>

              <fieldset>
                <legend className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">
                  Metal (optional)
                </legend>
                <div className="mt-3 flex flex-wrap gap-2">
                  {METAL_LOCKS.map((l) => (
                    <label
                      key={l.id}
                      className={chip(draft.metalLock === l.id)}
                    >
                      <input
                        type="radio"
                        name="metal-lock"
                        value={l.id}
                        checked={draft.metalLock === l.id}
                        onChange={() => update({ metalLock: l.id })}
                        className="sr-only"
                        data-testid={`lock-${l.id}`}
                      />
                      {l.label}
                    </label>
                  ))}
                </div>
              </fieldset>

              {helpMode ? (
                <>
                  <fieldset>
                    <legend className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">
                      Kind of piece (optional)
                    </legend>
                    <p className="mt-1 text-xs text-muted">
                      None chosen means any kind. Rings, bracelets and watches
                      ask them for a hand photo too.
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {CATEGORY_OPTIONS.map((c) => {
                        const on = (draft.categories ?? []).includes(c.id);
                        return (
                          <label key={c.id} className={chip(on)}>
                            <input
                              type="checkbox"
                              checked={on}
                              onChange={() =>
                                update({
                                  categories: toggle(draft.categories, c.id),
                                })
                              }
                              className="sr-only"
                              data-testid={`category-${c.id}`}
                            />
                            {c.label}
                          </label>
                        );
                      })}
                    </div>
                  </fieldset>

                  <fieldset>
                    <legend className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">
                      Their style (optional)
                    </legend>
                    <p className="mt-1 text-xs text-muted">
                      A hint, not a filter: we lean towards it and still show a
                      few other styles.
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {STYLE_HINT_OPTIONS.map((h) => {
                        const on = (draft.styleHints ?? []).includes(h.id);
                        return (
                          <label key={h.id} className={chip(on)}>
                            <input
                              type="checkbox"
                              checked={on}
                              onChange={() =>
                                update({
                                  styleHints: toggle(draft.styleHints, h.id),
                                })
                              }
                              className="sr-only"
                              data-testid={`style-${h.id}`}
                            />
                            {h.label}
                          </label>
                        );
                      })}
                    </div>
                  </fieldset>

                  <fieldset>
                    <legend className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">
                      Pieces styled as (optional)
                    </legend>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {PRESENTATION_OPTIONS.map((g) => {
                        const on = (draft.presentation ?? "any") === g.id;
                        return (
                          <label key={g.id} className={chip(on)}>
                            <input
                              type="radio"
                              name="presentation"
                              value={g.id}
                              checked={on}
                              onChange={() => update({ presentation: g.id })}
                              className="sr-only"
                              data-testid={`presentation-${g.id}`}
                            />
                            {g.label}
                          </label>
                        );
                      })}
                    </div>
                  </fieldset>
                </>
              ) : null}

              {helpMode ? null : (
                <>
                  <div
                    ref={shortlistRef}
                    role="group"
                    aria-labelledby={ids.shortlist}
                    aria-describedby={
                      err.shortlist ? `${ids.shortlist}-err` : undefined
                    }
                  >
                    <div className="flex items-baseline justify-between">
                      <h3
                        id={ids.shortlist}
                        className="text-xs font-semibold uppercase tracking-[0.18em] text-muted"
                      >
                        Your shortlist
                      </h3>
                      <p
                        className="text-sm text-ink-soft"
                        data-testid="shortlist-count"
                      >
                        {draft.shortlist.length} of {MAX_SHORTLIST} designs
                      </p>
                    </div>
                    {draft.shortlist.length === 0 ? (
                      <p className="mt-3 rounded-lg border border-dashed border-line-strong p-4 text-sm text-muted">
                        Add between 1 and {MAX_SHORTLIST} designs you&apos;re
                        considering.
                      </p>
                    ) : null}
                    <ul className="mt-3 space-y-2" data-testid="shortlist">
                      {draft.shortlist.map((p) => {
                        const eligible = eligibleVariants(
                          p,
                          check.cap,
                          draft.metalLock,
                        );
                        const all = variantsOf(p);
                        const blocked =
                          check.cap !== null && eligible.length === 0;
                        const metalsNote =
                          check.cap === null
                            ? `${all.length === 1 ? METAL_LABELS[all[0].metal] : `${all.length} metals`} · from ${formatPrice(Math.min(...all.map((v) => v.price)), p.currency)}`
                            : blocked
                              ? null
                              : eligible.length === 1
                                ? `${METAL_LABELS[eligible[0].metal]} within your budget`
                                : `${eligible.length} metals within your budget`;
                        return (
                          <li
                            key={p.id}
                            className="flex items-center gap-3 rounded-lg border border-line bg-white p-2 pr-1"
                          >
                            <Image
                              src={p.image}
                              alt=""
                              width={56}
                              height={56}
                              className="h-14 w-14 shrink-0 object-contain"
                            />
                            <div className="min-w-0 flex-1">
                              <p className="truncate font-display text-lg leading-tight">
                                {p.title}
                              </p>
                              <p
                                className="text-xs text-muted"
                                data-testid="shortlist-metals"
                              >
                                {blocked ? (
                                  <span className="text-rose">
                                    No metal within your budget and metal choice
                                  </span>
                                ) : (
                                  metalsNote
                                )}
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={() => removePiece(p)}
                              className="grid h-11 w-11 place-items-center rounded-full text-ink-soft hover:bg-cream hover:text-ink"
                              aria-label={`Remove ${p.title} from shortlist`}
                            >
                              <CloseIcon className="h-4 w-4" />
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                    {err.shortlist ? (
                      <p
                        id={`${ids.shortlist}-err`}
                        className="mt-2 text-sm text-rose"
                      >
                        {err.shortlist}
                      </p>
                    ) : null}
                  </div>

                  <section
                    aria-labelledby={`${ids.search}-h`}
                    className="rounded-xl border border-line bg-cream/60 p-4"
                  >
                    <h3
                      id={`${ids.search}-h`}
                      className="text-xs font-semibold uppercase tracking-[0.18em] text-muted"
                    >
                      Add pieces
                    </h3>
                    <label htmlFor={ids.search} className="sr-only">
                      Search Aurum pieces
                    </label>
                    <input
                      id={ids.search}
                      type="search"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search, e.g. pendant, rose gold"
                      className="mt-3 block min-h-11 w-full rounded-lg border border-line-strong bg-white px-3 text-sm placeholder:text-muted"
                    />
                    {full ? (
                      <p className="mt-3 text-sm text-ink-soft">
                        Your shortlist is full. Remove a piece to add another.
                      </p>
                    ) : null}
                    <ul
                      className="mt-3 grid grid-cols-1 gap-2"
                      data-testid="suggestions"
                    >
                      {catalog.length === 0
                        ? [0, 1, 2].map((i) => (
                            <li
                              key={i}
                              className="gf-shimmer h-16 rounded-lg"
                              aria-hidden="true"
                            />
                          ))
                        : suggestions.map((p) => (
                            <li
                              key={p.id}
                              className="flex items-center gap-3 rounded-lg bg-white p-2 pr-1"
                            >
                              <Image
                                src={p.image}
                                alt=""
                                width={48}
                                height={48}
                                className="h-12 w-12 shrink-0 object-contain"
                              />
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-medium">
                                  {p.title}
                                </p>
                                <p className="text-xs text-muted">
                                  {pieceSummary(p, check.cap, draft.metalLock)}
                                </p>
                              </div>
                              <button
                                type="button"
                                onClick={() => addPiece(p)}
                                disabled={full}
                                data-testid="add-to-shortlist"
                                className="min-h-11 rounded-full border border-ink px-4 text-sm font-medium text-ink hover:bg-ink hover:text-ivory disabled:cursor-not-allowed disabled:border-line-strong disabled:text-muted disabled:hover:bg-transparent"
                                aria-label={`Add ${p.title} to shortlist`}
                              >
                                Add
                              </button>
                            </li>
                          ))}
                    </ul>
                    {catalog.length > 0 && suggestions.length === 0 ? (
                      <p className="mt-2 text-sm text-muted">
                        No designs match. Try another word, a higher cap or
                        another metal.
                      </p>
                    ) : null}
                    {suggestions.length >= suggestLimit ? (
                      <button
                        type="button"
                        onClick={() => setSuggestLimit((n) => n + 6)}
                        className="mt-3 min-h-11 text-sm text-ink underline decoration-gold underline-offset-4"
                      >
                        Show more pieces
                      </button>
                    ) : null}
                  </section>
                </>
              )}
            </div>

            <footer className="border-t border-line bg-ivory px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4">
              {submitError ? (
                <p
                  id={`${ids.title}-err`}
                  role="alert"
                  className="mb-3 rounded-lg bg-blush px-3 py-2 text-sm text-rose"
                >
                  {submitError}
                </p>
              ) : null}
              {showErrors && !check.ok ? (
                <p role="alert" className="mb-3 text-sm text-rose">
                  Please fix the highlighted{" "}
                  {Object.keys(check.errors).length === 1 ? "field" : "fields"}.
                </p>
              ) : null}
              <button
                type="submit"
                data-testid="send-fit-request"
                disabled={phase.kind === "sending"}
                className="flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-ink px-6 text-sm font-medium text-ivory transition-colors hover:bg-ink-soft disabled:cursor-wait disabled:opacity-80"
              >
                {phase.kind === "sending"
                  ? "Creating your private link…"
                  : "Send a Fit Request"}
              </button>
              <p className="mt-3 text-center text-xs leading-5 text-muted">
                {helpMode
                  ? "Every piece is a real option within your budget. You'll see what they loved, plus a few similar pieces they haven't seen."
                  : "Your picks are mixed with similar pieces, so they can't tell which you chose."}
              </p>
            </footer>
          </form>
        )}
        <p aria-live="polite" className="sr-only">
          {announce}
        </p>
      </div>
    </dialog>
  );
}

export default GiverPanel;

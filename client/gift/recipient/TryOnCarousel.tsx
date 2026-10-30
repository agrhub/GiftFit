"use client";
/**
 * Try-on carousel (owner: A4). Every design uses the same card in the server's order: no
 * attribute, class, badge or order hint separates the giver's picks from the similar pieces
 * (the client never knows which is which). Every try-on is labelled "AI preview".
 * ADR-032: no prices anywhere; each card has metal swatches; tapping one renders that metal
 * lazily (that card only shows a loading state); the heart applies to the metal shown; a
 * secondary action says "Love the style, wish it came in another metal".
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { CarouselItem } from "@/server/contracts/api";
import { fromEnglish, metalInline } from "@/server/i18n/recipient";
import { ChevronIcon, HandIcon, HeartIcon } from "../icons";
import { type RetakeKind, failureCopy } from "./tryOnFailures";
import { type CardState } from "./variants";
import { FULL_FRAME_STYLE, cropStyle } from "./cropConfig";
import { AiModelBadge } from "./AiModelBadge";
import { useRt } from "./i18n";

export { CAP_NOTE, type CardState, type TryOnRender } from "./variants";

export function TryOnCard({
  item,
  state,
  index,
  total,
  readOnly = false,
  onSwatch,
  onToggleHeart,
  onWish,
  onRetake,
  fullFrame = false,
  onToggleFullFrame,
  demo = false,
}: {
  item: CarouselItem;
  state: CardState;
  index: number;
  total: number;
  readOnly?: boolean;
  onSwatch: (swatchId: string) => void;
  onToggleHeart: () => void;
  onWish: () => void;
  onRetake?: (kind: RetakeKind) => void;
  /** Show the whole try-on photo instead of the focused crop (cropConfig.ts). */
  fullFrame?: boolean;
  onToggleFullFrame?: () => void;
  /** Seeded judge demo: label the person as an AI-generated model. */
  demo?: boolean;
}) {
  const t = useRt();
  const { render } = state;
  const [broken, setBroken] = useState<string | null>(null);
  const showTryOn =
    render?.status === "ready" && render.imageUrl && broken !== render.imageUrl;
  const failure =
    render?.status === "failed"
      ? failureCopy(item, render.failureReason, t.locale)
      : null;
  const swatches = item.swatches ?? [];
  const shown = swatches.find((s) => s.swatchId === state.swatchId);
  // The server sends English metal names (SWATCH_LABEL); shown in the page locale.
  const metalName = shown?.metalLabel
    ? fromEnglish(t.locale, "metal.", shown.metalLabel)
    : undefined;
  const metalInSentence = shown?.metalLabel
    ? metalInline(t.locale, shown.metalLabel)
    : undefined;
  const named = metalInSentence
    ? t("piece.inMetal", { title: item.title, metal: metalInSentence })
    : item.title;

  return (
    <article
      data-testid="carousel-item"
      aria-roledescription="slide"
      aria-label={t("card.slide", {
        index: index + 1,
        total,
        title: item.title,
      })}
      className="relative flex h-full flex-col overflow-hidden rounded-2xl border border-line bg-white"
    >
      <div
        className="relative overflow-hidden bg-white"
        style={{ aspectRatio: "4 / 5" }}
      >
        {showTryOn ? (
          // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL, recipient session only
          <img
            src={render!.imageUrl}
            alt={t("card.alt", { name: named })}
            data-testid="tryon-image"
            className="h-full w-full object-cover transition-transform duration-500 ease-[var(--ease-soft)]"
            style={fullFrame ? FULL_FRAME_STYLE : cropStyle(item.category)}
            onError={() => setBroken(render!.imageUrl!)}
          />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- public catalog image shown when no try-on exists
          <img
            src={item.productImage}
            alt={item.title}
            className="h-full w-full bg-paper object-contain p-[14%] mix-blend-multiply"
          />
        )}
        {showTryOn ? (
          <div className="absolute left-3 top-3 z-10 flex flex-col items-start gap-1.5">
            <span className="rounded-full bg-ink/80 px-2.5 py-1 text-[0.7rem] font-semibold uppercase tracking-[0.12em] text-ivory backdrop-blur">
              {t("card.aiPreview")}
            </span>
            {demo ? <AiModelBadge /> : null}
          </div>
        ) : null}
        {showTryOn && onToggleFullFrame ? (
          <button
            type="button"
            onClick={onToggleFullFrame}
            aria-pressed={fullFrame}
            data-testid="toggle-full-frame"
            title={
              fullFrame
                ? t("card.backTo", { focus: t(`focus.${item.category}`) })
                : undefined
            }
            className={`absolute bottom-3 left-3 z-10 min-h-11 rounded-full px-3.5 text-xs font-medium shadow-md backdrop-blur transition-colors ${
              fullFrame ? "bg-ink text-ivory" : "bg-white/95 text-ink"
            }`}
          >
            {t("card.fullPhoto")}
          </button>
        ) : null}
        {state.loading ? (
          <div
            className="absolute inset-0 grid place-items-center bg-ivory/70 backdrop-blur-[2px]"
            data-testid="swatch-loading"
          >
            <p
              className="flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm text-ink shadow"
              role="status"
            >
              <span
                className="h-4 w-4 animate-spin rounded-full border-2 border-line border-t-gold-deep"
                aria-hidden="true"
              />
              {metalInSentence
                ? t("card.trying", { metal: metalInSentence })
                : t("card.tryingThis")}
            </p>
          </div>
        ) : null}
        {!showTryOn && !state.loading ? (
          <p className="absolute inset-x-3 bottom-3 flex items-center gap-2 rounded-xl bg-ivory/95 px-3 py-2 text-xs leading-5 text-ink-soft">
            {state.noTryOn ? (
              <span data-testid="product-photo-note">
                {t("card.productPhoto")}
              </span>
            ) : state.notTriable || render?.status === "skipped_not_eligible" ? (
              <span data-testid="not-tried-on-note">
                {t("card.notTriedOn")}
              </span>
            ) : state.rendersOff ? (
              <span data-testid="product-photo-note">
                {t("card.renderDeleted")}
              </span>
            ) : render?.status === "skipped_needs_hand" ||
              (!render && item.needsHandPhoto) ? (
              <>
                <HandIcon className="h-4 w-4 shrink-0" /> {t("card.needsHand")}
              </>
            ) : (
              <span>
                {failure?.text ??
                  (metalInSentence && render
                    ? t("card.unavailableIn", { metal: metalInSentence })
                    : t("card.unavailable"))}
                {failure?.retake && onRetake && !readOnly ? (
                  <>
                    {" "}
                    <button
                      type="button"
                      onClick={() => onRetake(failure.retake!)}
                      data-testid={
                        failure.retake === "wrist"
                          ? "retake-photos"
                          : "retake-selfie"
                      }
                      className="font-medium text-ink underline decoration-gold underline-offset-2"
                    >
                      {failure.retake === "wrist"
                        ? t("card.retakePhotos")
                        : t("card.retakeSelfie")}
                    </button>
                  </>
                ) : null}
              </span>
            )}
          </p>
        ) : null}
        {readOnly ? null : (
          <button
            type="button"
            onClick={onToggleHeart}
            aria-pressed={state.hearted}
            aria-label={
              metalInSentence
                ? t("card.heartMetal", {
                    title: item.title,
                    metal: metalInSentence,
                  })
                : t("card.heart", { title: item.title })
            }
            data-testid="heart"
            className={`absolute right-3 top-3 grid h-12 w-12 place-items-center rounded-full shadow-md transition-[transform,background-color] duration-200 active:scale-90 ${state.hearted ? "bg-rose text-white" : "bg-white/95 text-ink"}`}
          >
            <HeartIcon filled={state.hearted} className="h-6 w-6" />
          </button>
        )}
      </div>

      <div className="flex flex-1 flex-col px-4 pb-4 pt-3">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="font-display text-xl leading-tight text-ink">
            {item.title}
          </h3>
          <p className="shrink-0 text-xs uppercase tracking-[0.14em] text-muted">
            {t(`category.${item.category}`)}
          </p>
        </div>

        {swatches.length ? (
          <div
            className="mt-2 flex items-center gap-1"
            role="radiogroup"
            aria-label={t("card.metalFor", { title: item.title })}
            data-testid="swatches"
          >
            {swatches.map((s) => {
              const checked = s.swatchId === state.swatchId;
              // After "Delete my photo now", only metals already rendered can be shown.
              const locked =
                Boolean(state.rendersOff) &&
                !checked &&
                !(state.renderedSwatchIds ?? []).includes(s.swatchId);
              return (
                <button
                  key={s.swatchId}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  aria-label={fromEnglish(t.locale, "metal.", s.metalLabel)}
                  title={fromEnglish(t.locale, "metal.", s.metalLabel)}
                  disabled={state.loading || locked}
                  aria-disabled={locked || undefined}
                  onClick={() => !checked && !locked && onSwatch(s.swatchId)}
                  data-testid="swatch"
                  className={`grid h-11 w-11 place-items-center rounded-full ${locked ? "cursor-not-allowed opacity-40" : "disabled:cursor-wait"}`}
                >
                  <span
                    aria-hidden="true"
                    className={`block h-7 w-7 rounded-full border ${checked ? "border-ink ring-2 ring-ink ring-offset-2 ring-offset-white" : "border-line-strong"}`}
                    style={{ background: s.swatchColor }}
                  />
                </button>
              );
            })}
            {metalName ? (
              <span className="ml-1 text-sm text-ink-soft">{metalName}</span>
            ) : null}
          </div>
        ) : null}
        {state.rendersOff && swatches.length > 1 ? (
          <p
            className="mt-1 text-xs text-ink-soft"
            data-testid="renders-off-note"
          >
            {t("card.rendersOff")}
          </p>
        ) : null}
        {state.capNote ? (
          <p
            className="mt-1 text-xs text-ink-soft"
            role="status"
            data-testid="cap-note"
          >
            {t("card.capNote")}
          </p>
        ) : null}

        {readOnly ? null : (
          <button
            type="button"
            onClick={onWish}
            disabled={state.wished}
            aria-pressed={state.wished}
            data-testid="wish-metal"
            className="mt-2 min-h-11 self-start text-left text-sm text-ink-soft underline decoration-line-strong underline-offset-4 hover:text-ink disabled:no-underline disabled:opacity-100"
          >
            {state.wished ? t("card.wished") : t("card.wish")}
          </button>
        )}
      </div>
    </article>
  );
}

export interface TryOnCarouselProps {
  items: CarouselItem[];
  cards: Record<string, CardState>;
  readOnly?: boolean;
  onSwatch: (itemId: string, swatchId: string) => void;
  onToggleHeart: (itemId: string) => void;
  onWish: (itemId: string) => void;
  onRetake?: (kind: RetakeKind) => void;
  demo?: boolean;
}

export function TryOnCarousel({
  items,
  cards,
  readOnly = false,
  onSwatch,
  onToggleHeart,
  onWish,
  onRetake,
  demo = false,
}: TryOnCarouselProps) {
  // Full-frame toggle per card; kept while swiping (the cards stay mounted).
  const [fullFrame, setFullFrame] = useState<ReadonlySet<string>>(new Set());
  const toggleFull = (itemId: string) =>
    setFullFrame((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  const t = useRt();
  const trackRef = useRef<HTMLUListElement>(null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const track = trackRef.current;
    if (!track || typeof IntersectionObserver === "undefined") return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries)
          if (e.isIntersecting)
            setActive(Number((e.target as HTMLElement).dataset.index));
      },
      { root: track, threshold: 0.6 },
    );
    track.querySelectorAll("li").forEach((li) => obs.observe(li));
    return () => obs.disconnect();
  }, [items.length]);

  const go = useCallback((i: number) => {
    const track = trackRef.current;
    const li = track?.querySelectorAll("li")[i] as HTMLElement | undefined;
    if (!track || !li) return;
    const reduce = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    track.scrollTo({
      left: li.offsetLeft - track.offsetLeft,
      behavior: reduce ? "auto" : "smooth",
    });
  }, []);

  return (
    <section
      aria-roledescription="carousel"
      aria-label={t("carousel.label")}
      className="relative"
    >
      <ul
        ref={trackRef}
        className="gf-no-scrollbar -mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto scroll-px-4 px-4 pb-2 md:mx-0 md:grid md:grid-cols-3 md:overflow-visible md:px-0"
        data-testid="carousel"
      >
        {items.map((item, i) => (
          <li
            key={item.itemId}
            data-index={i}
            className="w-[82%] shrink-0 snap-start md:w-auto"
          >
            <TryOnCard
              item={item}
              state={
                cards[item.itemId] ?? {
                  loading: false,
                  hearted: false,
                  wished: false,
                  capNote: false,
                }
              }
              index={i}
              total={items.length}
              readOnly={readOnly}
              onSwatch={(s) => onSwatch(item.itemId, s)}
              onToggleHeart={() => onToggleHeart(item.itemId)}
              onWish={() => onWish(item.itemId)}
              onRetake={readOnly ? undefined : onRetake}
              fullFrame={fullFrame.has(item.itemId)}
              onToggleFullFrame={() => toggleFull(item.itemId)}
              demo={demo}
            />
          </li>
        ))}
      </ul>
      <div className="mt-3 flex items-center justify-between md:hidden">
        <button
          type="button"
          onClick={() => go(Math.max(0, active - 1))}
          disabled={active === 0}
          className="grid h-11 w-11 place-items-center rounded-full border border-line-strong text-ink disabled:opacity-40"
          aria-label={t("carousel.prev")}
        >
          <ChevronIcon dir="left" />
        </button>
        <p className="text-sm text-ink-soft" aria-live="polite">
          {t("carousel.position", { index: active + 1, total: items.length })}
        </p>
        <button
          type="button"
          onClick={() => go(Math.min(items.length - 1, active + 1))}
          disabled={active >= items.length - 1}
          className="grid h-11 w-11 place-items-center rounded-full border border-line-strong text-ink disabled:opacity-40"
          aria-label={t("carousel.next")}
        >
          <ChevronIcon />
        </button>
      </div>
    </section>
  );
}

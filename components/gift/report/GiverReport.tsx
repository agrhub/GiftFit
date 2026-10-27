"use client";
/**
 * The giver's Fit Report (owner: A4). Scores, breakdown and short reasons for the giver's own
 * shortlist. By construction it renders NO image elements at all (no <img>, <picture>, SVG
 * <image> or CSS background images): the recipient's photos never reach this page, and product
 * photos are left out too so the "0 photos" promise is literal. Labels only, never hex or LAB.
 * "Help me choose" requests (ADR-045, A3) add a taste summary from the hearts and 2–3 similar
 * designs they did not see, each clearly labelled "Not tried on", so the gift can stay a surprise.
 */
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FitResult, Metal } from "@/lib/contracts/giftfit";
import { FIT_WEIGHTS } from "@/lib/fit/weights";
import type { Product } from "@/components/store/catalog";
import { GiverTransparencyCard, Disclaimer } from "@/components/trust";
import { METAL_LABELS, METAL_SWATCH, formatExpiry, formatPrice, productPath } from "@/components/store/format";
import { ApiError, type GiftApi, type GiverReportView, friendlyError, loadGiftApi } from "../api";
import { HeartIcon, ShieldIcon } from "../icons";

export const REPORT_POLL_MS = 5000;

// Maxima are the published weights (fit-v1.1: hearts 60, metal 10, style 15, budget and occasion 15).
const FACTORS: Array<{ key: keyof FitResult["breakdown"]; label: string; max: number }> = [
  { key: "hearts", label: "Their hearts", max: FIT_WEIGHTS.hearts },
  { key: "metal", label: "Metal and undertone", max: FIT_WEIGHTS.metal },
  { key: "style", label: "Style and face shape", max: FIT_WEIGHTS.style },
  { key: "budgetOccasion", label: "Budget and occasion", max: FIT_WEIGHTS.budgetOccasion },
];

type ProductInfo = Pick<Product, "id" | "slug" | "title" | "price" | "currency" | "metal"> & { variants?: Product["variants"] };

/** "Help me choose": what their hearts say. Words only, from catalog attributes of the hearted pieces. */
export function TasteSummaryCard({ summary }: { summary: NonNullable<GiverReportView["tasteSummary"]> }) {
  return (
    <section aria-labelledby="taste-summary-h" className="gf-fade-in mt-6 rounded-2xl border border-gold/40 bg-white p-5" data-testid="taste-summary">
      <h2 id="taste-summary-h" className="text-xs font-semibold uppercase tracking-[0.18em] text-gold-deep">
        Their taste
      </h2>
      <p className="mt-2 font-display text-xl leading-snug text-ink" data-testid="taste-summary-text">
        {summary.text}
      </p>
      <p className="mt-2 text-xs text-muted" data-testid="taste-summary-source">
        {summary.source === "claude" ? "Written by Claude from the pieces they hearted (no photos)." : "Summed up from the pieces they hearted."}
      </p>
    </section>
  );
}

/** "Help me choose": similar designs they did NOT see. Clearly labelled, never scored, no images. */
export function NotTriedList({ picks, products }: { picks: GiverReportView["similarNotTried"]; products: Record<string, ProductInfo> }) {
  if (picks.length === 0) return null;
  return (
    <section aria-labelledby="not-tried-h" className="mt-8" data-testid="not-tried">
      <h2 id="not-tried-h" className="font-display text-2xl text-ink">
        Similar pieces, not tried on
      </h2>
      <p className="mt-1 text-sm leading-6 text-ink-soft">They match what they hearted and fit your budget. They haven&apos;t seen these, so one could stay a surprise.</p>
      <ul className="mt-4 grid gap-3 sm:grid-cols-2">
        {picks.map((p) => {
          const product = products[p.catalogId];
          const variant = product?.variants?.find((v) => v.variantId === p.variantId);
          const metal: Metal | undefined = variant?.metal ?? product?.metal;
          return (
            <li key={p.catalogId} className="rounded-2xl border border-dashed border-line-strong bg-white p-4" data-testid="not-tried-item">
              <span className="inline-flex rounded-full bg-cream px-2 py-0.5 text-xs font-medium text-ink-soft" data-testid="not-tried-label">
                Not tried on
              </span>
              <h3 className="mt-2 font-display text-lg leading-tight text-ink">{product?.title ?? "A similar piece"}</h3>
              <p className="mt-1 flex flex-wrap items-center gap-x-3 text-sm text-ink-soft">
                {metal ? (
                  <span className="inline-flex items-center gap-1.5">
                    <span aria-hidden="true" className="inline-block h-3 w-3 rounded-full border border-line-strong" style={{ background: METAL_SWATCH[metal] }} />
                    {METAL_LABELS[metal]}
                  </span>
                ) : null}
                <span>{formatPrice(p.price, p.currency)}</span>
              </p>
              {product ? (
                <a href={productPath(product)} className="mt-3 inline-flex min-h-11 items-center text-sm text-ink underline decoration-gold underline-offset-4">
                  View piece
                </a>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function PhotosSeenCounter() {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-sage/30 bg-white px-4 py-3" data-testid="photos-seen-counter">
      <ShieldIcon className="h-6 w-6 shrink-0 text-sage" />
      <p className="text-sm text-ink-soft">
        Photos seen by the giver: <strong className="text-lg font-semibold tabular-nums text-ink">0</strong>
      </p>
    </div>
  );
}

function ScoreRing({ score }: { score: number }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative grid h-[4.5rem] w-[4.5rem] shrink-0 place-items-center">
      <svg viewBox="0 0 64 64" className="absolute inset-0 -rotate-90" aria-hidden="true">
        <circle cx="32" cy="32" r={r} fill="none" stroke="var(--color-line)" strokeWidth="4" />
        <circle cx="32" cy="32" r={r} fill="none" stroke="var(--color-gold-deep)" strokeWidth="4" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - Math.max(0, Math.min(100, score)) / 100)} style={{ transition: "stroke-dashoffset 900ms var(--ease-soft)" }} />
      </svg>
      <span className="font-display text-3xl leading-none text-ink">{Math.round(score)}</span>
    </div>
  );
}

export function ReportItem({ result, product, hearted, wished = false, rank }: { result: FitResult; product?: ProductInfo; hearted: boolean; wished?: boolean; rank: number }) {
  const title = product?.title ?? "A piece they tried on";
  // ADR-032: the result is about one metal variant (the hearted one, else the best eligible one).
  const metal = result.metal ?? product?.metal;
  const price = result.price ?? product?.price;
  const currency = product?.currency ?? "USD";
  return (
    <li data-testid="fit-report-item" className="gf-fade-in rounded-2xl border border-line bg-white p-5">
      <div className="flex items-start gap-4">
        <ScoreRing score={result.score} />
        <div className="min-w-0 flex-1">
          <p className="text-xs uppercase tracking-[0.16em] text-muted">#{rank} · Fit Score</p>
          <h3 className="mt-1 font-display text-2xl leading-tight text-ink">{title}</h3>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-soft">
            {metal ? (
              <span className="inline-flex items-center gap-1.5" data-testid="report-metal">
                <span aria-hidden="true" className="inline-block h-3 w-3 rounded-full border border-line-strong" style={{ background: METAL_SWATCH[metal] }} />
                {METAL_LABELS[metal]}
              </span>
            ) : null}
            {price !== undefined ? <span data-testid="report-price">{formatPrice(price, currency)}</span> : null}
            {hearted ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-blush px-2 py-0.5 text-xs font-medium text-rose" data-testid="hearted-badge">
                <HeartIcon filled className="h-3.5 w-3.5" /> They loved it
              </span>
            ) : null}
            {wished ? (
              <span className="inline-flex items-center rounded-full border border-line-strong px-2 py-0.5 text-xs font-medium text-ink-soft" data-testid="wished-other-metal">
                Wished for another metal
              </span>
            ) : null}
          </p>
        </div>
      </div>
      <p className="sr-only">
        {title}
        {metal ? ` in ${METAL_LABELS[metal].toLowerCase()}` : ""} scored {Math.round(result.score)} out of 100{hearted ? ", and they hearted it" : ""}
        {wished ? ". They wished it came in another metal" : ""}.
      </p>

      <dl className="mt-5 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {FACTORS.map((f) => {
          const v = result.breakdown[f.key] ?? 0;
          return (
            <div key={f.key}>
              <div className="flex justify-between text-xs text-ink-soft">
                <dt>{f.label}</dt>
                <dd>
                  {v.toFixed(v % 1 ? 1 : 0)} / {f.max}
                </dd>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-cream" aria-hidden="true">
                <div className="h-full rounded-full bg-gold-deep" style={{ width: `${Math.max(0, Math.min(100, (v / f.max) * 100))}%`, transition: "width 900ms var(--ease-soft)" }} />
              </div>
            </div>
          );
        })}
      </dl>

      {result.reasons.length ? (
        <ul className="mt-5 space-y-1.5 text-sm leading-6 text-ink">
          {result.reasons.map((r) => (
            <li key={r} className="flex gap-2">
              <span aria-hidden="true" className="mt-2.5 h-1 w-1 shrink-0 rounded-full bg-gold-deep" />
              {r}
            </li>
          ))}
        </ul>
      ) : null}
      {result.caution ? <p className="mt-3 rounded-lg bg-cream px-3 py-2 text-sm text-ink-soft">Worth knowing: {result.caution}</p> : null}

      {product ? (
        // The store's own product page (the demo store, via the /p/<slug> 308): buying happens there.
        <a href={productPath(product)} data-testid="buy-button" className="mt-5 inline-flex min-h-12 w-full items-center justify-center rounded-full bg-ink px-6 text-sm font-medium text-ivory transition-colors hover:bg-ink-soft sm:w-auto">
          Buy as a gift · {metal ? `${METAL_LABELS[metal]} · ` : ""}
          {formatPrice(price ?? product.price, currency)}
        </a>
      ) : null}
    </li>
  );
}

export interface GiverReportProps {
  token: string;
  api?: GiftApi;
  /** Product lookup; loaded lazily from the catalog when omitted. */
  products?: Record<string, ProductInfo>;
  pollMs?: number;
}

type View = { kind: "loading" } | { kind: "error"; message: string } | { kind: "gone"; expired: boolean } | { kind: "report"; report: GiverReportView };

export function GiverReport({ token, api: apiProp, products: productsProp, pollMs = REPORT_POLL_MS }: GiverReportProps) {
  const [view, setView] = useState<View>({ kind: "loading" });
  const [products, setProducts] = useState<Record<string, ProductInfo>>(productsProp ?? {});
  const [announce, setAnnounce] = useState("");
  // Seeded judge demo: flagged by the report API (when A3 adds it) or by the demo page's ?demo=1 link.
  const [demoLink, setDemoLink] = useState(false);
  useEffect(() => setDemoLink(new URLSearchParams(window.location.search).get("demo") === "1"), []);
  const lastState = useRef<string>("");

  useEffect(() => {
    if (productsProp) return;
    import("@/components/store/catalog").then((m) => setProducts(Object.fromEntries(m.PRODUCTS.map((p) => [p.id, p]))));
  }, [productsProp]);

  const load = useCallback(async () => {
    try {
      const api = apiProp ?? (await loadGiftApi());
      const report = await api.giverReport(token);
      setView({ kind: "report", report });
      return report.state;
    } catch (err) {
      if (err instanceof ApiError && err.status === 410) setView({ kind: "gone", expired: true });
      else if (err instanceof ApiError && err.status === 404 && !err.routeMissing) setView({ kind: "gone", expired: false });
      else setView({ kind: "error", message: friendlyError(err) });
      return "stop";
    }
  }, [apiProp, token]);

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const tick = async () => {
      const state = await load();
      if (alive && (state === "waiting" || state === "in_progress")) timer = window.setTimeout(tick, pollMs);
    };
    void tick();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [load, pollMs]);

  // Announce the report when it completes (aria-live), once.
  useEffect(() => {
    if (view.kind !== "report" || view.report.state === lastState.current) return;
    const prev = lastState.current;
    lastState.current = view.report.state;
    if (view.report.state === "completed" && prev !== "") {
      const top = [...view.report.results].sort((a, b) => b.score - a.score)[0];
      setAnnounce(top ? `Your Fit Report is ready. ${products[top.skuId]?.title ?? "Your top piece"} scored ${Math.round(top.score)}.` : "Your Fit Report is ready.");
    }
  }, [view, products]);

  const report = view.kind === "report" ? view.report : null;
  const sorted = report ? [...report.results].sort((a, b) => b.score - a.score) : [];
  const heartedSet = new Set(report?.heartedIds ?? []);
  const isDemo = Boolean(report?.demo) || demoLink;
  const wishedSet = new Set(report?.otherMetalWishes ?? []);

  return (
    <div className="mx-auto w-full max-w-3xl" data-testid="fit-report">
      <p aria-live="polite" className="sr-only">
        {announce}
      </p>
      <p className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-[0.24em] text-gold-deep">
        Gift it right · Fit Report
        {isDemo ? (
          <span className="rounded-full bg-gold-deep px-2.5 py-1 normal-case tracking-normal text-white" data-testid="demo-request">
            Demo request
          </span>
        ) : null}
      </p>
      {isDemo ? <p className="mt-2 text-sm text-ink-soft">Seeded judge demo: the recipient is an AI-generated model with pre-recorded try-ons. No real person, no cost.</p> : null}
      <h1 className="mt-3 font-display text-4xl leading-tight text-ink sm:text-5xl">
        {report?.state === "completed" ? "Here's what fits." : report?.state === "expired" ? "This request has expired." : "Your Fit Report"}
      </h1>
      <div className="mt-6">
        <PhotosSeenCounter />
      </div>

      {view.kind === "loading" ? (
        <div className="mt-8 space-y-4" aria-busy="true" aria-label="Loading your report">
          <div className="gf-shimmer h-40 rounded-2xl" />
          <div className="gf-shimmer h-40 rounded-2xl" />
        </div>
      ) : null}

      {view.kind === "error" ? (
        <div role="alert" className="mt-8 rounded-2xl border border-line bg-white p-6">
          <p className="text-ink">{view.message}</p>
          <button type="button" onClick={() => void load()} className="mt-4 min-h-11 rounded-full border border-ink px-5 text-sm text-ink hover:bg-cream">
            Try again
          </button>
        </div>
      ) : null}

      {view.kind === "gone" ? (
        <div className="mt-8 rounded-2xl border border-line bg-white p-6" data-testid="report-gone">
          <h2 className="font-display text-2xl text-ink">{view.expired ? "This link has expired" : "This report isn't available"}</h2>
          <p className="mt-2 text-sm leading-6 text-ink-soft">
            {view.expired
              ? "Fit Requests last 72 hours, and then everything connected to them is deleted."
              : "The link may be mistyped, or they chose to delete everything. That's their call, and nothing about them remains."}
          </p>
          <Link href="/" className="mt-4 inline-flex min-h-11 items-center rounded-full bg-ink px-5 text-sm font-medium text-ivory">
            Back to GiftFit
          </Link>
        </div>
      ) : null}

      {report && (report.state === "waiting" || report.state === "in_progress") ? (
        <div className="mt-8 rounded-2xl border border-line bg-white p-6" data-testid="report-waiting" role="status">
          <div className="flex items-center gap-3">
            <span className="relative flex h-3 w-3">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-gold opacity-60" />
              <span className="relative inline-flex h-3 w-3 rounded-full bg-gold-deep" />
            </span>
            <h2 className="font-display text-2xl text-ink">{report.state === "in_progress" ? "They're trying pieces on" : "Waiting for them to open the link"}</h2>
          </div>
          <p className="mt-2 text-sm leading-6 text-ink-soft">This page updates by itself. Scores appear once they send their hearts.</p>
          {formatExpiry(report.expiresAt) ? <p className="mt-2 text-xs text-muted">Link works until {formatExpiry(report.expiresAt)}.</p> : null}
        </div>
      ) : null}

      {report?.state === "completed" ? (
        <>
          <dl className="mt-6 grid grid-cols-3 gap-2 text-center">
            <div className="rounded-xl border border-line bg-white p-3">
              <dt className="text-[0.65rem] uppercase tracking-[0.14em] text-muted">{report.mode === "help_me_choose" ? "Pieces tried" : "Your picks"}</dt>
              <dd className="font-display text-3xl text-ink">{sorted.length}</dd>
            </div>
            <div className="rounded-xl border border-line bg-white p-3">
              <dt className="text-[0.65rem] uppercase tracking-[0.14em] text-muted">Hearted</dt>
              <dd className="font-display text-3xl text-ink" data-testid="hearted-count">
                {sorted.filter((r) => heartedSet.has(r.skuId)).length}
              </dd>
            </div>
            <div className="rounded-xl border border-line bg-white p-3">
              <dt className="text-[0.65rem] uppercase tracking-[0.14em] text-muted">Top score</dt>
              <dd className="font-display text-3xl text-ink">{sorted[0] ? Math.round(sorted[0].score) : "–"}</dd>
            </div>
          </dl>
          {report.labels.undertone || report.labels.faceShape ? (
            <ul className="mt-4 flex flex-wrap gap-2" aria-label="Estimates used">
              {[report.labels.undertone, report.labels.faceShape].filter(Boolean).map((l) => (
                <li key={l} className="rounded-full border border-line-strong bg-white px-3 py-1 text-xs text-ink-soft">
                  {l}
                </li>
              ))}
            </ul>
          ) : null}
          {report.tasteSummary ? <TasteSummaryCard summary={report.tasteSummary} /> : null}
          <ol className="mt-6 space-y-4">
            {sorted.map((r, i) => (
              <ReportItem key={r.skuId} result={r} product={products[r.skuId]} hearted={heartedSet.has(r.skuId)} wished={wishedSet.has(r.skuId)} rank={i + 1} />
            ))}
          </ol>
          <NotTriedList picks={report.similarNotTried} products={products} />
          <Disclaimer className="mt-4" />
        </>
      ) : null}

      <GiverTransparencyCard expiresAt={report?.expiresAt} className="mt-10 border-line" />
    </div>
  );
}

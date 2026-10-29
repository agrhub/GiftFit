"use client";
/**
 * The giver's Fit Report (owner: A4). Scores, breakdown and short reasons for the giver's own
 * shortlist. By construction it renders NO image elements at all (no <img>, <picture>, SVG
 * <image> or CSS background images): the recipient's photos never reach this page, and product
 * photos are left out too so the "0 photos" promise is literal. Labels only, never hex or LAB.
 * "Help me choose" requests (ADR-045, A3) add a taste summary from the hearts and 2–3 similar
 * designs they did not see, each clearly labelled "Not tried on", so the gift can stay a surprise.
 * Without a try-on (store-URL previews, ADR-055, or no photo taken) there is no undertone or face-shape
 * estimate: only the factors actually scored are shown, and no line claims a try-on or an estimate.
 * A16 mixed sets: pieces whose store photo couldn't be tried on carry `tryOn: false`, a "Not tried on" chip, and
 * are scored like the no-try-on case (hearts + budget/occasion).
 *
 * Language (A22): the page follows the report's `lang` (the giver's language when the request was made,
 * one of the ten UI locales; lib/i18n/report), else the server-known `locale` prop, else English. The
 * reasons, cautions and taste summary arrive already written in it; product names stay as the store wrote
 * them; prices and dates use the locale's Intl formats.
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FitResult, Metal, Undertone } from "@/lib/contracts/giftfit";
import { FACE_SHAPES } from "@/lib/contracts/giftfit";
import { type Locale, formatMoney } from "@/lib/i18n";
import { type ReportMessageKey, reportDateTime, reportTranslator } from "@/lib/i18n/report";
import { giverFaceShapeLabel, giverUndertoneLabel } from "@/lib/privacy/labels";
import { FIT_WEIGHTS, FIT_WEIGHTS_NO_TRYON } from "@/lib/fit/weights";
import type { Product } from "@/components/store/catalog";
import { GiverTransparencyCard, Disclaimer, TransparencyCard } from "@/components/trust";
import { METAL_LABELS, METAL_SWATCH, formatExpiry, formatPrice, productPath } from "@/components/store/format";
import { ApiError, type GiftApi, type GiverReportView, friendlyError, loadGiftApi } from "../api";
import { setGiftStoreName, storeNameFor } from "../giftStore";
import { setGiftLocale } from "../giftLocale";
import { useExpiredLines } from "../expiredLines";
import { HeartIcon, ShieldIcon } from "../icons";

export const REPORT_POLL_MS = 5000;

type T = ReturnType<typeof reportTranslator>;

// Maxima are the published weights (fit-v1.1: hearts 60, metal 10, style 15, budget and occasion 15).
const FACTORS: Array<{ key: keyof FitResult["breakdown"]; label: string; max: number }> = [
  { key: "hearts", label: "Their hearts", max: FIT_WEIGHTS.hearts },
  { key: "metal", label: "Metal and undertone", max: FIT_WEIGHTS.metal },
  { key: "style", label: "Style and face shape", max: FIT_WEIGHTS.style },
  { key: "budgetOccasion", label: "Budget and occasion", max: FIT_WEIGHTS.budgetOccasion },
];
// Without a try-on only hearts and budget/occasion are scored, renormalised (80 + 20).
const FACTORS_NO_TRYON: typeof FACTORS = [
  { key: "hearts", label: "Their hearts", max: FIT_WEIGHTS_NO_TRYON.hearts },
  { key: "budgetOccasion", label: "Budget and occasion", max: FIT_WEIGHTS_NO_TRYON.budgetOccasion },
];

/** The factors this result was actually scored on (no metal/style factor without a try-on). */
export function factorsFor(result: FitResult): typeof FACTORS {
  return result.breakdown.metal === undefined && result.breakdown.style === undefined ? FACTORS_NO_TRYON : FACTORS;
}

/** Display metal name: the store's labels in English, the report catalog elsewhere. */
const metalName = (locale: Locale, metal: Metal) => (locale === "en" ? METAL_LABELS[metal] : reportTranslator(locale)(`metal.${metal}`));
/** Price in the locale's Intl format (English keeps the store's "$245"). */
const price = (locale: Locale, amount: number, currency: string) => (locale === "en" ? formatPrice(amount, currency) : formatMoney(locale, amount, currency));

const UNDERTONES: readonly Undertone[] = ["warm", "neutral", "cool"];

/**
 * The API's estimate labels are a fixed English vocabulary (lib/privacy/labels.ts; the giver guard allows
 * nothing else), so the page translates them by matching that vocabulary. Unknown text is shown as is.
 */
export function localizeEstimateLabel(locale: Locale, label: string): string {
  if (locale === "en") return label;
  const t = reportTranslator(locale);
  for (const u of UNDERTONES) {
    const tone = t(`undertone.${u}`);
    if (label === giverUndertoneLabel(u, { override: true })) return t("label.undertoneChoice", { tone });
    if (label === giverUndertoneLabel(u)) return t("label.undertoneEstimate", { tone });
    if (label === giverUndertoneLabel(u, { lowConfidence: true })) return t("label.lowConfidence", { label: t("label.undertoneEstimate", { tone }) });
  }
  for (const s of FACE_SHAPES) {
    if (s !== "Unknown" && label === giverFaceShapeLabel(s)) return t("label.faceShape", { shape: t(`faceShape.${s}`) });
  }
  return label;
}

type ProductInfo = Pick<Product, "id" | "slug" | "title" | "price" | "currency"> & {
  metal?: Product["metal"];
  variants?: Product["variants"];
  /** Store-URL preview pieces (ADR-055): the merchant's product page and image, frozen in the request. */
  url?: string;
  image?: string;
};

/** Aurum pieces link to their store page (/p/<slug> → demo store); preview pieces to the merchant's own page. */
function productLink(product: ProductInfo): { href: string; target?: string; rel?: string } {
  return product.url ? { href: product.url, target: "_blank", rel: "noopener noreferrer nofollow" } : { href: productPath({ slug: product.slug }) };
}

/** Merchant image straight from the store: plain <img>, no Referer, never proxied. */
function MerchantThumb({ product }: { product?: ProductInfo }) {
  if (!product?.url || !product.image) return null;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={product.image} alt="" width={72} height={72} loading="lazy" referrerPolicy="no-referrer" className="h-16 w-16 shrink-0 rounded-xl border border-line object-cover" data-testid="report-product-image" />;
}

/** "Help me choose": what their hearts say. Words only, from catalog attributes of the hearted pieces. */
export function TasteSummaryCard({ summary, locale = "en" }: { summary: NonNullable<GiverReportView["tasteSummary"]>; locale?: Locale }) {
  const t = reportTranslator(locale);
  return (
    <section aria-labelledby="taste-summary-h" className="gf-fade-in mt-6 rounded-2xl border border-gold/40 bg-white p-5" data-testid="taste-summary">
      <h2 id="taste-summary-h" className="text-xs font-semibold uppercase tracking-[0.18em] text-gold-deep">
        {t("ui.taste.title")}
      </h2>
      <p className="mt-2 font-display text-xl leading-snug text-ink" data-testid="taste-summary-text">
        {summary.text}
      </p>
      <p className="mt-2 text-xs text-muted" data-testid="taste-summary-source">
        {summary.source === "claude" ? t("ui.taste.sourceClaude") : t("ui.taste.sourceTemplate")}
      </p>
    </section>
  );
}

/** "Help me choose": similar designs they did NOT see. Clearly labelled, never scored, no images. */
export function NotTriedList({ picks, products, tryOn = true, locale = "en" }: { picks: GiverReportView["similarNotTried"]; products: Record<string, ProductInfo>; tryOn?: boolean; locale?: Locale }) {
  if (picks.length === 0) return null;
  const t = reportTranslator(locale);
  return (
    <section aria-labelledby="not-tried-h" className="mt-8" data-testid="not-tried">
      <h2 id="not-tried-h" className="font-display text-2xl text-ink">
        {tryOn ? t("ui.notTried.title") : t("ui.notTried.titleNoTryOn")}
      </h2>
      <p className="mt-1 text-sm leading-6 text-ink-soft">{t("ui.notTried.body")}</p>
      <ul className="mt-4 grid gap-3 sm:grid-cols-2">
        {picks.map((p) => {
          const product = products[p.catalogId];
          const variant = product?.variants?.find((v) => v.variantId === p.variantId);
          const metal: Metal | undefined = variant?.metal ?? product?.metal;
          return (
            <li key={p.catalogId} className="rounded-2xl border border-dashed border-line-strong bg-white p-4" data-testid="not-tried-item">
              <span className="inline-flex rounded-full bg-cream px-2 py-0.5 text-xs font-medium text-ink-soft" data-testid="not-tried-label">
                {tryOn ? t("ui.notTried.label") : t("ui.notTried.labelNoTryOn")}
              </span>
              <MerchantThumb product={product} />
              <h3 className="mt-2 font-display text-lg leading-tight text-ink [overflow-wrap:anywhere]">{product?.title ?? t("ui.notTried.fallbackTitle")}</h3>
              <p className="mt-1 flex flex-wrap items-center gap-x-3 text-sm text-ink-soft">
                {metal ? (
                  <span className="inline-flex items-center gap-1.5">
                    <span aria-hidden="true" className="inline-block h-3 w-3 rounded-full border border-line-strong" style={{ background: METAL_SWATCH[metal] }} />
                    {metalName(locale, metal)}
                  </span>
                ) : null}
                <span>{price(locale, p.price, p.currency)}</span>
              </p>
              {product ? (
                <a {...productLink(product)} className="mt-3 inline-flex min-h-11 items-center text-sm text-ink underline decoration-gold underline-offset-4">
                  {t("ui.viewPiece")}
                </a>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function PhotosSeenCounter({ locale = "en" }: { locale?: Locale }) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-sage/30 bg-white px-4 py-3" data-testid="photos-seen-counter">
      <ShieldIcon className="h-6 w-6 shrink-0 text-sage" />
      <p className="text-sm text-ink-soft">
        {reportTranslator(locale)("ui.photosSeen")} <strong className="text-lg font-semibold tabular-nums text-ink">0</strong>
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

export function ReportItem({ result, product, hearted, wished = false, rank, locale = "en" }: { result: FitResult; product?: ProductInfo; hearted: boolean; wished?: boolean; rank: number; locale?: Locale }) {
  const t = reportTranslator(locale);
  const title = product?.title ?? t("ui.item.fallbackTitle");
  // ADR-032: the result is about one metal variant (the hearted one, else the best eligible one).
  const metal = result.metal ?? product?.metal;
  const amount = result.price ?? product?.price;
  const currency = product?.currency ?? "USD";
  const metalLabel = metal ? metalName(locale, metal) : undefined;
  return (
    <li data-testid="fit-report-item" className="gf-fade-in rounded-2xl border border-line bg-white p-5">
      <div className="flex items-start gap-4">
        <ScoreRing score={result.score} />
        <MerchantThumb product={product} />
        <div className="min-w-0 flex-1">
          <p className="text-xs uppercase tracking-[0.16em] text-muted">{t("ui.item.rank", { rank })}</p>
          <h3 className="mt-1 font-display text-2xl leading-tight text-ink [overflow-wrap:anywhere]">{title}</h3>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-soft">
            {metal ? (
              <span className="inline-flex items-center gap-1.5" data-testid="report-metal">
                <span aria-hidden="true" className="inline-block h-3 w-3 rounded-full border border-line-strong" style={{ background: METAL_SWATCH[metal] }} />
                {metalLabel}
              </span>
            ) : null}
            {amount !== undefined ? <span data-testid="report-price">{price(locale, amount, currency)}</span> : null}
            {hearted ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-blush px-2 py-0.5 text-xs font-medium text-rose" data-testid="hearted-badge">
                <HeartIcon filled className="h-3.5 w-3.5" /> {t("ui.item.loved")}
              </span>
            ) : null}
            {wished ? (
              <span className="inline-flex items-center rounded-full border border-line-strong px-2 py-0.5 text-xs font-medium text-ink-soft" data-testid="wished-other-metal">
                {t("ui.item.wished")}
              </span>
            ) : null}
            {result.tryOn === false ? (
              <span className="inline-flex items-center rounded-full border border-line-strong px-2 py-0.5 text-xs font-medium text-ink-soft" data-testid="not-tried-on-badge">
                {t("ui.item.notTried")}
              </span>
            ) : null}
          </p>
        </div>
      </div>
      <p className="sr-only">
        {t("ui.item.sr", {
          title,
          inMetal: metalLabel ? t("ui.item.srMetal", { metal: locale === "en" ? metalLabel.toLowerCase() : metalLabel }) : "",
          score: Math.round(result.score),
          hearted: hearted ? t("ui.item.srHearted") : "",
          wished: wished ? t("ui.item.srWished") : "",
          notTried: result.tryOn === false ? t("ui.item.srNotTried") : "",
        })}
      </p>

      <dl className="mt-5 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {factorsFor(result).map((f) => {
          const v = result.breakdown[f.key] ?? 0;
          return (
            <div key={f.key}>
              <div className="flex justify-between gap-3 text-xs text-ink-soft">
                <dt>{locale === "en" ? f.label : t(`ui.factor.${f.key}` as ReportMessageKey)}</dt>
                <dd className="shrink-0 tabular-nums">
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
      {result.caution ? <p className="mt-3 rounded-lg bg-cream px-3 py-2 text-sm text-ink-soft">{t("ui.item.caution", { caution: result.caution })}</p> : null}

      {product ? (
        // The store's own product page (the demo store, via the /p/<slug> 308): buying happens there.
        <a {...productLink(product)} data-testid="buy-button" className="mt-5 inline-flex min-h-12 w-full items-center justify-center rounded-full bg-ink px-6 py-2 text-center text-sm font-medium text-ivory transition-colors hover:bg-ink-soft sm:w-auto">
          {t("ui.item.buy", { details: [...(metalLabel ? [metalLabel] : []), price(locale, amount ?? product.price ?? 0, currency)].join(" · ") })}
        </a>
      ) : null}
    </li>
  );
}

/** "What you will and won't see" in the report language (English: A5's GiverTransparencyCard as is). */
function LocalizedGiverCard({ t, locale, expiresAt, mode = "i_have_ideas", tryOn, className }: { t: T; locale: Locale; expiresAt?: string; mode?: GiverReportView["mode"]; tryOn: boolean; className?: string }) {
  const help = mode === "help_me_choose";
  const expiry = reportDateTime(locale, expiresAt, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
  return (
    <TransparencyCard
      className={className}
      title={t("card.title")}
      intro={t("card.intro")}
      sections={[
        { heading: t("card.see"), items: [help ? t("card.seeScoreHelp") : t("card.seeScore"), t("card.seeReasons"), help ? t("card.seeHeartsHelp") : t("card.seeHearts")] },
        {
          heading: t("card.wont"),
          items: [...(tryOn ? [t("card.wontPhotos"), t("card.wontFace")] : [t("card.wontNoPhoto")]), ...(help ? [] : [t("card.wontOthers")])],
        },
        {
          heading: t("card.good"),
          items: [
            ...(tryOn ? [t("card.goodEstimates")] : []),
            expiry ? t("card.goodExpiresOn", { date: `${expiry} UTC` }) : t("card.goodExpires72"),
            t("card.goodDelete"),
            t("card.goodEmails"),
          ],
        },
      ]}
    />
  );
}

export interface GiverReportProps {
  token: string;
  api?: GiftApi;
  /** Product lookup; loaded lazily from the catalog when omitted. */
  products?: Record<string, ProductInfo>;
  pollMs?: number;
  /** The report language known before the report loads (the /g page reads the request's giverLang). */
  locale?: Locale;
}

type View = { kind: "loading" } | { kind: "error"; message: string } | { kind: "gone"; expired: boolean } | { kind: "report"; report: GiverReportView };

export function GiverReport({ token, api: apiProp, products: productsProp, pollMs = REPORT_POLL_MS, locale: localeProp }: GiverReportProps) {
  const expired = useExpiredLines();
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

  const report = view.kind === "report" ? view.report : null;
  const locale: Locale = report?.lang ?? localeProp ?? "en";
  const t = reportTranslator(locale);
  const en = locale === "en";

  // The (gift) layout header ("for <store>", "Private") follows the report language too (giftLocale, A21).
  useEffect(() => setGiftLocale(locale), [locale]);
  // The whole document reads in the report language (screen readers, line breaking, font fallback).
  useEffect(() => {
    if (en) return;
    const root = document.documentElement;
    const before = root.lang;
    root.lang = locale;
    return () => {
      root.lang = before;
    };
  }, [en, locale]);

  // Announce the report when it completes (aria-live), once.
  useEffect(() => {
    if (view.kind !== "report" || view.report.state === lastState.current) return;
    const prev = lastState.current;
    lastState.current = view.report.state;
    if (view.report.state === "completed" && prev !== "") {
      const tr = reportTranslator(view.report.lang ?? localeProp ?? "en");
      const top = [...view.report.results].sort((a, b) => b.score - a.score)[0];
      setAnnounce(top ? tr("ui.readyTop", { title: products[top.skuId]?.title ?? tr("ui.topFallback"), score: Math.round(top.score) }) : tr("ui.ready"));
    }
  }, [view, products, localeProp]);

  const tryOn = report?.tryOn !== false;
  // The header names this request's store (a preview's own name, never "Aurum" for a preview).
  const headerStore = report ? storeNameFor({ storeName: report.storeName, preview: Boolean(report.storeName || report.products.length || report.previewExpired) }) : null;
  useEffect(() => {
    if (report) setGiftStoreName(headerStore);
  }, [report, headerStore]);
  // Store-URL preview requests: the frozen snapshot names the pieces (the Aurum catalog doesn't know them).
  const snapshotProducts = report?.products;
  const allProducts = useMemo<Record<string, ProductInfo>>(() => {
    if (!snapshotProducts?.length) return products;
    const fromSnapshot = Object.fromEntries(snapshotProducts.map((p) => [p.catalogId, { id: p.catalogId, slug: "", title: p.title, price: p.price ?? 0, currency: p.currency ?? "USD", url: p.url, ...(p.image ? { image: p.image } : {}) } satisfies ProductInfo]));
    return { ...products, ...fromSnapshot };
  }, [products, snapshotProducts]);
  const sorted = report ? [...report.results].sort((a, b) => b.score - a.score) : [];
  const heartedSet = new Set(report?.heartedIds ?? []);
  const isDemo = Boolean(report?.demo) || demoLink;
  const wishedSet = new Set(report?.otherMetalWishes ?? []);
  const expiry = report ? (en ? formatExpiry(report.expiresAt) : reportDateTime(locale, report.expiresAt, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })) : undefined;

  return (
    // Letter-spaced small caps suit Latin text only: Japanese, Chinese, Korean and Thai keep normal spacing.
    <div className={`mx-auto w-full max-w-3xl ${/^(ja|zh|ko|th)$/.test(locale) ? "[&_*]:tracking-normal!" : ""}`} data-testid="fit-report" lang={locale}>
      <p aria-live="polite" className="sr-only">
        {announce}
      </p>
      <p className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-[0.24em] text-gold-deep">
        {t("ui.kicker")}
        {isDemo ? (
          <span className="rounded-full bg-gold-deep px-2.5 py-1 normal-case tracking-normal text-white" data-testid="demo-request">
            {t("ui.demoBadge")}
          </span>
        ) : null}
      </p>
      {isDemo ? <p className="mt-2 text-sm text-ink-soft">{t("ui.demoNote")}</p> : null}
      <h1 className="mt-3 font-display text-4xl leading-tight text-ink sm:text-5xl">
        {report?.state === "completed" ? t("ui.title.completed") : report?.state === "expired" ? t("ui.title.expired") : t("ui.title.default")}
      </h1>
      <div className="mt-6">
        <PhotosSeenCounter locale={locale} />
      </div>

      {view.kind === "loading" ? (
        <div className="mt-8 space-y-4" aria-busy="true" aria-label={t("ui.loading")}>
          <div className="gf-shimmer h-40 rounded-2xl" />
          <div className="gf-shimmer h-40 rounded-2xl" />
        </div>
      ) : null}

      {view.kind === "error" ? (
        <div role="alert" className="mt-8 rounded-2xl border border-line bg-white p-6">
          <p className="text-ink">{en ? view.message : t("ui.error")}</p>
          <button type="button" onClick={() => void load()} className="mt-4 min-h-11 rounded-full border border-ink px-5 text-sm text-ink hover:bg-cream">
            {t("ui.retry")}
          </button>
        </div>
      ) : null}

      {view.kind === "gone" ? (
        <div className="mt-8 rounded-2xl border border-line bg-white p-6" data-testid="report-gone">
          <h2 className="font-display text-2xl text-ink">{view.expired ? t("ui.gone.expiredTitle") : t("ui.gone.missingTitle")}</h2>
          <p className="mt-2 text-sm leading-6 text-ink-soft">{view.expired ? t("ui.gone.expiredBody") : t("ui.gone.missingBody")}</p>
          <Link href="/" className="mt-4 inline-flex min-h-11 items-center rounded-full bg-ink px-5 text-sm font-medium text-ivory">
            {t("ui.backHome")}
          </Link>
        </div>
      ) : null}

      {report?.previewExpired ? (
        <div className="mt-8 rounded-2xl border border-gold/60 bg-cream p-6" data-testid="report-preview-expired" role="status">
          <h2 className="font-display text-2xl text-ink">{t("ui.preview.title")}</h2>
          <p className="mt-2 text-sm leading-6 text-ink-soft">
            {t("ui.preview.lead")} {report.results.length ? t("ui.preview.saved") : t("ui.preview.gone")}
          </p>
          {/* English pages add a second-language line (A17); a localized report is already in the giver's language. */}
          {en ? (
            <p className="mt-2 text-sm leading-6 text-ink-soft" lang={expired.lang}>
              {expired.lines.reportLead} {report.results.length ? expired.lines.reportSaved : expired.lines.reportGone}
            </p>
          ) : null}
        </div>
      ) : null}

      {report && (report.state === "waiting" || report.state === "in_progress") ? (
        <div className="mt-8 rounded-2xl border border-line bg-white p-6" data-testid="report-waiting" role="status">
          <div className="flex items-center gap-3">
            <span className="relative flex h-3 w-3 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-gold opacity-60" />
              <span className="relative inline-flex h-3 w-3 rounded-full bg-gold-deep" />
            </span>
            <h2 className="font-display text-2xl text-ink">{report.state === "in_progress" ? (tryOn ? t("ui.wait.tryingOn") : t("ui.wait.looking")) : t("ui.wait.waiting")}</h2>
          </div>
          <p className="mt-2 text-sm leading-6 text-ink-soft">{t("ui.wait.body")}</p>
          {expiry ? <p className="mt-2 text-xs text-muted">{t("ui.wait.until", { date: expiry })}</p> : null}
        </div>
      ) : null}

      {report?.state === "completed" ? (
        <>
          <dl className="mt-6 grid grid-cols-3 gap-2 text-center">
            <div className="flex min-w-0 flex-col justify-between rounded-xl border border-line bg-white p-3">
              <dt className="text-[0.65rem] uppercase tracking-[0.14em] text-muted hyphens-auto [overflow-wrap:break-word]">
                {report.mode === "help_me_choose" ? (tryOn && !sorted.some((r) => r.tryOn === false) ? t("ui.stats.piecesTried") : t("ui.stats.piecesShown")) : t("ui.stats.yourPicks")}
              </dt>
              <dd className="font-display text-3xl text-ink">{sorted.length}</dd>
            </div>
            <div className="flex min-w-0 flex-col justify-between rounded-xl border border-line bg-white p-3">
              <dt className="text-[0.65rem] uppercase tracking-[0.14em] text-muted hyphens-auto [overflow-wrap:break-word]">{t("ui.stats.hearted")}</dt>
              <dd className="font-display text-3xl text-ink" data-testid="hearted-count">
                {sorted.filter((r) => heartedSet.has(r.skuId)).length}
              </dd>
            </div>
            <div className="flex min-w-0 flex-col justify-between rounded-xl border border-line bg-white p-3">
              <dt className="text-[0.65rem] uppercase tracking-[0.14em] text-muted hyphens-auto [overflow-wrap:break-word]">{t("ui.stats.topScore")}</dt>
              <dd className="font-display text-3xl text-ink">{sorted[0] ? Math.round(sorted[0].score) : "–"}</dd>
            </div>
          </dl>
          {tryOn && (report.labels.undertone || report.labels.faceShape) ? (
            <ul className="mt-4 flex flex-wrap gap-2" aria-label={t("ui.estimatesUsed")}>
              {[report.labels.undertone, report.labels.faceShape].filter((l): l is string => Boolean(l)).map((l) => (
                <li key={l} className="rounded-full border border-line-strong bg-white px-3 py-1 text-xs text-ink-soft">
                  {localizeEstimateLabel(locale, l)}
                </li>
              ))}
            </ul>
          ) : null}
          {tryOn && sorted.some((r) => r.tryOn === false) ? (
            <p className="mt-4 rounded-xl border border-line bg-white px-4 py-3 text-sm leading-6 text-ink-soft" data-testid="mixed-tryon-note">
              {t("ui.mixedNote")}
            </p>
          ) : null}
          {report.tasteSummary ? <TasteSummaryCard summary={report.tasteSummary} locale={locale} /> : null}
          <ol className="mt-6 space-y-4">
            {sorted.map((r, i) => (
              <ReportItem key={r.skuId} result={r} product={allProducts[r.skuId]} hearted={heartedSet.has(r.skuId)} wished={wishedSet.has(r.skuId)} rank={i + 1} locale={locale} />
            ))}
          </ol>
          <NotTriedList picks={report.similarNotTried} products={allProducts} tryOn={tryOn} locale={locale} />
          {en ? (
            <Disclaimer className="mt-4" tryOn={tryOn} />
          ) : (
            <p role="note" className="mt-4 text-xs leading-5 text-stone-600 dark:text-stone-300" data-testid="disclaimer">
              {tryOn ? t("ui.disclaimer") : t("ui.disclaimerNoTryOn")}
            </p>
          )}
        </>
      ) : null}

      {en ? (
        <GiverTransparencyCard expiresAt={report?.expiresAt} mode={report?.mode} tryOn={tryOn} className="mt-10 border-line" />
      ) : (
        <LocalizedGiverCard t={t} locale={locale} expiresAt={report?.expiresAt} mode={report?.mode} tryOn={tryOn} className="mt-10 border-line" />
      )}
    </div>
  );
}

/**
 * /s/<key> : a store-URL preview (owner: A6, ADR-055) in GiftFit's own neutral template — the store's
 * name and products only. Snapshot mode (A15, user decision "Chụp lại trang thật"): a jewelry store whose
 * home page could be copied safely is shown as that inert, sanitized copy (/s/<key>/snapshot) in a
 * sandboxed iframe below the banner instead; `?view=template` still shows the template. When the copy
 * was refused, the template says why. Banner "not affiliated", noindex, no checkout, cart,
 * payment or login form. Images by URL (plain <img>, no Referer). The widget runs with
 * data-store="preview:<key>" and grounds the Concierge on this catalog. 404 when missing or expired;
 * queued/crawling refresh by themselves; refused/failed explain why.
 */
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import Script from "next/script";
import { BookmarkletLink } from "@/components/preview/BookmarkletLink";
import { expiresInHours, MerchantImage, PreviewBanner, PreviewHeader } from "@/components/preview/PreviewChrome";
import { SnapshotFrame } from "@/components/preview/SnapshotFrame";
import { formatMoney, translator, type MessageKey } from "@/lib/i18n";
import { snapshotBasePath } from "@/lib/preview/page-snapshot";
import { inSnapshotMode } from "@/lib/preview/page-snapshot-http";
import { defaultPreviewRepo, PREVIEW_KEY_RE } from "@/lib/preview/repo";
import { siteLocale } from "@/lib/site/locale";
import { siteOrigin } from "@/lib/site/snippet";
import { bookmarkletHref } from "@/lib/widget/bookmarklet";
import { previewStoreView } from "@/lib/widget/preview";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Store preview" };

type Params = Promise<{ key: string }>;

export default async function PreviewStorePage({ params, searchParams }: { params: Params; searchParams: Promise<{ view?: string }> }) {
  const { key } = await params;
  if (!PREVIEW_KEY_RE.test(key)) notFound();
  const rec = await defaultPreviewRepo().get(key);
  if (!rec) notFound();
  const sp = await searchParams;
  const locale = siteLocale((await headers()).get("accept-language"));
  const tr = translator(locale);

  if (inSnapshotMode(rec) && sp.view !== "template") {
    return (
      <>
        <SnapshotFrame src={snapshotBasePath(key)} title={tr("pstore.snapshotTitle", { domain: rec.domain })}>
          <PreviewBanner locale={locale} domain={rec.domain} />
        </SnapshotFrame>
        <Script src="/giftfit.js" data-store={`preview:${key}`} strategy="lazyOnload" />
      </>
    );
  }

  if (rec.state === "queued" || rec.state === "crawling") {
    return (
      <>
        <meta httpEquiv="refresh" content="4" />
        <PreviewBanner locale={locale} domain={rec.domain} />
        <main className="mx-auto max-w-2xl px-4 py-16 sm:px-6" data-testid="preview-building" aria-busy="true">
          <h1 className="font-display text-4xl text-ink">{tr("pstore.buildingTitle", { domain: rec.domain })}</h1>
          <p className="mt-3 text-sm leading-6 text-ink-soft">{tr("pstore.building")}</p>
        </main>
      </>
    );
  }
  if (rec.state !== "ready") {
    return (
      <>
        <PreviewBanner locale={locale} domain={rec.domain} />
        <main className="mx-auto max-w-2xl px-4 py-16 sm:px-6" data-testid={`preview-${rec.state}`}>
          <h1 className="font-display text-4xl text-ink">{tr(rec.state === "refused" ? "pstore.refusedTitle" : "pstore.failedTitle", { domain: rec.domain })}</h1>
          <p className="mt-3 text-sm leading-6 text-ink-soft" data-testid="preview-reason">
            {tr(`pstore.reason.${rec.reason ?? "internal"}` as MessageKey)}
          </p>
          <Link href="/" className="mt-6 inline-flex min-h-11 items-center gf-cta rounded-full bg-ink px-6 text-sm font-medium text-ivory">
            {tr("pstore.tryAgain")}
          </Link>
        </main>
      </>
    );
  }

  const view = previewStoreView(rec);
  const origin = await siteOrigin();
  const home = `/s/${key}`;
  return (
    <>
      <PreviewBanner locale={locale} domain={view.domain} />
      <PreviewHeader storeName={view.storeName} homeHref={home} locale={locale} expiresInHours={expiresInHours(view.expiresAt)} />
      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6" data-testid="preview-store" lang={locale}>
        <p className="text-sm text-ink-soft">
          {tr("pstore.products", { count: view.products.length })} · {tr("pstore.assistant")}
        </p>
        {rec.snapshot?.mode === "template" && rec.snapshot.reason && rec.snapshot.reason !== "disabled" ? (
          <p className="mt-2 text-xs text-muted" data-testid="preview-look-note">
            {tr("pstore.look.template", { domain: view.domain, why: tr(`pstore.look.reason.${rec.snapshot.reason}` as MessageKey) })}
          </p>
        ) : null}
        {inSnapshotMode(rec) ? (
          <p className="mt-2 text-xs">
            <Link href={home} className="underline underline-offset-4" data-testid="preview-to-snapshot">
              {tr("pstore.look.toSnapshot", { domain: view.domain })}
            </Link>
          </p>
        ) : null}
        <ul className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4" data-testid="preview-grid">
          {view.products.map((p) => (
            <li key={p.id}>
              <Link href={`${home}/p/${encodeURIComponent(p.id)}`} className="group block rounded-xl border border-line bg-white p-2 hover:border-ink" data-testid="preview-product">
                <MerchantImage src={p.images[0]} alt="" className="aspect-square w-full rounded-lg" />
                <p className="mt-2 line-clamp-2 text-sm text-ink">{p.title}</p>
                <p className="text-xs text-muted">{p.price !== null && p.currency ? formatMoney(locale, p.price, p.currency) : tr("pstore.noPrice", { domain: view.domain })}</p>
              </Link>
            </li>
          ))}
        </ul>
        <section className="mt-12 rounded-2xl border border-line bg-white p-6" aria-labelledby="bm" data-testid="bookmarklet-section">
          <h2 id="bm" className="font-display text-2xl text-ink">
            {tr("pstore.bmTitle")}
          </h2>
          <p className="mt-2 text-sm leading-6 text-ink-soft">{tr("pstore.bmHelp")}</p>
          <p className="mt-4">
            <BookmarkletLink href={bookmarkletHref(origin, key, `${origin}${home}`)} label={tr("pstore.bmLink", { domain: view.domain })} />
          </p>
          <p className="mt-3 text-xs text-muted">{tr("pstore.bmCsp")}</p>
        </section>
        <p className="mt-8 text-xs text-muted">{tr("pstore.noCheckout", { domain: view.domain })}</p>
      </main>
      <Script src="/giftfit.js" data-store={`preview:${key}`} strategy="lazyOnload" />
    </>
  );
}

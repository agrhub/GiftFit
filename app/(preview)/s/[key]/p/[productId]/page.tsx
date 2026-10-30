/**
 * /s/<key>/p/<productId> : one product of a store-URL preview (owner: A6, ADR-055). JSON-LD Product and
 * Open Graph tags so the widget's PDP context works (sku = the store's product id), the "not affiliated"
 * banner, "View on <domain>" (rel noopener noreferrer nofollow) and no buying here. In snapshot mode (A15)
 * the same JSON-LD/OG tags stay on this page for the widget, and the body is the sanitized copy of the
 * product's own page (/s/<key>/snapshot/p/<id>) in the sandboxed iframe; `?view=template` shows the card.
 */
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import Script from "next/script";
import { expiresInHours, MerchantImage, PreviewBanner, PreviewHeader } from "@/components/preview/PreviewChrome";
import { SnapshotFrame } from "@/components/preview/SnapshotFrame";
import { formatMoney, translator } from "@/lib/i18n";
import { snapshotProductPath } from "@/lib/preview/page-snapshot";
import { inSnapshotMode } from "@/lib/preview/page-snapshot-http";
import { defaultPreviewRepo, PREVIEW_KEY_RE } from "@/lib/preview/repo";
import { siteLocale } from "@/lib/site/locale";
import { previewStoreView } from "@/lib/widget/preview";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Store preview" };

type Params = Promise<{ key: string; productId: string }>;

/** JSON for a <script type="application/ld+json">: `<` escaped so no text can close the tag. */
const ldJson = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

export default async function PreviewProductPage({ params, searchParams }: { params: Params; searchParams: Promise<{ view?: string }> }) {
  const { key, productId } = await params;
  if (!PREVIEW_KEY_RE.test(key)) notFound();
  const rec = await defaultPreviewRepo().get(key);
  if (!rec || rec.state !== "ready") notFound();
  const view = previewStoreView(rec);
  const id = decodeURIComponent(productId);
  const p = view.products.find((x) => x.id === id);
  if (!p) notFound();
  const sp = await searchParams;
  const locale = siteLocale((await headers()).get("accept-language"));
  const tr = translator(locale);
  const home = `/s/${key}`;
  const ld = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: p.title,
    sku: p.id,
    ...(p.images.length ? { image: p.images } : {}),
    ...(p.summary ? { description: p.summary } : {}),
    ...(p.categoryText ? { category: p.categoryText } : {}),
    ...(p.price !== null && p.currency ? { offers: { "@type": "Offer", price: p.price.toFixed(2), priceCurrency: p.currency, url: p.url } } : {}),
  };
  const productMeta = (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: ldJson(ld) }} />
      <meta property="og:type" content="product" />
      <meta property="og:title" content={p.title} />
      {p.images[0] ? <meta property="og:image" content={p.images[0]} /> : null}
      {p.price !== null && p.currency ? <meta property="product:price:amount" content={p.price.toFixed(2)} /> : null}
      {p.currency ? <meta property="product:price:currency" content={p.currency} /> : null}
    </>
  );
  if (inSnapshotMode(rec) && sp.view !== "template") {
    return (
      <>
        {productMeta}
        <SnapshotFrame src={snapshotProductPath(key, p.id)} title={tr("pstore.snapshotTitle", { domain: view.domain })}>
          <PreviewBanner locale={locale} domain={view.domain} />
        </SnapshotFrame>
        <Script src="/giftfit.js" data-store={`preview:${key}`} strategy="lazyOnload" />
      </>
    );
  }
  return (
    <>
      {productMeta}
      <PreviewBanner locale={locale} domain={view.domain} />
      <PreviewHeader storeName={view.storeName} homeHref={home} locale={locale} expiresInHours={expiresInHours(view.expiresAt)} />
      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6" data-testid="preview-pdp" lang={locale}>
        <Link href={home} className="text-sm text-ink-soft underline underline-offset-4">
          ← {tr("pstore.back")}
        </Link>
        <div className="mt-6 grid gap-8 md:grid-cols-2">
          <div className="grid gap-2">
            <MerchantImage src={p.images[0]} alt={p.title} className="aspect-square w-full rounded-xl border border-line" />
            {p.images.length > 1 ? (
              <div className="grid grid-cols-3 gap-2">
                {p.images.slice(1).map((src) => (
                  <MerchantImage key={src} src={src} alt="" className="aspect-square w-full rounded-lg border border-line" />
                ))}
              </div>
            ) : null}
          </div>
          <div>
            <h1 className="font-display text-4xl leading-tight text-ink">{p.title}</h1>
            <p className="mt-3 text-xl text-ink">{p.price !== null && p.currency ? formatMoney(locale, p.price, p.currency) : tr("pstore.noPrice", { domain: view.domain })}</p>
            {p.summary ? <p className="mt-4 text-sm leading-6 text-ink-soft">{p.summary}</p> : null}
            {p.categoryText ? <p className="mt-2 text-xs text-muted">{p.categoryText}</p> : null}
            <a href={p.url} target="_blank" rel="noopener noreferrer nofollow" className="mt-6 inline-flex min-h-12 items-center gf-cta rounded-full bg-ink px-7 text-sm font-medium text-ivory hover:bg-ink-soft" data-testid="view-on">
              {tr("pstore.viewOn", { domain: view.domain })}
            </a>
            <p className="mt-4 text-xs text-muted">{tr("pstore.noCheckout", { domain: view.domain })}</p>
            <p className="mt-1 text-xs text-muted">{tr("pstore.assistant")}</p>
          </div>
        </div>
      </main>
      <Script src="/giftfit.js" data-store={`preview:${key}`} strategy="lazyOnload" />
    </>
  );
}

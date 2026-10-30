/**
 * Preview store chrome (owner: A6, ADR-055): the persistent "not affiliated" banner and the neutral
 * GiftFit header. Server component. The merchant's look is never copied: only its name and products.
 */
import Link from "next/link";
import { translator, type Locale } from "@/lib/i18n";

export function PreviewBanner({ locale, domain }: { locale: Locale; domain: string }) {
  const tr = translator(locale);
  return (
    <p role="note" className="sticky top-0 z-40 border-b border-line bg-cream px-4 py-2 text-center text-xs leading-5 text-ink" data-testid="preview-banner">
      {tr("pstore.banner", { domain })}
    </p>
  );
}

export function PreviewHeader({ storeName, homeHref, locale, expiresInHours }: { storeName: string; homeHref: string; locale: Locale; expiresInHours: number }) {
  const tr = translator(locale);
  return (
    <header className="border-b border-line bg-white">
      <div className="mx-auto flex max-w-5xl flex-wrap items-baseline justify-between gap-2 px-4 py-4 sm:px-6">
        <Link href={homeHref} className="font-display text-3xl text-ink" data-testid="preview-store-name">
          {storeName}
        </Link>
        <p className="text-xs text-muted" data-testid="preview-expires">
          {tr("pstore.expires", { hours: expiresInHours })}
        </p>
      </div>
    </header>
  );
}

/** Plain <img>: merchant images by URL, never proxied or cached, no Referer sent. */
export function MerchantImage({ src, alt, className = "" }: { src: string | undefined; alt: string; className?: string }) {
  if (!src) return <div aria-hidden="true" className={`bg-cream ${className}`} />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} loading="lazy" referrerPolicy="no-referrer" decoding="async" className={`bg-paper object-cover ${className}`} />;
}

export const expiresInHours = (expiresAt: Date, nowMs = Date.now()) => Math.max(1, Math.ceil((expiresAt.getTime() - nowMs) / 3_600_000));

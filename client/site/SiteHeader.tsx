import Link from "next/link";
import type { ReactNode } from "react";

/**
 * The one GiftFit header (redesign R0): the serif wordmark on the dark bar, an optional label after it
 * (the gift pages' "for <store>", the console's name) and, on the right, the site links or a page's own
 * item (the gift pages' "Private"). Rendered by the (site) layout, the gift pages, the retailer console and
 * the 404 page, always inside `.gf-dark`.
 */
export function SiteHeader({ label, right, lang, wide = false, wordmarkHref = "/" }: { label?: ReactNode; right?: ReactNode; lang?: string; wide?: boolean; wordmarkHref?: string | null }) {
  const wordmark = <span className="gf-wordmark text-2xl text-fog-100">GiftFit</span>;
  return (
    <header className="border-b border-night-700 bg-night-950/80 backdrop-blur" lang={lang}>
      <div className={`mx-auto flex min-h-14 items-center justify-between gap-3 px-4 py-2 sm:px-6 ${wide ? "max-w-7xl" : "max-w-5xl"}`}>
        <div className="flex min-w-0 items-baseline gap-2.5">
          {wordmarkHref ? (
            <Link href={wordmarkHref} className="shrink-0 hover:opacity-90">
              {wordmark}
            </Link>
          ) : (
            <p className="shrink-0">{wordmark}</p>
          )}
          {label}
        </div>
        {right ?? <SiteNav />}
      </div>
    </header>
  );
}

export function SiteNav() {
  return (
    <nav aria-label="Site" className="flex shrink-0 gap-5 text-sm text-fog-300">
      <Link href="/demo" className="inline-flex min-h-11 items-center hover:text-fog-100">
        Demo
      </Link>
      <Link href="/merchants" className="inline-flex min-h-11 items-center hover:text-fog-100">
        Merchants
      </Link>
    </nav>
  );
}

/** "Skip to content" for the pages that render SiteHeader. */
export function SkipLink({ href = "#main" }: { href?: string }) {
  return (
    <a href={href} className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-full focus:bg-fog-100 focus:px-4 focus:py-2 focus:text-night-950">
      Skip to content
    </a>
  );
}

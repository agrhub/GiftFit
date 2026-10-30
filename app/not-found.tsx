import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { SiteHeader, SkipLink } from "@/client/site/SiteHeader";

export const metadata: Metadata = { title: "Page not found", robots: { index: false, follow: false } };
export const viewport: Viewport = { themeColor: "#090b11" };

/** 404 for every GiftFit route, in the site's dark design (globals.css `.gf-dark`). */
export default function NotFound() {
  return (
    <div className="gf-dark gf-glow min-h-dvh">
      <SkipLink />
      <SiteHeader />
      <main id="main" tabIndex={-1} className="mx-auto max-w-2xl px-4 py-20 focus:outline-none sm:px-6" data-testid="not-found">
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-fog-400">404</p>
        <h1 className="mt-3 text-4xl font-bold tracking-tight sm:text-5xl">
          <span className="gf-gradient-text">This page isn&rsquo;t here</span>
        </h1>
        <p className="mt-4 max-w-prose leading-7 text-fog-300">The link may be mistyped, or a gift link may have expired: gift and preview links are deleted after a short time to keep them private.</p>
        <Link href="/" className="gf-cta mt-8 inline-flex min-h-12 items-center rounded-full bg-ink px-7 text-sm font-semibold text-ivory">
          GiftFit home
        </Link>
      </main>
    </div>
  );
}

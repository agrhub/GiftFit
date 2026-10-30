"use client";
import Link from "next/link";
import { SiteHeader } from "@/components/site/SiteHeader";

/** Unexpected errors on any GiftFit route, in the site's dark design. No error detail is shown. */
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="gf-dark gf-glow min-h-dvh">
      <SiteHeader />
      <main id="main" className="mx-auto max-w-2xl px-4 py-20 sm:px-6" data-testid="error-page">
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
          <span className="gf-gradient-text">Something went wrong</span>
        </h1>
        <p className="mt-4 max-w-prose leading-7 text-fog-300">Please try again. If it keeps happening, come back in a few minutes.</p>
        <div className="mt-8 flex flex-wrap gap-3">
          <button type="button" onClick={reset} className="gf-cta inline-flex min-h-12 items-center rounded-full bg-ink px-7 text-sm font-semibold text-ivory">
            Try again
          </button>
          <Link href="/" className="inline-flex min-h-12 items-center rounded-full border border-night-600 px-7 text-sm font-medium text-fog-100 hover:border-fog-300">
            GiftFit home
          </Link>
        </div>
      </main>
    </div>
  );
}

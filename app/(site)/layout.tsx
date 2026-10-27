import Link from "next/link";

/** GiftFit site pages on the main origin (owner: A6, P8.2b): home, merchants, judge demo, dev previews. */
export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded focus:bg-ink focus:px-4 focus:py-2 focus:text-ivory">
        Skip to content
      </a>
      <header className="border-b border-line bg-ivory">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Link href="/" className="font-display text-2xl tracking-[0.12em] text-ink">
            GiftFit
          </Link>
          <nav aria-label="Site" className="flex gap-4 text-sm text-ink-soft">
            <Link href="/demo" className="hover:text-ink">
              Demo
            </Link>
            <Link href="/merchants" className="hover:text-ink">
              Merchants
            </Link>
          </nav>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="focus:outline-none">
        {children}
      </main>
    </>
  );
}

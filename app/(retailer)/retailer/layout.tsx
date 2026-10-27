import type { Metadata } from "next";
import Link from "next/link";
import { demoStoreUrl } from "@/lib/site/config";

export const metadata: Metadata = {
  title: { default: "Retailer Console", template: "%s · Retailer Console" },
  robots: { index: false, follow: false },
};

export default function RetailerLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <a href="#console" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded focus:bg-ink focus:px-4 focus:py-2 focus:text-ivory">
        Skip to content
      </a>
      <header className="border-b border-line bg-ivory">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-4">
            <Link href="/" className="font-display text-2xl tracking-[0.12em] text-ink">
              GiftFit
            </Link>
            <span aria-hidden="true" className="h-8 w-px bg-line-strong" />
            <span className="text-sm text-ink-soft">
              Retailer Console <span className="text-muted">· GiftFit</span>
            </span>
          </div>
          <nav aria-label="Console">
            <ul className="flex flex-wrap gap-5 text-sm text-ink-soft">
              <li>
                <Link href="/" className="hover:text-ink">
                  GiftFit home
                </Link>
              </li>
              <li>
                <a href={`${demoStoreUrl()}/p/halo-drop-earrings`} className="hover:text-ink">
                  Demo store
                </a>
              </li>
            </ul>
          </nav>
        </div>
      </header>
      <main id="console" tabIndex={-1} className="focus:outline-none">
        {children}
      </main>
    </>
  );
}

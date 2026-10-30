import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { SiteHeader, SkipLink } from "@/components/site/SiteHeader";
import { demoStoreUrl } from "@/lib/site/config";

export const metadata: Metadata = {
  title: { default: "Retailer Console", template: "%s · Retailer Console" },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { themeColor: "#090b11" };

export default function RetailerLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="gf-dark gf-glow min-h-dvh">
      <SkipLink href="#console" />
      <SiteHeader
        wide
        label={<span className="hidden text-sm text-fog-300 sm:inline">Retailer Console</span>}
        right={
          <nav aria-label="Console">
            <ul className="flex flex-wrap gap-5 text-sm text-fog-300">
              <li>
                <Link href="/" className="inline-flex min-h-11 items-center hover:text-fog-100">
                  GiftFit home
                </Link>
              </li>
              <li>
                <a href={`${demoStoreUrl()}/p/halo-drop-earrings`} className="inline-flex min-h-11 items-center hover:text-fog-100">
                  Demo store
                </a>
              </li>
            </ul>
          </nav>
        }
      />
      <main id="console" tabIndex={-1} className="focus:outline-none">
        {children}
      </main>
    </div>
  );
}

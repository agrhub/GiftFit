import type { Viewport } from "next";
import { SiteHeader, SkipLink } from "@/components/site/SiteHeader";

export const viewport: Viewport = { themeColor: "#090b11" };

/** GiftFit site pages on the main origin (owner: A6, P8.2b): home, merchants, judge demo, dev previews. */
export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="gf-dark min-h-dvh">
      <SkipLink />
      <SiteHeader />
      <main id="main" tabIndex={-1} className="focus:outline-none">
        {children}
      </main>
    </div>
  );
}

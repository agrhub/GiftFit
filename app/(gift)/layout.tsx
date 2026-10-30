import type { Metadata, Viewport } from "next";

/** Token pages: never indexed, and the token never leaks through the Referer header. */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export const viewport: Viewport = { themeColor: "#090b11" };

/**
 * The header and the main landmark come from each page's GiftPageShell (A26): the header's words follow the
 * page's language, which only the page knows on the server. A new page under (gift) renders GiftPageShell.
 * Dark GiftFit design system (`.gf-dark`, globals.css) like every GiftFit page.
 */
export default function GiftLayout({ children }: { children: React.ReactNode }) {
  return <div className="gf-dark gf-glow min-h-dvh overflow-x-clip">{children}</div>;
}

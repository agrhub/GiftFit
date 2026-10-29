import type { Metadata } from "next";

/** Token pages: never indexed, and the token never leaks through the Referer header. */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * The header and the main landmark come from each page's GiftPageShell (A26): the header's words follow the
 * page's language, which only the page knows on the server. A new page under (gift) renders GiftPageShell.
 */
export default function GiftLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-dvh bg-ivory">{children}</div>;
}

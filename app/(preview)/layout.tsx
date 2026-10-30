import type { Metadata, Viewport } from "next";

/**
 * Store-URL previews and Admin v0 (owner: A6, ADR-055): never indexed (also X-Robots-Tag in
 * middleware.ts), and no Referer to anyone (merchant images, "View on" links, the owner token).
 * GiftFit's own chrome is dark like every GiftFit page (`.gf-dark`); a store snapshot keeps the store's look
 * (it is a separate document in an iframe).
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export const viewport: Viewport = { themeColor: "#090b11" };

export default function PreviewLayout({ children }: { children: React.ReactNode }) {
  return <div className="gf-dark min-h-dvh overflow-x-clip">{children}</div>;
}

import type { Metadata } from "next";

/**
 * Store-URL previews and Admin v0 (owner: A6, ADR-055): never indexed (also X-Robots-Tag in
 * middleware.ts), and no Referer to anyone (merchant images, "View on" links, the owner token).
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default function PreviewLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-dvh bg-ivory">{children}</div>;
}

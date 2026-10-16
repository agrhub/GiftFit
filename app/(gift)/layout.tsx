import type { Metadata } from "next";
import { GiftHeader } from "@/components/gift/GiftHeader";

/** Token pages: never indexed, and the token never leaks through the Referer header. */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function GiftLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-ivory">
      <GiftHeader />
      <main id="main" className="px-4 pb-10 pt-4 sm:px-6">
        {children}
      </main>
    </div>
  );
}

import type { Metadata } from "next";
import { ConciergeDemo } from "@/client/gift/concierge/ConciergeDemo";

export const metadata: Metadata = {
  title: "Gift concierge",
  description: "Describe a gift in your own words; the concierge suggests pieces from this store and drafts a gift brief.",
};

export default function ConciergeDemoPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <p className="text-xs font-semibold tracking-[0.24em] text-gold-deep uppercase">Preview</p>
      <h1 className="mt-3 font-display text-4xl leading-tight text-ink sm:text-5xl">Gift concierge</h1>
      <p className="mt-3 text-sm leading-6 text-ink-soft">
        Ask in any language. The concierge searches this store&apos;s catalog only, never sees anyone&apos;s photos, and drafts a brief you confirm yourself.
      </p>
      <div className="mt-8">
        <ConciergeDemo />
      </div>
    </div>
  );
}

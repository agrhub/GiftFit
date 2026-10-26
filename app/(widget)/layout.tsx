import type { Metadata } from "next";

/**
 * The embeddable widget's frame (owner: A6, ADR-046): no store chrome, transparent page (the launcher
 * floats over the store), never indexed, and no Referer to anyone (the giver's links live here).
 */
export const metadata: Metadata = {
  title: "GiftFit gift assistant",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function WidgetLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <style>{"html,body{background:transparent!important;min-height:0!important;overflow:hidden}"}</style>
      {children}
    </>
  );
}

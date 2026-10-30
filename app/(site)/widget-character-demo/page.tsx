import type { Metadata } from "next";
import { CharacterDemo } from "@/client/widget/character/CharacterDemo";

export const metadata: Metadata = {
  title: "Widget character preview",
  description: "Developer preview of the gift-assistant widget character: states, tip bubble and mouth.",
  robots: { index: false, follow: false },
};

export default function WidgetCharacterDemoPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
      <p className="text-xs font-semibold tracking-[0.24em] text-gold-deep uppercase">Developer preview</p>
      <h1 className="mt-3 font-display text-4xl leading-tight text-ink sm:text-5xl">Widget character</h1>
      <p className="mt-3 text-sm leading-6 text-ink-soft">The SVG mascot in every state, the tip bubble, and the Live2D character with its SVG fallback.</p>
      <div className="mt-8">
        <CharacterDemo />
      </div>
    </div>
  );
}

"use client";
/**
 * Standalone Concierge demo (owner: A7): the panel plus the brief it would hand to the Giver Panel.
 * Not mounted in the Giver Panel yet (R0 wires it after A3's "Help me choose" lands).
 */
import { useState } from "react";
import type { GiftBrief } from "@/lib/contracts/api";
import { ConciergePanel } from "./ConciergePanel";

export function ConciergeDemo() {
  const [brief, setBrief] = useState<GiftBrief | null>(null);
  return (
    <div className="flex flex-col gap-6">
      <ConciergePanel onBrief={setBrief} />
      <section aria-labelledby="concierge-demo-brief" className="rounded-2xl border border-line bg-cream/70 p-4 sm:p-6">
        <h2 id="concierge-demo-brief" className="font-display text-xl text-ink">
          Brief handed to the Giver Panel
        </h2>
        {brief ? (
          <pre data-testid="concierge-brief" className="mt-3 overflow-x-auto rounded-lg bg-white p-3 text-xs text-ink-soft">
            {JSON.stringify(brief, null, 2)}
          </pre>
        ) : (
          <p className="mt-2 text-sm text-ink-soft">Tap &ldquo;Use this brief&rdquo; on a draft to see what would pre-fill the Giver Panel. Nothing is sent from this page.</p>
        )}
      </section>
    </div>
  );
}

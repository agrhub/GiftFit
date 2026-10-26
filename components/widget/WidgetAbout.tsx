"use client";
/**
 * "About and privacy" view of the widget (owner: A6; ADR-046/050; voice section A4, P8.3).
 * Plain-language privacy notice, the voice notice with the Supertonic 3 (BigScience Open RAIL-M)
 * use restrictions and credits, and the character credits. `children` = the natural-voice control
 * when the device can run it.
 */
import type { ReactNode } from "react";
import { Live2DCredits } from "@/components/widget/character";
import { SUPERTONIC_LICENSE_URL } from "@/components/widget/voice/supertonic/manifest";
import type { MessageKey } from "@/lib/i18n";

export function WidgetAbout({ tr, onBack, children }: { tr: (key: MessageKey) => string; onBack(): void; children?: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto bg-ivory p-4" data-testid="widget-about">
      <h2 className="font-display text-2xl text-ink">{tr("about.title")}</h2>
      <p className="text-sm leading-6 text-ink">{tr("about.what")}</p>
      <p className="text-sm leading-6 text-ink-soft">{tr("about.privacy")}</p>
      <section aria-label={tr("about.voiceTitle")} className="rounded-2xl border border-line bg-white p-4" data-testid="widget-about-voice">
        <h3 className="mb-2 text-sm font-semibold text-ink">{tr("about.voiceTitle")}</h3>
        <p className="text-sm leading-6 text-ink-soft">{tr("about.voice")}</p>
        <p className="mt-2 text-xs leading-5 text-ink-soft">{tr("about.voiceTerms")}</p>
        <a href={SUPERTONIC_LICENSE_URL} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-xs text-ink underline underline-offset-2">
          {tr("about.voiceLicence")}
        </a>
        <p className="mt-2 text-xs leading-5 text-muted">{tr("about.voiceCredit")}</p>
      </section>
      {children}
      <section aria-label={tr("about.credits")} className="rounded-2xl border border-line bg-white p-4">
        <h3 className="mb-2 text-sm font-semibold text-ink">{tr("about.credits")}</h3>
        <Live2DCredits />
      </section>
      <button type="button" onClick={onBack} className="mt-auto min-h-11 rounded-full border border-line-strong px-6 text-sm text-ink-soft">
        {tr("about.back")}
      </button>
    </div>
  );
}

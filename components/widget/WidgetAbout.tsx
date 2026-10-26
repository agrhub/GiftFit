"use client";
/**
 * "About and privacy" view of the widget (owner: A6; ADR-046/050). Plain-language privacy notice and the
 * character credits.
 */
import { Live2DCredits } from "@/components/widget/character";
import type { MessageKey } from "@/lib/i18n";

export function WidgetAbout({ tr, onBack }: { tr: (key: MessageKey) => string; onBack(): void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto bg-ivory p-4" data-testid="widget-about">
      <h2 className="font-display text-2xl text-ink">{tr("about.title")}</h2>
      <p className="text-sm leading-6 text-ink">{tr("about.what")}</p>
      <p className="text-sm leading-6 text-ink-soft">{tr("about.privacy")}</p>
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

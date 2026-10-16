/** Small presentational pieces of the Retailer Console (owner: A6). Server-safe (no hooks). */
import type { ReactNode } from "react";
import type { Rate } from "@/lib/metrics/types";

export const pct = (v: number | null | undefined, digits = 0) => (v === null || v === undefined || !Number.isFinite(v) ? "–" : `${(v * 100).toFixed(digits)}%`);
export const ratePct = (r: Rate, digits = 0) => pct(r.value, digits);
export const usd = (n: number, digits = 0) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: digits, minimumFractionDigits: digits }).format(n);
export const int = (n: number) => new Intl.NumberFormat("en-US").format(n);

/** Bar fills per tone (decorative; every bar has its number in text next to it). */
export const TONE_FILL: Record<"warm" | "neutral" | "cool", string> = {
  warm: "bg-gold",
  neutral: "bg-line-strong",
  cool: "bg-[#5b7083]",
};

export function Card({ title, eyebrow, badge, children, className = "", id, testId }: { title: string; eyebrow?: string; badge?: ReactNode; children: ReactNode; className?: string; id?: string; testId?: string }) {
  return (
    <section aria-labelledby={id} data-testid={testId} className={`flex flex-col rounded-xl border border-line bg-white p-5 sm:p-6 ${className}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          {eyebrow ? <p className="text-[0.7rem] font-semibold uppercase tracking-[0.22em] text-gold-deep">{eyebrow}</p> : null}
          <h2 id={id} className="mt-1 font-display text-2xl leading-tight text-ink">
            {title}
          </h2>
        </div>
        {badge}
      </div>
      <div className="mt-4 flex flex-1 flex-col">{children}</div>
    </section>
  );
}

export function DataBadge({ synthetic, label }: { synthetic: boolean; label?: string }) {
  return synthetic ? (
    <span data-testid="synthetic-badge" className="inline-flex items-center gap-1.5 rounded-full border border-rose/40 bg-blush px-3 py-1 text-xs font-medium text-rose">
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-rose" />
      {label ?? "Synthetic demo data"}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-sage/40 bg-[#eef4f0] px-3 py-1 text-xs font-medium text-sage">
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-sage" />
      {label ?? "Real data"}
    </span>
  );
}

/** "How this is calculated": a native disclosure, keyboard and screen-reader friendly without JS. */
export function HowCalculated({ children }: { children: ReactNode }) {
  return (
    <details className="group mt-4 border-t border-line pt-3 text-sm text-ink-soft">
      <summary className="cursor-pointer list-none text-xs font-medium text-gold-deep hover:text-ink [&::-webkit-details-marker]:hidden">
        <span aria-hidden="true" className="mr-1 inline-block transition-transform group-open:rotate-90">
          ›
        </span>
        How this is calculated
      </summary>
      <div className="mt-2 space-y-2 leading-6">{children}</div>
    </details>
  );
}

export function Formula({ children }: { children: ReactNode }) {
  return <code className="block whitespace-pre-wrap rounded-lg bg-cream px-3 py-2 font-mono text-[0.78rem] leading-5 text-ink">{children}</code>;
}

export function Bar({ value, fill = "bg-ink", label }: { value: number; fill?: string; label: string }) {
  const w = Math.max(0, Math.min(1, value));
  return (
    <div role="img" aria-label={label} className="h-2.5 w-full overflow-hidden rounded-full bg-cream">
      <div className={`h-full rounded-full ${fill}`} style={{ width: `${(w * 100).toFixed(1)}%` }} />
    </div>
  );
}

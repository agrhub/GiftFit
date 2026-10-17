"use client";
/** Progress while the server analyses the selfie and renders try-ons (one request; stages are paced honestly). */
import { useEffect, useState } from "react";
import { CheckIcon } from "../icons";

const STAGES = [
  { at: 0, label: "Uploading your photo securely" },
  { at: 2, label: "Estimating your undertone" },
  { at: 5, label: "Reading your face shape" },
  { at: 8, label: "Trying on your pieces" },
  { at: 1e9, label: "Deleting your photos" },
];

export function ProcessingStep({
  startedAt,
  finished = false,
}: {
  startedAt: number;
  finished?: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, []);
  const elapsed = Math.max(0, (now - startedAt) / 1000);
  const current = finished
    ? STAGES.length
    : STAGES.filter((s) => elapsed >= s.at).length - 1;

  return (
    <div
      className="flex flex-1 flex-col items-center pt-6 text-center"
      data-testid="processing"
    >
      <div className="relative grid h-28 w-28 place-items-center">
        <span
          className="absolute inset-0 animate-spin rounded-full border-2 border-line border-t-gold-deep [animation-duration:1.6s]"
          aria-hidden="true"
        />
        <span className="font-display text-4xl text-ink" aria-hidden="true">
          {Math.floor(elapsed)}
          <span className="text-lg text-muted">s</span>
        </span>
      </div>
      <h1 className="mt-6 font-display text-3xl text-ink">
        Making your previews
      </h1>
      <p className="mt-2 text-sm text-ink-soft">
        Usually under 45 seconds. Keep this page open.
      </p>
      <ol className="mt-8 w-full max-w-xs space-y-3 text-left">
        {STAGES.map((s, i) => {
          const done = i < current;
          const active = i === current;
          return (
            <li
              key={s.label}
              className={`flex items-center gap-3 text-sm ${done ? "text-ink" : active ? "font-medium text-ink" : "text-muted"}`}
            >
              <span
                className={`grid h-6 w-6 shrink-0 place-items-center rounded-full border ${done ? "border-sage bg-sage text-white" : active ? "border-gold-deep" : "border-line-strong"}`}
              >
                {done ? (
                  <CheckIcon className="h-3.5 w-3.5" />
                ) : active ? (
                  <span className="h-2 w-2 animate-pulse rounded-full bg-gold-deep" />
                ) : null}
              </span>
              {s.label}
            </li>
          );
        })}
      </ol>
      <p aria-live="polite" className="sr-only">
        {STAGES[Math.min(current, STAGES.length - 1)].label}
      </p>
    </div>
  );
}

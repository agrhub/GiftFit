/** Shared disclaimer (MASTER_PLAN v2 §4.4). Server- and client-safe. */
export const DISCLAIMER_TEXT = "AI try-on preview. Undertone and face shape are estimates. Not a sizing guarantee.";

/** For a gift without a try-on (store previews, ADR-055): no photo, no estimates, nothing AI-rendered. */
export const NO_TRYON_DISCLAIMER_TEXT = "Scores come from their hearts, your budget and the occasion. Not a sizing guarantee.";

export function Disclaimer({ className = "", tryOn = true }: { className?: string; tryOn?: boolean }) {
  return (
    <p role="note" className={`text-xs leading-5 text-stone-600 dark:text-stone-300 ${className}`} data-testid="disclaimer">
      {tryOn ? DISCLAIMER_TEXT : NO_TRYON_DISCLAIMER_TEXT}
    </p>
  );
}

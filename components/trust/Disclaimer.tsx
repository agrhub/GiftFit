/** Shared disclaimer (MASTER_PLAN v2 §4.4). Server- and client-safe. */
export const DISCLAIMER_TEXT = "AI try-on preview. Undertone and face shape are estimates. Not a sizing guarantee.";

export function Disclaimer({ className = "" }: { className?: string }) {
  return (
    <p role="note" className={`text-xs leading-5 text-stone-600 dark:text-stone-300 ${className}`}>
      {DISCLAIMER_TEXT}
    </p>
  );
}

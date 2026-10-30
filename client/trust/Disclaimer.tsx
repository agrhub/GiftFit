/** Shared disclaimer (MASTER_PLAN v2 §4.4). Server- and client-safe. */
import type { Locale } from "@/server/i18n";
import { recipientEn, rt } from "@/server/i18n/recipient";

export const DISCLAIMER_TEXT: string = recipientEn["disclaimer.tryOn"];

/** For a gift without a try-on (store previews, ADR-055): no photo, no estimates, nothing AI-rendered. */
export const NO_TRYON_DISCLAIMER_TEXT = "Scores come from their hearts, your budget and the occasion. Not a sizing guarantee.";

/** `locale` localizes the try-on line (recipient page, server/i18n/recipient); the no-try-on line is the giver's and stays English. */
export function Disclaimer({ className = "", tryOn = true, locale = "en" }: { className?: string; tryOn?: boolean; locale?: Locale }) {
  return (
    <p role="note" className={`text-xs leading-5 text-stone-600 dark:text-stone-300 ${className}`} data-testid="disclaimer">
      {tryOn ? rt(locale, "disclaimer.tryOn") : NO_TRYON_DISCLAIMER_TEXT}
    </p>
  );
}

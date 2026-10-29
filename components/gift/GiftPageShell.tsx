import type { Locale } from "@/lib/i18n";
import { GiftHeader } from "./GiftHeader";

/**
 * The gift pages' frame (A26): the GiftFit header and the main landmark. Rendered by each (gift) page, not
 * by the (gift) layout, because only the page knows its language on the server (the recipient page from
 * Accept-Language and the giver's language, the Fit Report from the giver's language): the header is then
 * localized in the server HTML instead of flashing English until hydration.
 */
export function GiftPageShell({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  return (
    <>
      <GiftHeader locale={locale} />
      <main id="main" className="px-4 pb-10 pt-4 sm:px-6">
        {children}
      </main>
    </>
  );
}

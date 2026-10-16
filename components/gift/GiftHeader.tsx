import { UI_MOCK } from "./api";
import { ShieldIcon } from "./icons";

/** Header for the gift pages: GiftFit for Aurum, no store navigation (the recipient shouldn't browse prices). */
export function GiftHeader() {
  return (
    <header className="border-b border-line bg-ivory">
      {UI_MOCK ? <p className="bg-gold-deep px-4 py-1 text-center text-xs font-medium text-white">UI mock mode: placeholder data, no AI calls</p> : null}
      <div className="mx-auto flex h-14 max-w-3xl items-center justify-between px-4 sm:px-6">
        <p className="flex items-baseline gap-2">
          <span className="font-display text-2xl font-medium tracking-wide text-ink">GiftFit</span>
          <span className="text-[0.65rem] uppercase tracking-[0.24em] text-muted">for Aurum Jewelry</span>
        </p>
        <p className="flex items-center gap-1.5 text-xs font-medium text-sage">
          <ShieldIcon className="h-4 w-4" /> Private
        </p>
      </div>
    </header>
  );
}

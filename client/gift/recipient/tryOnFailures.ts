/**
 * Per-item try-on failures shown to the recipient (owner: A4). `failureReason` is the engine's
 * free-string code or message (server/privacy passes it through). Real runs (ADR-026, ADR-031):
 *   - earring: engine code "2", "earlobe alignment not confident." (hair covered the ears);
 *   - bracelet: engine code "4", "Wrist position should be in the center." (photo cut off at the wrist).
 */
import type { CarouselItem } from "@/server/contracts/api";
import type { Locale } from "@/server/i18n";
import { rt } from "@/server/i18n/recipient";

export type RetakeKind = "ears" | "wrist";

const codeIs = (reason: string, code: string) => {
  const r = reason.trim();
  return r === code || new RegExp(`^${code}\b`).test(r);
};

export function isEarlobeFailure(reason: string | undefined): boolean {
  if (!reason) return false;
  return codeIs(reason, "2") || /earlobe|ear[\s_-]*lobe|\bears?\b.*(align|detect|visible|found|occlu)/i.test(reason);
}

export function isWristFailure(reason: string | undefined): boolean {
  if (!reason) return false;
  return codeIs(reason, "4") || /wrist/i.test(reason);
}

export interface FailureCopy {
  text: string;
  /** A new photo can fix it (hearts are kept). */
  retake: RetakeKind | null;
}

/** The copy in the recipient page locale (server/i18n/recipient; English by default). */
export function failureCopy(item: Pick<CarouselItem, "category">, reason: string | undefined, locale: Locale = "en"): FailureCopy {
  if (item.category === "earring" && isEarlobeFailure(reason)) {
    return { text: rt(locale, "card.failEars"), retake: "ears" };
  }
  if ((item.category === "bracelet" || item.category === "watch" || item.category === "ring") && isWristFailure(reason)) {
    return { text: rt(locale, "card.failWrist"), retake: "wrist" };
  }
  return { text: rt(locale, "card.unavailable"), retake: null };
}

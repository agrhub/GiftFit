/**
 * Per-item try-on failures shown to the recipient (owner: A4). `failureReason` is the engine's
 * free-string code or message (lib/privacy passes it through). Real runs (ADR-026, ADR-031):
 *   - earring: engine code "2", "earlobe alignment not confident." (hair covered the ears);
 *   - bracelet: engine code "4", "Wrist position should be in the center." (photo cut off at the wrist).
 */
import type { CarouselItem } from "@/lib/contracts/api";

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

export function failureCopy(item: Pick<CarouselItem, "category">, reason: string | undefined): FailureCopy {
  if (item.category === "earring" && isEarlobeFailure(reason)) {
    return { text: "We couldn't see your ears, so this earring preview was skipped. Retake?", retake: "ears" };
  }
  if ((item.category === "bracelet" || item.category === "watch" || item.category === "ring") && isWristFailure(reason)) {
    return { text: "We couldn't see your whole wrist, so this preview was skipped. Retake?", retake: "wrist" };
  }
  return { text: "Preview unavailable for this piece. You can still heart it.", retake: null };
}

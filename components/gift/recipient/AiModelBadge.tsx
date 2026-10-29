"use client";
import { recipientEn } from "@/lib/i18n/recipient";
import { useRt } from "./i18n";

/** "AI-generated model · demo" (ADR-038): shown wherever a seeded judge demo shows a person (in the page locale). */
export const AI_MODEL_LABEL: string = recipientEn["aiModel.badge"];

export function AiModelBadge({ className = "" }: { className?: string }) {
  const t = useRt();
  return (
    <span data-testid="ai-model-badge" className={`inline-flex shrink-0 items-center rounded-full bg-gold-deep px-2.5 py-1 text-[0.7rem] font-semibold tracking-wide text-white ${className}`}>
      {t("aiModel.badge")}
    </span>
  );
}

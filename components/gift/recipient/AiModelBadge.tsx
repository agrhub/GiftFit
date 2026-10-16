/** "AI-generated model · demo" (ADR-038): shown wherever a seeded judge demo shows a person. */
export const AI_MODEL_LABEL = "AI-generated model · demo";

export function AiModelBadge({ className = "" }: { className?: string }) {
  return (
    <span data-testid="ai-model-badge" className={`inline-flex shrink-0 items-center rounded-full bg-gold-deep px-2.5 py-1 text-[0.7rem] font-semibold tracking-wide text-white ${className}`}>
      {AI_MODEL_LABEL}
    </span>
  );
}

"use client";
/**
 * The character slot with its mouth driven by the voice player's AnalyserNode while audio plays
 * (owner: A4, P8.3). Kept as its own component so the per-frame mouth updates re-render only the
 * character, not the whole panel.
 */
import { useMouthFromAudio } from "@/components/widget/character";
import { CharacterSlot, type CharacterProps } from "../CharacterSlot";

export function SpeakingCharacter({ analyser, mouth, ...props }: CharacterProps & { compact?: boolean; dismissLabel?: string; analyser: AnalyserNode | null }) {
  const level = useMouthFromAudio(analyser);
  return <CharacterSlot {...props} mouth={analyser ? level : mouth} />;
}

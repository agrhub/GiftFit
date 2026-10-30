/** Character-slot interface for the widget (owner: A4, ADR-049/050). Stable across SVG and Live2D. */
export type CharacterState = "idle" | "listening" | "thinking" | "talking";

export interface CharacterProps {
  state: CharacterState;
  /** 0..1 amplitude; when talking and absent, a gentle typing rhythm. */
  mouth?: number;
  /** Speech-bubble text, already localised; empty/undefined = none. */
  tip?: string;
  /** Click / Enter / Space on the launcher. */
  onActivate(): void;
  reducedMotion: boolean;
  /** Accessible name of the launcher button (localise it). */
  label?: string;
  /** Accessible name of the tip's close button (localise it). */
  dismissLabel?: string;
  onDismissTip?(): void;
}

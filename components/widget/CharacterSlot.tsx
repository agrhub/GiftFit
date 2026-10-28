"use client";
/**
 * The widget's character slot (owner: A6). This is the PLACEHOLDER: a static SVG gift-box mascot with
 * a CSS idle bob (off under prefers-reduced-motion). A4's real character lives in
 * components/widget/character/ and implements exactly `CharacterProps`; swapping it in is a one-line
 * change in `CharacterSlot` below. The slot is a button: activating it opens the widget panel.
 */
import type { CSSProperties } from "react";
import { Character, Mascot } from "@/components/widget/character";

export type CharacterState = "idle" | "listening" | "thinking" | "talking";

export interface CharacterProps {
  state: CharacterState;
  /** Mouth openness while talking, 0..1 (text-driven amplitude today, audio later). */
  mouth?: number;
  /** Speech-bubble text next to the character (empty/undefined = no bubble). */
  tip?: string;
  /** Click / Enter / Space on the character. */
  onActivate(): void;
  /** prefers-reduced-motion (or a store setting): no bobbing, no blinking. */
  reducedMotion: boolean;
  /** Accessible name of the character button (e.g. "Open the gift assistant"). */
  label?: string;
}

const KEYFRAMES = `
@keyframes gf-bob { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-4px) } }
@keyframes gf-think { 0%,100% { opacity: .35 } 50% { opacity: 1 } }
`;

/** Static gift-box mascot: box, bow, two eyes and a mouth whose height follows `mouth`. */
export function PlaceholderCharacter({ state, mouth = 0, tip, onActivate, reducedMotion, label = "Gift assistant" }: CharacterProps) {
  const open = state === "talking" ? Math.max(0.08, Math.min(1, mouth)) : state === "listening" ? 0.15 : 0.05;
  const bob: CSSProperties = reducedMotion ? {} : { animation: `gf-bob ${state === "thinking" ? 1.2 : 2.6}s ease-in-out infinite` };
  return (
    <div className="flex items-end gap-2" data-testid="widget-character" data-state={state}>
      <style>{KEYFRAMES}</style>
      {tip ? (
        <p role="status" className="mb-6 max-w-[220px] rounded-2xl rounded-br-sm border border-line bg-white px-3 py-2 text-sm leading-snug text-ink shadow-lg" data-testid="widget-tip">
          {tip}
        </p>
      ) : null}
      <button type="button" onClick={onActivate} aria-label={label} className="relative shrink-0 rounded-full p-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">
        <svg width="72" height="72" viewBox="0 0 72 72" aria-hidden="true" style={bob}>
          <circle cx="36" cy="36" r="35" fill="#fbf8f3" stroke="#1f1a17" strokeWidth="1.5" />
          {/* bow */}
          <path d="M36 21c-4-7-12-8-12-3 0 3 4 4 12 3Zm0 0c4-7 12-8 12-3 0 3-4 4-12 3Z" fill="#b4234d" />
          {/* box */}
          <rect x="18" y="22" width="36" height="9" rx="2" fill="#b4234d" />
          <rect x="21" y="31" width="30" height="22" rx="3" fill="#e9cf8a" />
          <rect x="33.5" y="22" width="5" height="31" fill="#fbf8f3" opacity=".9" />
          {/* face */}
          <circle cx="28" cy="40" r="2" fill="#1f1a17" />
          <circle cx="44" cy="40" r="2" fill="#1f1a17" />
          <ellipse cx="36" cy="47" rx="3.5" ry={0.5 + open * 3.5} fill="#1f1a17" />
          {state === "thinking" && !reducedMotion ? (
            <g fill="#1f1a17">
              <circle cx="52" cy="16" r="2" style={{ animation: "gf-think 1s infinite" }} />
              <circle cx="58" cy="12" r="1.5" style={{ animation: "gf-think 1s .3s infinite" }} />
            </g>
          ) : null}
        </svg>
      </button>
    </div>
  );
}

/**
 * The slot the widget renders (ADR-050): the launcher gets A4's Character (Live2D Mark-kun, with the
 * SVG gift-box mascot as fallback); `compact` always uses the SVG mascot, so only one WebGL context
 * and one Live2D model are ever loaded. The panel header shows a still of Mark-kun instead
 * (character/MarkAvatar.tsx) and falls back to this compact mascot.
 */
export function CharacterSlot({ compact = false, forceMascot = false, ...props }: CharacterProps & { compact?: boolean; dismissLabel?: string; forceMascot?: boolean }) {
  // forceMascot: a preview owner chose the SVG mascot in Admin v0 (ADR-055).
  return compact || forceMascot ? <Mascot {...props} /> : <Character {...props} />;
}

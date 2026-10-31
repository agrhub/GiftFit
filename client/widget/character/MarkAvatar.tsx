"use client";

import { useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { hasWebGL2, live2dFailed, pickCharacter } from "./live2d/load";
import type { CharacterState } from "./types";
import { useMouthFromAudio } from "./useMouthFromAudio";

/**
 * Panel-header avatar (owner: A20, ADR-050): a still of Mark-kun, so the open panel shows the same
 * character as the launcher without a second WebGL context or model load. The image is a frame of the
 * unmodified Live2D model rendered by our widget and cropped to his face (see docs/LICENSES.md).
 * `fallback` (the SVG mascot) is shown instead whenever the launcher would not show Mark-kun: the
 * store chose the mascot, motion is reduced, WebGL 2 is missing, Live2D failed in this frame, or the
 * image itself does not load.
 *
 * The still follows the voice: a soft ring pulses while he listens, and a mouth opens over his smile
 * while he talks, driven by the reply's audio (or a steady rhythm when the audio can't be analysed).
 */
export const MARK_AVATAR_SRC = "/widget/mark-kun-avatar.webp";

const noSubscribe = () => () => {};

const KEYFRAMES = `
@keyframes gf-avatar-listen { 0%,100% { box-shadow: 0 0 0 0 rgb(180 35 77 / .5) } 50% { box-shadow: 0 0 0 5px rgb(180 35 77 / 0) } }
@keyframes gf-avatar-talk { 0%,100% { transform: translate(-50%,-50%) scaleY(.3) } 50% { transform: translate(-50%,-50%) scaleY(1) } }
`;

export function MarkAvatar({
  mascot = false,
  reducedMotion,
  label,
  onActivate,
  fallback,
  state = "idle",
  mouth,
  analyser = null,
}: {
  mascot?: boolean;
  reducedMotion: boolean;
  label?: string;
  onActivate(): void;
  fallback: ReactNode;
  state?: CharacterState;
  /** Mouth openness 0..1 while talking (text-driven); left out, the mouth keeps a steady rhythm. */
  mouth?: number;
  /** The reply's audio while it plays: drives the mouth when present. */
  analyser?: AnalyserNode | null;
}) {
  const webgl = useSyncExternalStore(noSubscribe, hasWebGL2, () => false);
  const [broken, setBroken] = useState(false);
  if (mascot || broken || live2dFailed() || pickCharacter({ reducedMotion, webgl }) === "svg") return <>{fallback}</>;
  return (
    <button
      type="button"
      onClick={onActivate}
      aria-label={label}
      className="grid h-14 w-14 place-items-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
      data-testid="widget-avatar-mark"
      data-state={state}
    >
      <style>{KEYFRAMES}</style>
      <span className="relative block h-12 w-12 rounded-full" style={state === "listening" ? { animation: "gf-avatar-listen 1.4s ease-out infinite" } : undefined}>
        {/* eslint-disable-next-line @next/next/no-img-element -- 5 KB static still; next/image adds nothing here */}
        <img src={MARK_AVATAR_SRC} alt="" width={48} height={48} decoding="async" draggable={false} onError={() => setBroken(true)} className="h-12 w-12 rounded-full border border-line-strong bg-ivory object-cover" />
        {state === "talking" ? <AvatarMouth analyser={analyser} mouth={mouth} /> : null}
      </span>
    </button>
  );
}

/** The open mouth over the still's smile. Its own component, so per-frame audio levels re-render only it. */
function AvatarMouth({ analyser, mouth }: { analyser: AnalyserNode | null; mouth?: number }) {
  const level = useMouthFromAudio(analyser);
  const open = analyser ? level : mouth;
  const style: CSSProperties =
    open === undefined
      ? { animation: "gf-avatar-talk 260ms ease-in-out infinite" }
      : { transform: `translate(-50%,-50%) scaleY(${Math.max(0.15, Math.min(1, open))})` };
  // The smile sits at about 68% of the face crop's height.
  return <span aria-hidden="true" className="absolute left-1/2 top-[68%] h-1.5 w-2.5 rounded-full bg-[#6b1f2a]" style={style} data-testid="widget-avatar-mouth" />;
}

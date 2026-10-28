"use client";

import { useState, useSyncExternalStore, type ReactNode } from "react";
import { hasWebGL2, live2dFailed, pickCharacter } from "./live2d/load";

/**
 * Panel-header avatar (owner: A20, ADR-050): a still of Mark-kun, so the open panel shows the same
 * character as the launcher without a second WebGL context or model load. The image is a frame of the
 * unmodified Live2D model rendered by our widget and cropped to his face (see data/LICENSES.md).
 * `fallback` (the SVG mascot) is shown instead whenever the launcher would not show Mark-kun: the
 * store chose the mascot, motion is reduced, WebGL 2 is missing, Live2D failed in this frame, or the
 * image itself does not load.
 */
export const MARK_AVATAR_SRC = "/widget/mark-kun-avatar.webp";

const noSubscribe = () => () => {};

export function MarkAvatar({ mascot = false, reducedMotion, label, onActivate, fallback }: { mascot?: boolean; reducedMotion: boolean; label?: string; onActivate(): void; fallback: ReactNode }) {
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
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- 5 KB static still; next/image adds nothing here */}
      <img src={MARK_AVATAR_SRC} alt="" width={48} height={48} decoding="async" draggable={false} onError={() => setBroken(true)} className="h-12 w-12 rounded-full border border-line-strong bg-ivory object-cover" />
    </button>
  );
}

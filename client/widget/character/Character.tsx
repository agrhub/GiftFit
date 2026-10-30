"use client";

import { useState, useSyncExternalStore } from "react";
import { Live2DCharacter } from "./Live2DCharacter";
import { Mascot } from "./Mascot";
import type { CharacterProps } from "./types";
import { hasWebGL2, noteFallback, pickCharacter, type FallbackReason } from "./live2d/load";

export type { CharacterProps, CharacterState } from "./types";

const noSubscribe = () => () => {};

/**
 * The widget's character slot (owner: A4, ADR-050): Live2D (Mark-kun) when WebGL 2 is available and
 * motion is allowed, otherwise, or when Core/the model fail or take over ~4 s, the SVG Mascot.
 * Nothing Live2D is fetched until this mounts (Core, Framework and model are lazy).
 */
export function Character(props: CharacterProps & { onFallback?(reason: FallbackReason): void }) {
  const webgl = useSyncExternalStore(noSubscribe, hasWebGL2, () => false);
  const [failed, setFailed] = useState<FallbackReason | null>(null);
  const { onFallback, ...rest } = props;
  if (failed || pickCharacter({ reducedMotion: props.reducedMotion, webgl }) === "svg") return <Mascot {...rest} />;
  return (
    <Live2DCharacter
      {...rest}
      onFallback={(reason) => {
        noteFallback(reason);
        setFailed(reason);
        onFallback?.(reason);
      }}
    />
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { MascotArt } from "./Mascot";
import { createMouthFollower, mouthTarget } from "./mouth";
import { CharacterShell, useDocumentHidden, useTip } from "./Shell";
import type { CharacterProps } from "./types";
import { Live2DLoadError, loadLive2D, type FallbackReason, type Live2DFrame } from "./live2d/load";

/**
 * Live2D character (owner: A4, ADR-050): Mark-kun, the one fixed model, in the shared launcher. The
 * SVG mascot art shows until the model is drawing; any load failure calls onFallback (Character
 * then swaps to the SVG Mascot). There is deliberately no prop for a model URL.
 */
const CSS_W = 112;
const CSS_H = 144;

export function Live2DCharacter(props: CharacterProps & { onFallback(reason: FallbackReason): void }) {
  const { state, mouth, reducedMotion, onFallback } = props;
  const hidden = useDocumentHidden();
  const tip = useTip(props.tip, reducedMotion, props.onDismissTip);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);

  const live = useRef({ state, mouth, rhythm: true });
  useEffect(() => {
    live.current = { state, mouth, rhythm: !tip.show || tip.typing };
  });
  const fallback = useRef(onFallback);
  useEffect(() => {
    fallback.current = onFallback;
  });

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    el.width = Math.round(CSS_W * dpr);
    el.height = Math.round(CSS_H * dpr);
    const follow = createMouthFollower();
    const frame = (): Live2DFrame => {
      const now = performance.now();
      const l = live.current;
      return { state: l.state, mouth: follow(now, mouthTarget(now, { talking: l.state === "talking", mouth: l.mouth, rhythm: l.rhythm })) };
    };
    const ac = new AbortController();
    let handle: { dispose(): void } | undefined;
    loadLive2D(el, frame, ac.signal).then(
      (h) => {
        if (ac.signal.aborted) return h.dispose();
        handle = h;
        setReady(true);
      },
      (err: unknown) => {
        if (ac.signal.aborted) return;
        if (process.env.NODE_ENV !== "production") console.warn("[live2d] falling back to the SVG mascot:", err);
        fallback.current(err instanceof Live2DLoadError ? err.reason : "error");
      },
    );
    return () => {
      ac.abort();
      handle?.dispose();
    };
  }, []);

  return (
    <CharacterShell {...props} tip={tip} hidden={hidden} launcherClassName="h-36 w-28 rounded-[28px]">
      {!ready && <MascotArt state={state} mouth={mouth} reducedMotion={reducedMotion} animate={!hidden} rhythm={!tip.show || tip.typing} />}
      <canvas
        ref={canvas}
        aria-hidden="true"
        data-testid="live2d-canvas"
        style={{ width: CSS_W, height: CSS_H }}
        className={ready ? "block rounded-[27px]" : "pointer-events-none absolute inset-0 opacity-0"}
      />
    </CharacterShell>
  );
}

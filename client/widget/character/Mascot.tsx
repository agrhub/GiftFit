"use client";

import { useEffect, useRef } from "react";
import { createMouthFollower, mouthTarget } from "./mouth";
import { CharacterShell, useDocumentHidden, useTip } from "./Shell";
import type { CharacterProps, CharacterState } from "./types";

export type { CharacterProps, CharacterState } from "./types";

/**
 * GiftFit widget mascot (owner: A4; the fallback character under ADR-050): an original inline-SVG
 * gift box whose lid and bow "ears" lift when listening, eyes blink and look up while thinking, and
 * mouth follows `mouth` (or a soft rhythm while the tip types out). Drawn for this project, MIT.
 */
const STILL_MOUTH = 0.4;

function setMouthShape(el: SVGEllipseElement, m: number) {
  el.setAttribute("rx", (2.6 + 1.1 * m).toFixed(2));
  el.setAttribute("ry", (0.7 + 3.6 * m).toFixed(2));
}

export function Mascot(props: CharacterProps) {
  const { state, mouth, reducedMotion } = props;
  const hidden = useDocumentHidden();
  const tip = useTip(props.tip, reducedMotion, props.onDismissTip);
  return (
    <CharacterShell {...props} tip={tip} hidden={hidden} launcherClassName="h-16 w-16 rounded-full">
      <MascotArt state={state} mouth={mouth} reducedMotion={reducedMotion} animate={!hidden} rhythm={!tip.show || tip.typing} />
    </CharacterShell>
  );
}

interface ArtProps {
  state: CharacterState;
  mouth?: number;
  reducedMotion: boolean;
  /** False while the document is hidden: the mouth loop stops. */
  animate: boolean;
  /** Talking without `mouth`: move to the typing rhythm (tip still typing, or no tip). */
  rhythm: boolean;
}

/** The SVG art alone (also the Live2D character's placeholder while it loads). */
export function MascotArt({ state, mouth, reducedMotion, animate, rhythm }: ArtProps) {
  const talking = state === "talking";
  const animMouth = talking && !reducedMotion && animate;
  const mouthEl = useRef<SVGEllipseElement>(null);
  const live = useRef({ mouth, rhythm });
  useEffect(() => {
    live.current = { mouth, rhythm };
  });

  useEffect(() => {
    const el = mouthEl.current;
    if (!animMouth || !el) return;
    const follow = createMouthFollower();
    let raf = 0;
    const tick = (now: number) => {
      setMouthShape(el, follow(now, mouthTarget(now, { talking: true, ...live.current })));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [animMouth]);

  const still = reducedMotion ? STILL_MOUTH : 0;
  return (
    <>
      <style href="gf-mascot" precedence="low">
        {CSS}
      </style>
      <svg viewBox="0 0 64 64" width="52" height="52" aria-hidden="true" focusable="false" className="gfm-svg overflow-visible" data-testid="mascot-art">
        <circle className="gfm-pulse" cx="32" cy="34" r="30" />
        <ellipse className="gfm-shadow" cx="32" cy="58" rx="15" ry="2.4" />
        <g className="gfm-body">
          <rect className="gfm-box" x="14" y="28" width="36" height="26" rx="5" />
          <rect className="gfm-band" x="14" y="47" width="36" height="3.5" />
          <g className="gfm-eyes">
            <g className="gfm-eye">
              <ellipse cx="25" cy="37" rx="2.2" ry="2.7" />
              <circle cx="25.8" cy="36" r="0.7" />
            </g>
            <g className="gfm-eye">
              <ellipse cx="39" cy="37" rx="2.2" ry="2.7" />
              <circle cx="39.8" cy="36" r="0.7" />
            </g>
          </g>
          <circle className="gfm-cheek" cx="20.5" cy="42" r="2.2" />
          <circle className="gfm-cheek" cx="43.5" cy="42" r="2.2" />
          {talking ? (
            <ellipse ref={mouthEl} className="gfm-mouth" cx="32" cy="43" rx={(2.6 + 1.1 * still).toFixed(2)} ry={(0.7 + 3.6 * still).toFixed(2)} />
          ) : (
            <path className="gfm-smile" d="M28.5 42Q32 45 35.5 42" />
          )}
          <g className="gfm-lid">
            <g className="gfm-bow-l">
              <path d="M32 18C24 9 17 14 22 19C25 21 29 20 32 18Z" />
            </g>
            <g className="gfm-bow-r">
              <path d="M32 18C40 9 47 14 42 19C39 21 35 20 32 18Z" />
            </g>
            <rect className="gfm-lidbox" x="11" y="19.5" width="42" height="9" rx="3" />
            <rect className="gfm-band" x="29" y="19.5" width="6" height="9" />
            <circle className="gfm-knot" cx="32" cy="18.5" r="2.6" />
          </g>
        </g>
        {state === "thinking" && (
          <g className="gfm-dots">
            <circle cx="49" cy="13" r="1.5" />
            <circle cx="54" cy="9" r="1.9" />
            <circle cx="59.5" cy="4.5" r="2.3" />
          </g>
        )}
      </svg>
    </>
  );
}

// Theme tokens from app/globals.css with fallbacks, so the mascot also renders outside the app theme.
const C = (name: string, hex: string) => `var(--color-${name},${hex})`;
const CSS = `
.gfm-svg *{transform-box:fill-box;transform-origin:center}
.gfm-pulse{fill:none;stroke:${C("gold", "#b08d4c")};stroke-width:1.2;opacity:0}
.gfm-shadow{fill:${C("ink", "#1f1a17")};opacity:.1}
.gfm-box{fill:${C("cream", "#f4eee4")};stroke:${C("line-strong", "#c9bdab")}}
.gfm-lidbox{fill:${C("ivory", "#fbf8f3")};stroke:${C("line-strong", "#c9bdab")}}
.gfm-band{fill:${C("gold", "#b08d4c")}}
.gfm-bow-l path,.gfm-bow-r path{fill:${C("gold", "#b08d4c")};stroke:${C("gold-deep", "#75581f")};stroke-width:.8}
.gfm-knot,.gfm-dots circle{fill:${C("gold-deep", "#75581f")}}
.gfm-eye ellipse,.gfm-mouth{fill:${C("ink", "#1f1a17")}}
.gfm-eye circle{fill:#fff}
.gfm-smile{fill:none;stroke:${C("ink", "#1f1a17")};stroke-width:1.6;stroke-linecap:round}
.gfm-cheek{fill:${C("rose", "#9b3d50")};opacity:.18}
.gfm-lid{transform-origin:20% 100%}
.gfm-bow-l{transform-origin:100% 100%}
.gfm-bow-r{transform-origin:0 100%}
.gfm-listening .gfm-lid{transform:translateY(-4px) rotate(-6deg)}
.gfm-listening .gfm-bow-l{transform:rotate(-14deg) scale(1.1)}
.gfm-listening .gfm-bow-r{transform:rotate(14deg) scale(1.1)}
.gfm-listening .gfm-pulse{opacity:.45}
.gfm-thinking .gfm-eyes{transform:translate(1.5px,-2.5px)}
.gfm-thinking .gfm-lid{transform:translateY(-1px) rotate(3deg)}
.gfm-talking .gfm-lid{transform:translateY(-1.5px)}
.gfm-anim .gfm-lid,.gfm-anim .gfm-eyes,.gfm-anim .gfm-bow-l,.gfm-anim .gfm-bow-r{transition:transform .35s cubic-bezier(.22,.61,.36,1)}
.gfm-anim .gfm-body{animation:gfm-bob 3.6s ease-in-out infinite}
.gfm-anim .gfm-shadow{animation:gfm-shadow 3.6s ease-in-out infinite}
.gfm-anim .gfm-eye{animation:gfm-blink 5.2s infinite}
.gfm-anim.gfm-listening .gfm-pulse{animation:gfm-pulse 1.8s ease-out infinite}
.gfm-anim .gfm-dots circle{animation:gfm-dot 1.2s ease-in-out infinite}
.gfm-anim .gfm-dots circle:nth-child(2){animation-delay:.2s}
.gfm-anim .gfm-dots circle:nth-child(3){animation-delay:.4s}
@keyframes gfm-bob{50%{transform:translateY(-2.5px)}}
@keyframes gfm-shadow{50%{transform:scaleX(.88);opacity:.07}}
@keyframes gfm-blink{0%,93%,100%{transform:scaleY(1)}96%{transform:scaleY(.12)}}
@keyframes gfm-pulse{0%{transform:scale(.9);opacity:.5}100%{transform:scale(1.08);opacity:0}}
@keyframes gfm-dot{0%,100%{opacity:.25}50%{opacity:1}}
`;

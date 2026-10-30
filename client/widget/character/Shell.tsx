"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import type { CharacterProps } from "./types";

/**
 * Shared chrome for every widget character (owner: A4): the tip bubble (typed out, dismissible), a
 * polite live region carrying the whole tip once, and the launcher button (Enter/Space/click).
 * The art (SVG mascot or Live2D canvas) is the launcher's child.
 */
const CHAR_MS = 28;

const subscribe = (cb: () => void) => {
  document.addEventListener("visibilitychange", cb);
  return () => document.removeEventListener("visibilitychange", cb);
};
export const useDocumentHidden = () =>
  useSyncExternalStore(
    subscribe,
    () => document.hidden,
    () => false,
  );

export interface TipState {
  text: string;
  show: boolean;
  /** Characters typed so far. */
  n: number;
  typing: boolean;
  dismiss(): void;
}

/** Characters of `text` shown so far; all of it at once when `instant`. */
function useTyped(text: string, instant: boolean): number {
  const [typed, setTyped] = useState({ text, n: 0 });
  let n = typed.n;
  if (typed.text !== text) {
    n = 0;
    setTyped({ text, n }); // reset on a new tip (derived-state pattern)
  }
  const done = instant || n >= text.length;
  useEffect(() => {
    if (done) return;
    const id = setInterval(() => {
      setTyped((t) => (t.text !== text ? t : { text, n: document.hidden ? text.length : Math.min(text.length, t.n + 1) }));
    }, CHAR_MS);
    return () => clearInterval(id);
  }, [text, done]);
  return instant ? text.length : n;
}

export function useTip(tip: string | undefined, reducedMotion: boolean, onDismissTip?: () => void): TipState {
  const text = tip?.trim() ?? "";
  const [dismissed, setDismissed] = useState<string | null>(null);
  const show = text !== "" && dismissed !== text;
  const n = useTyped(show ? text : "", reducedMotion);
  return {
    text,
    show,
    n,
    typing: show && n < text.length,
    dismiss: () => {
      setDismissed(text);
      onDismissTip?.();
    },
  };
}

type ShellProps = Pick<CharacterProps, "state" | "onActivate" | "reducedMotion" | "label" | "dismissLabel"> & {
  tip: TipState;
  hidden: boolean;
  /** Size/shape classes of the launcher (the art decides). */
  launcherClassName: string;
  children: ReactNode;
};

export function CharacterShell({
  state,
  onActivate,
  reducedMotion,
  label = "Open gift assistant",
  dismissLabel = "Dismiss tip",
  tip,
  hidden,
  launcherClassName,
  children,
}: ShellProps) {
  const launcher = useRef<HTMLButtonElement>(null);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault(); // no second (native) click, no page scroll on Space
    if (e.key === "Enter" && !e.repeat) onActivate();
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.key !== " ") return;
    e.preventDefault();
    onActivate();
  };

  return (
    <div
      className={`gfm gfm-${state} ${reducedMotion ? "gfm-still" : "gfm-anim"}${hidden ? " gfm-paused" : ""} inline-flex flex-col items-end gap-2`}
      data-state={state}
    >
      <style href="gf-character" precedence="low">
        {CSS}
      </style>
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {tip.show ? tip.text : ""}
      </p>
      {tip.show && (
        <div data-testid="widget-tip" className="gfm-tip relative w-max max-w-[min(16rem,calc(100vw-2rem))] rounded-2xl rounded-br-md border border-line bg-white py-3 pr-9 pl-4 text-left text-sm leading-5 text-ink shadow-[0_8px_24px_rgb(31_26_23/0.12)]">
          <p aria-hidden="true" className="grid" data-testid="character-tip-text">
            <span className="invisible [grid-area:1/1]">{tip.text}</span>
            <span className="[grid-area:1/1]">{tip.text.slice(0, tip.n)}</span>
          </p>
          <button
            type="button"
            aria-label={dismissLabel}
            onClick={() => {
              tip.dismiss();
              launcher.current?.focus();
            }}
            className="absolute top-1 right-1 grid h-8 w-8 place-items-center rounded-full text-muted hover:bg-cream hover:text-ink focus-visible:outline-2 focus-visible:outline-ink"
          >
            <svg aria-hidden="true" viewBox="0 0 12 12" className="h-3 w-3">
              <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      )}
      <button
        ref={launcher}
        type="button"
        aria-label={label}
        onClick={onActivate}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        className={`relative grid place-items-center overflow-visible border border-line-strong bg-ivory shadow-[0_6px_20px_rgb(31_26_23/0.16)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ink ${launcherClassName}${reducedMotion ? "" : " transition-transform duration-200 hover:-translate-y-0.5"}`}
      >
        {children}
      </button>
    </div>
  );
}

const CSS = `
.gfm-anim .gfm-tip{animation:gfm-in .28s cubic-bezier(.22,.61,.36,1)}
.gfm-paused *{animation-play-state:paused!important}
@keyframes gfm-in{from{opacity:0;transform:translateY(4px)}}
@media (prefers-reduced-motion:reduce){.gfm *{animation:none!important;transition:none!important}}
`;

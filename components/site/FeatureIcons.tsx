/** Small line icons for the landing's feature cards (owner: A4, P8.4). Drawn for GiftFit, 24×24. */
import type { SVGProps } from "react";

const base: SVGProps<SVGSVGElement> = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
  className: "size-6",
};

/** Help me choose: a chat bubble with a sparkle. */
export function IconChoose() {
  return (
    <svg {...base}>
      <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h8A2.5 2.5 0 0 1 17 6.5V12a2.5 2.5 0 0 1-2.5 2.5H10l-3.5 3v-3h0A2.5 2.5 0 0 1 4 12Z" />
      <path d="M19 9.5v.01M20.5 14l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5L18.5 16l1.5-.5Z" />
      <path d="M8 9.2h5M8 11.6h3" />
    </svg>
  );
}

/** Private try-on: a phone with an eye that is crossed out (the giver never sees the photos). */
export function IconPrivate() {
  return (
    <svg {...base}>
      <rect x="6.5" y="2.75" width="11" height="18.5" rx="2.5" />
      <path d="M10.5 18.25h3" />
      <path d="M8.75 10.5c1-1.6 2-2.25 3.25-2.25s2.25.65 3.25 2.25c-1 1.6-2 2.25-3.25 2.25s-2.25-.65-3.25-2.25Z" />
      <path d="m8.5 14 7-7" />
    </svg>
  );
}

/** Fit Report: a card with score bars and a heart. */
export function IconReport() {
  return (
    <svg {...base}>
      <rect x="3.5" y="4" width="17" height="16" rx="2.5" />
      <path d="M7 15.5v-3M10.5 15.5v-6M14 15.5V11" />
      <path d="M17.25 8.6c-.5-.9-1.9-.8-1.9.3 0 .9 1.9 2 1.9 2s1.9-1.1 1.9-2c0-1.1-1.4-1.2-1.9-.3Z" />
    </svg>
  );
}

/** Voice + multilingual: a microphone with two speech waves. */
export function IconVoice() {
  return (
    <svg {...base}>
      <rect x="8.5" y="3" width="5" height="10" rx="2.5" />
      <path d="M5.5 10.5a5.5 5.5 0 0 0 11 0M11 16v4M8 20h6" />
      <path d="M19 7.5c.8.9.8 2.6 0 3.5M21 5.75c1.6 1.9 1.6 5.1 0 7" />
    </svg>
  );
}

"use client";
/**
 * Dark code block with a Copy button (owner: A4, P8.4). The code scrolls inside its own box, so long
 * lines never widen the page on a phone.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";

export function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = (text: string) => {
    const done = (ok: boolean) => {
      setCopied(ok);
      clearTimeout(timer.current);
      if (ok) timer.current = setTimeout(() => setCopied(false), 2200);
    };
    try {
      const p = navigator.clipboard?.writeText(text);
      if (p) void p.then(() => done(true), () => done(false));
      else done(false);
    } catch {
      done(false);
    }
  };
  return [copied, copy];
}

export function CopyButton({ text, copyLabel, copiedLabel, testId, className = "" }: { text: string; copyLabel: string; copiedLabel: string; testId?: string; className?: string }) {
  const [copied, copy] = useCopy();
  return (
    <>
      <button
        type="button"
        onClick={() => copy(text)}
        className={`inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-full border border-night-600 px-4 text-sm font-medium text-fog-100 transition-colors hover:border-fog-300 hover:bg-night-700 ${className}`}
        data-testid={testId}
      >
        <svg aria-hidden="true" viewBox="0 0 20 20" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.6">
          {copied ? <path d="m4.5 10.5 3.5 3.5 7.5-8" strokeLinecap="round" strokeLinejoin="round" /> : <><rect x="6.5" y="6.5" width="9" height="10" rx="2" /><path d="M13 4.5H6.5a2 2 0 0 0-2 2V14" strokeLinecap="round" /></>}
        </svg>
        {copied ? copiedLabel : copyLabel}
      </button>
      <span role="status" className="sr-only">
        {copied ? copiedLabel : ""}
      </span>
    </>
  );
}

export function CodeBlock({ code, label, copyLabel, copiedLabel, testId, children }: { code: string; label: string; copyLabel: string; copiedLabel: string; testId?: string; children?: ReactNode }) {
  return (
    <figure className="min-w-0 overflow-hidden rounded-2xl border border-night-700 bg-night-900">
      <figcaption className="flex items-center justify-between gap-3 border-b border-night-700 py-1.5 pr-1.5 pl-4">
        <span className="truncate font-mono text-xs text-fog-400">{label}</span>
        <CopyButton text={code} copyLabel={copyLabel} copiedLabel={copiedLabel} testId={testId ? `${testId}-copy` : undefined} className="min-h-11 border-transparent" />
      </figcaption>
      <pre className="gf-code p-4 text-[13px] leading-6 text-fog-100" tabIndex={0} aria-label={label} data-testid={testId}>
        <code>{children ?? code}</code>
      </pre>
    </figure>
  );
}

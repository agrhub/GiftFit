"use client";
/**
 * Live code window (owner: A4, P8.4): the embed snippet with two options (data-langs, data-widget),
 * Copy, and Run, which mounts the real widget on this page (components/site/runWidget.ts).
 */
import { useEffect, useId, useRef, useState } from "react";
import { scheduleLive2DWarmup } from "@/components/widget/character/live2d/load";
import type { CodeLabels } from "./labels";
import { CopyButton } from "./CodeBlock";
import { openChat, runWidget, whenReady } from "./runWidget";
import { giftfitSnippet, tokenizeTag, type SnippetLangs, type Token } from "./snippets";

const TOKEN_CLASS: Record<Token["kind"], string> = {
  punct: "text-fog-400",
  tag: "text-glow-sky",
  attr: "text-glow-gold",
  value: "text-glow-mint",
  text: "text-fog-100",
};

type RunState = "idle" | "loading" | "ready" | "opened" | "failed" | "off";

export function CodeWindow({ origin, labels: l }: { origin: string; labels: CodeLabels }) {
  const [langs, setLangs] = useState<SnippetLangs>("en,vi");
  const [widget, setWidget] = useState(true);
  const [run, setRun] = useState<RunState>("idle");
  const cancel = useRef<(() => void) | undefined>(undefined);
  const statusId = useId();
  useEffect(() => () => cancel.current?.(), []);
  // Run shows Mark-kun: download Live2D once the landing has painted and gone idle (A20).
  useEffect(() => scheduleLive2DWarmup(), []);

  const snippet = giftfitSnippet(origin, { langs, widget });

  const onRun = () => {
    cancel.current?.();
    const result = runWidget({ origin, store: "aurum", langs, widget });
    if (result === "off") return setRun("off");
    const reopen = result === "reopened";
    setRun(reopen ? "opened" : "loading");
    cancel.current = whenReady((ok) => {
      if (!ok) return setRun("failed");
      if (reopen) openChat();
      setRun(reopen ? "opened" : "ready");
    });
  };

  const status = { idle: "", loading: l["landing.runLoading"], ready: l["landing.runReady"], opened: l["landing.runOpened"], failed: l["landing.runFailed"], off: l["landing.runOff"] }[run];
  const langOptions: Array<[SnippetLangs, string]> = [
    ["en,vi", l["landing.codeLangsBoth"]],
    ["en", l["landing.codeLangsEn"]],
    ["vi", l["landing.codeLangsVi"]],
  ];

  return (
    <div className="min-w-0 overflow-hidden rounded-3xl border border-night-700 bg-night-900/90 shadow-[0_30px_80px_-30px_rgb(170_156_255/0.35)] backdrop-blur" data-testid="code-window">
      <div className="flex items-center gap-3 border-b border-night-700 px-4 py-3">
        <span aria-hidden="true" className="flex gap-1.5">
          <span className="size-2.5 rounded-full bg-glow-rose/80" />
          <span className="size-2.5 rounded-full bg-glow-gold/80" />
          <span className="size-2.5 rounded-full bg-glow-mint/80" />
        </span>
        <span className="font-mono text-xs text-fog-400">index.html</span>
      </div>

      <div className="flex flex-wrap items-end gap-x-6 gap-y-3 border-b border-night-700 px-4 py-4" role="group" aria-label={l["landing.codeOptions"]}>
        <fieldset className="min-w-0">
          <legend className="mb-1.5 text-xs text-fog-400">
            {l["landing.codeLangs"]} <code className="font-mono text-glow-gold">data-langs</code>
          </legend>
          <div className="flex flex-wrap gap-1.5">
            {langOptions.map(([value, label]) => (
              <label key={value} className="cursor-pointer">
                <input
                  type="radio"
                  name={`${statusId}-langs`}
                  value={value}
                  checked={langs === value}
                  onChange={() => setLangs(value)}
                  className="peer sr-only"
                  data-testid={`code-langs-${value.replace(",", "-")}`}
                />
                <span className="inline-flex min-h-11 items-center rounded-full border border-night-600 px-3.5 text-sm text-fog-300 transition-colors peer-checked:border-glow-violet peer-checked:bg-glow-violet/15 peer-checked:text-fog-100 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-glow-gold hover:border-fog-400 hover:text-fog-100">
                  {label}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <div>
          <p className="mb-1.5 text-xs text-fog-400" id={`${statusId}-widget`}>
            {l["landing.codeWidget"]} <code className="font-mono text-glow-gold">data-widget</code>
          </p>
          <button
            type="button"
            role="switch"
            aria-checked={widget}
            aria-labelledby={`${statusId}-widget`}
            onClick={() => setWidget((w) => !w)}
            className="inline-flex min-h-11 items-center gap-2.5 rounded-full border border-night-600 px-3 text-sm text-fog-100 hover:border-fog-400"
            data-testid="code-widget"
          >
            <span aria-hidden="true" className={`relative h-5 w-9 rounded-full transition-colors ${widget ? "bg-glow-mint/80" : "bg-night-600"}`}>
              <span className={`absolute top-0.5 left-0 size-4 rounded-full bg-night-950 transition-transform ${widget ? "translate-x-4.5" : "translate-x-0.5"}`} />
            </span>
            {widget ? l["landing.codeOn"] : l["landing.codeOff"]}
          </button>
        </div>
      </div>

      <pre className="gf-code px-4 py-5 font-mono text-[13px] leading-6" tabIndex={0} aria-label="index.html" data-testid="code-snippet">
        <code>
          {tokenizeTag(snippet).map((t, i) => (
            <span key={i} className={TOKEN_CLASS[t.kind]}>
              {t.text}
            </span>
          ))}
        </code>
      </pre>

      <div className="flex flex-wrap items-center gap-3 border-t border-night-700 px-4 py-3">
        <button
          type="button"
          onClick={onRun}
          aria-describedby={statusId}
          className="inline-flex min-h-11 items-center gap-2 rounded-full bg-linear-to-r from-glow-gold via-glow-rose to-glow-violet px-6 text-sm font-semibold text-night-950 transition-transform hover:-translate-y-0.5"
          data-testid="code-run"
        >
          <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5" fill="currentColor">
            <path d="M4 2.8v10.4a.8.8 0 0 0 1.2.7l8.4-5.2a.8.8 0 0 0 0-1.4L5.2 2.1a.8.8 0 0 0-1.2.7Z" />
          </svg>
          {l["landing.codeRun"]}
        </button>
        <CopyButton text={snippet} copyLabel={l["site.copy"]} copiedLabel={l["site.copied"]} testId="code-copy" />
        <p id={statusId} role="status" className="min-w-0 basis-full text-sm leading-6 text-fog-300 empty:hidden" data-testid="code-run-status">
          {status}
        </p>
      </div>
    </div>
  );
}

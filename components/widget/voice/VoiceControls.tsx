"use client";
/**
 * Panel-header voice controls (owner: A4, P8.3):
 *   VoiceToggle   spoken replies on/off (OFF by default, remembered per viewer)
 *   AiVoiceLabel  "AI voice", shown under the title whenever voice is on and highlighted while audio
 *                 plays; its popover says the speech is machine-generated and names the engine
 *                 (Google Cloud Text-to-Speech, the browser's own voice, or the mock tone).
 */
import { useEffect, useId, useRef, useState } from "react";
import type { MessageKey } from "@/lib/i18n";
import type { EngineName } from "./speaker";

type Tr = (key: MessageKey, vars?: Record<string, string | number>) => string;

export function engineKey(engine: EngineName): MessageKey {
  return `voice.engine.${engine}` as MessageKey;
}

export function VoiceToggle({ tr, on, onToggle }: { tr: Tr; on: boolean; onToggle(): void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={on}
      aria-label={on ? tr("voice.turnOff") : tr("voice.turnOn")}
      title={on ? tr("voice.turnOff") : tr("voice.turnOn")}
      data-testid="voice-toggle"
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-ink hover:bg-ivory focus-visible:outline-2 focus-visible:outline-ink"
    >
      <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
        {on ? <path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" /> : <path d="M16 9.5l5 5M21 9.5l-5 5" />}
      </svg>
    </button>
  );
}

export function AiVoiceLabel({ tr, speaking, engine }: { tr: Tr; speaking: boolean; engine: EngineName | null }) {
  const [info, setInfo] = useState(false);
  const popId = useId();
  const box = useRef<HTMLSpanElement>(null);
  const [lastEngine, setLastEngine] = useState<EngineName | null>(null);
  useEffect(() => {
    if (engine) setLastEngine(engine);
  }, [engine]);

  useEffect(() => {
    if (!info) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setInfo(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [info]);

  const shown = engine ?? lastEngine;
  return (
    <span ref={box} className="relative inline-flex shrink-0" data-testid="voice-controls">
      <button
        type="button"
        onClick={() => setInfo((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && info) {
            e.stopPropagation();
            setInfo(false);
          }
        }}
        aria-expanded={info}
        aria-controls={popId}
        data-testid="voice-ai-label"
        data-playing={speaking ? "" : undefined}
        className={`inline-flex min-h-6 items-center gap-1 rounded-full border px-2 text-[11px] leading-4 font-medium whitespace-nowrap ${speaking ? "border-gold bg-cream text-ink" : "border-line text-muted"}`}
      >
        {speaking && (
          <span aria-hidden="true" className="flex h-3 items-end gap-px">
            <span className="w-0.5 animate-pulse bg-gold-deep" style={{ height: "60%" }} />
            <span className="w-0.5 animate-pulse bg-gold-deep [animation-delay:150ms]" style={{ height: "100%" }} />
            <span className="w-0.5 animate-pulse bg-gold-deep [animation-delay:300ms]" style={{ height: "40%" }} />
          </span>
        )}
        {tr("voice.aiLabel")}
      </button>
      {info && (
        <span id={popId} role="dialog" aria-label={tr("voice.aiInfoTitle")} className="absolute top-full left-0 z-20 mt-1 block w-64 rounded-2xl border border-line bg-white p-3 text-xs leading-5 text-ink shadow-xl" data-testid="voice-ai-info">
          <span className="mb-1 block font-semibold">{tr("voice.aiInfoTitle")}</span>
          <span className="block">{tr("voice.aiInfo")}</span>
          {shown && <span className="mt-1 block text-ink-soft">{tr(engineKey(shown))}</span>}
        </span>
      )}
      {speaking && (
        <span role="status" className="sr-only">
          {tr("voice.speaking")} · {tr("voice.aiLabel")}
        </span>
      )}
    </span>
  );
}

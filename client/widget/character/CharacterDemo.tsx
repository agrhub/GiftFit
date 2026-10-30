"use client";

import { useState } from "react";
import { Character } from "./Character";
import { Live2DCredits } from "./Live2DCredits";
import { Mascot } from "./Mascot";
import type { CharacterState } from "./types";

/** Dev preview for /widget-character-demo (owner: A4). Not part of the widget bundle. */
const STATES: CharacterState[] = ["idle", "listening", "thinking", "talking"];

export function CharacterDemo() {
  const [state, setState] = useState<CharacterState>("talking");
  const [tip, setTip] = useState("Looking for a gift? I can help you choose in under a minute.");
  const [useSlider, setUseSlider] = useState(false);
  const [mouth, setMouth] = useState(0.5);
  const [reduced, setReduced] = useState(false);
  const [clicks, setClicks] = useState(0);
  const [fallback, setFallback] = useState<string | null>(null);
  const common = { mouth: useSlider ? mouth : undefined, reducedMotion: reduced, onActivate: () => setClicks((c) => c + 1) };

  return (
    <div className="space-y-10">
      <fieldset className="grid gap-4 rounded-2xl border border-line bg-white p-5 text-sm sm:grid-cols-2">
        <legend className="px-1 font-semibold text-ink">Controls</legend>
        <label className="grid gap-1">
          <span className="text-muted">State</span>
          <select
            value={state}
            onChange={(e) => setState(e.target.value as CharacterState)}
            className="rounded-lg border border-line-strong bg-ivory px-3 py-2"
          >
            {STATES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label className="grid gap-1">
          <span className="text-muted">Tip (empty = none)</span>
          <input value={tip} onChange={(e) => setTip(e.target.value)} className="rounded-lg border border-line-strong bg-ivory px-3 py-2" />
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={useSlider} onChange={(e) => setUseSlider(e.target.checked)} />
          Drive the mouth with the slider (else typing rhythm)
        </label>
        <label className="grid gap-1">
          <span className="text-muted">Mouth {mouth.toFixed(2)}</span>
          <input type="range" min={0} max={1} step={0.01} value={mouth} onChange={(e) => setMouth(Number(e.target.value))} disabled={!useSlider} />
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={reduced} onChange={(e) => setReduced(e.target.checked)} />
          reducedMotion
        </label>
        <p className="text-muted" aria-live="polite">
          onActivate calls: {clicks}
          {fallback ? ` · Live2D fell back: ${fallback}` : ""}
        </p>
      </fieldset>

      <section>
        <h2 className="font-display text-2xl text-ink">All four states (SVG mascot)</h2>
        <div className="mt-4 flex flex-wrap items-end gap-8">
          {STATES.map((s) => (
            <div key={s} className="grid justify-items-center gap-2">
              <Mascot {...common} state={s} label={`Open gift assistant (${s})`} />
              <span className="text-xs text-muted">{s}</span>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="font-display text-2xl text-ink">Launcher with tip</h2>
        <div className="mt-4 flex flex-wrap items-end gap-10">
          <div className="grid justify-items-end gap-2">
            <Mascot {...common} state={state} tip={tip} />
            <span className="text-xs text-muted">SVG mascot</span>
          </div>
          <div className="grid justify-items-end gap-2">
            <Character {...common} state={state} tip={tip} onFallback={setFallback} />
            <span className="text-xs text-muted">Character (Live2D, SVG fallback)</span>
          </div>
        </div>
      </section>

      <Live2DCredits className="max-w-xl" />
    </div>
  );
}

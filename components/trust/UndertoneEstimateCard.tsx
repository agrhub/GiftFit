"use client";
/**
 * Undertone estimate with override (owner: A5). RECIPIENT ONLY: it may show the recipient their own
 * skin color hex; never render it on a giver page. Labelled "Estimate" everywhere; low confidence
 * asks the recipient to check. The choice is saved through POST /api/recipient/undertone unless
 * an `onChange` handler is given.
 */
import { useId, useState } from "react";

export type UndertoneValue = "warm" | "neutral" | "cool";

const OPTIONS: Array<{ value: UndertoneValue; label: string; hint: string }> = [
  { value: "warm", label: "Warm", hint: "golden, peachy" },
  { value: "neutral", label: "Neutral", hint: "a bit of both" },
  { value: "cool", label: "Cool", hint: "pink, rosy" },
];

export const LOW_CONFIDENCE = 0.5;

export interface UndertoneEstimateCardProps {
  estimate: UndertoneValue;
  /** 0..1 from the estimator. */
  confidence: number;
  /** The recipient's saved correction, if any. */
  override?: UndertoneValue | null;
  /** The recipient's own skin color as read from their selfie (shown to them only; optional). */
  skinHex?: string;
  /** Custom persistence; defaults to POST /api/recipient/undertone. */
  onChange?: (value: UndertoneValue | null) => Promise<void> | void;
  endpoint?: string;
  /** Bearer token if the session cookie is not used. */
  sessionToken?: string;
  className?: string;
}

function confidenceText(c: number): string {
  if (c < LOW_CONFIDENCE) return "We are not sure about this one. Please check it.";
  if (c < 0.75) return "Fairly sure, but you know best.";
  return "Quite sure, but you know best.";
}

const label = (v: UndertoneValue) => OPTIONS.find((o) => o.value === v)!.label;

export function UndertoneEstimateCard({ estimate, confidence, override = null, skinHex, onChange, endpoint = "/api/recipient/undertone", sessionToken, className = "" }: UndertoneEstimateCardProps) {
  const [choice, setChoice] = useState<UndertoneValue | null>(override);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const headingId = useId();
  const name = useId();
  const effective = choice ?? estimate;
  const low = confidence < LOW_CONFIDENCE;
  const validHex = skinHex && /^#[0-9a-fA-F]{6}$/.test(skinHex) ? skinHex : undefined;

  async function save(value: UndertoneValue | null) {
    const previous = choice;
    setChoice(value);
    setStatus("saving");
    try {
      if (onChange) await onChange(value);
      else {
        const res = await fetch(endpoint, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}) },
          body: JSON.stringify({ undertone: value }),
        });
        if (!res.ok) throw new Error(String(res.status));
      }
      setStatus("saved");
    } catch {
      setChoice(previous);
      setStatus("error");
    }
  }

  return (
    <section aria-labelledby={headingId} className={`rounded-2xl border border-stone-200 bg-white p-5 text-stone-900 shadow-sm dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100 ${className}`}>
      <div className="flex items-center gap-2">
        <h2 id={headingId} className="text-base font-semibold">
          Your undertone
        </h2>
        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-amber-900">Estimate</span>
      </div>

      <p className="mt-2 text-sm text-stone-700 dark:text-stone-300">
        Our AI estimate from your selfie: <strong>{label(estimate)}</strong>. {confidenceText(confidence)}
      </p>

      {validHex ? (
        <p className="mt-2 flex items-center gap-2 text-sm text-stone-700 dark:text-stone-300">
          <span aria-hidden="true" className="inline-block h-5 w-5 rounded-full border border-stone-300" style={{ backgroundColor: validHex }} />
          <span>
            Skin color read from your photo: <span className="font-mono">{validHex}</span> (only you see this; it is not stored)
          </span>
        </p>
      ) : null}

      <fieldset className="mt-4">
        <legend className={`text-sm font-medium ${low ? "text-amber-900 dark:text-amber-200" : ""}`}>
          {low ? "Please pick the one that fits you best:" : "Does this look right? You can change it:"}
        </legend>
        <div className="mt-2 grid grid-cols-3 gap-2">
          {OPTIONS.map((o) => {
            const id = `${name}-${o.value}`;
            const checked = effective === o.value;
            return (
              <label
                key={o.value}
                htmlFor={id}
                className={`flex min-h-11 cursor-pointer flex-col items-center justify-center rounded-xl border px-2 py-2 text-center text-sm focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-stone-900 dark:focus-within:outline-stone-100 ${
                  checked ? "border-stone-900 bg-stone-900 text-white dark:border-stone-100 dark:bg-stone-100 dark:text-stone-900" : "border-stone-300 bg-white text-stone-900 dark:border-stone-600 dark:bg-stone-900 dark:text-stone-100"
                }`}
              >
                <input
                  id={id}
                  type="radio"
                  name={name}
                  value={o.value}
                  checked={checked}
                  disabled={status === "saving"}
                  onChange={() => save(o.value === estimate ? null : o.value)}
                  className="sr-only"
                />
                <span className="font-semibold">{o.label}</span>
                <span className={`text-xs ${checked ? "text-stone-200 dark:text-stone-700" : "text-stone-600 dark:text-stone-400"}`}>{o.hint}</span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {choice ? (
        <p className="mt-3 text-sm">
          Using your choice: <strong>{label(choice)}</strong>.{" "}
          <button type="button" onClick={() => save(null)} disabled={status === "saving"} className="underline underline-offset-2 focus:outline-2 focus:outline-offset-2">
            Use the estimate instead
          </button>
        </p>
      ) : null}

      <p aria-live="polite" className="mt-2 min-h-5 text-sm text-stone-700 dark:text-stone-300">
        {status === "saving" ? "Saving…" : status === "saved" ? "Saved. Your choice always wins over the estimate." : status === "error" ? "Could not save. Please try again." : ""}
      </p>
    </section>
  );
}

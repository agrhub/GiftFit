"use client";
/**
 * Undertone estimate with override (owner: A5). RECIPIENT ONLY: it may show the recipient their own
 * skin color hex; never render it on a giver page. Labelled "Estimate" everywhere; low confidence
 * asks the recipient to check. The choice is saved through POST /api/recipient/undertone unless
 * an `onChange` handler is given.
 */
import { useId, useState } from "react";
import type { Locale } from "@/lib/i18n";
import { recipientTranslator, type RecipientT } from "@/lib/i18n/recipient";

export type UndertoneValue = "warm" | "neutral" | "cool";

const OPTIONS: readonly UndertoneValue[] = ["warm", "neutral", "cool"];

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
  /** Recipient page locale (lib/i18n/recipient, A21); default English. */
  locale?: Locale;
}

/** A catalog sentence with one placeholder as its own element ("Our AI estimate from your selfie: **Warm**."). */
function WithValue({ template, value, name = "value", className }: { template: string; value: string; name?: string; className?: string }) {
  const [before, after = ""] = template.split(`{${name}}`);
  return (
    <>
      {before}
      {className ? <span className={className}>{value}</span> : <strong>{value}</strong>}
      {after}
    </>
  );
}

function confidenceText(t: RecipientT, c: number): string {
  if (c < LOW_CONFIDENCE) return t("undertone.lowConfidence");
  if (c < 0.75) return t("undertone.fairlySure");
  return t("undertone.quiteSure");
}

export function UndertoneEstimateCard({ estimate, confidence, override = null, skinHex, onChange, endpoint = "/api/recipient/undertone", sessionToken, className = "", locale = "en" }: UndertoneEstimateCardProps) {
  const t = recipientTranslator(locale);
  const label = (v: UndertoneValue) => t(`undertone.${v}`);
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
          {t("undertone.heading")}
        </h2>
        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-amber-900">{t("undertone.estimateTag")}</span>
      </div>

      <p className="mt-2 text-sm text-stone-700 dark:text-stone-300">
        <WithValue template={t("undertone.estimate")} value={label(estimate)} /> {confidenceText(t, confidence)}
      </p>

      {validHex ? (
        <p className="mt-2 flex items-center gap-2 text-sm text-stone-700 dark:text-stone-300">
          <span aria-hidden="true" className="inline-block h-5 w-5 rounded-full border border-stone-300" style={{ backgroundColor: validHex }} />
          <span>
            <WithValue template={t("undertone.skin")} value={validHex} name="hex" className="font-mono" />
          </span>
        </p>
      ) : null}

      <fieldset className="mt-4">
        <legend className={`text-sm font-medium ${low ? "text-amber-900 dark:text-amber-200" : ""}`}>
          {low ? t("undertone.pick") : t("undertone.change")}
        </legend>
        <div className="mt-2 grid grid-cols-3 gap-2">
          {OPTIONS.map((value) => {
            const o = { value, label: label(value), hint: t(`undertone.${value}Hint`) };
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
          <WithValue template={t("undertone.using")} value={label(choice)} />{" "}
          <button type="button" onClick={() => save(null)} disabled={status === "saving"} className="underline underline-offset-2 focus:outline-2 focus:outline-offset-2">
            {t("undertone.useEstimate")}
          </button>
        </p>
      ) : null}

      <p aria-live="polite" className="mt-2 min-h-5 text-sm text-stone-700 dark:text-stone-300">
        {status === "saving" ? t("undertone.saving") : status === "saved" ? t("undertone.saved") : status === "error" ? t("undertone.saveError") : ""}
      </p>
    </section>
  );
}

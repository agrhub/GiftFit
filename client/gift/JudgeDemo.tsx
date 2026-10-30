"use client";
/**
 * "Try the judge demo" (owner: A4, ADR-038). Calls POST /api/demo/seed, which creates a fresh
 * Fit Request for an AI-generated model with consent and capture already done and try-ons served
 * from pre-recorded fixtures: no YouCam call, no cost. Then offers the recipient and giver views.
 */
import Link from "next/link";
import dynamic from "next/dynamic";
import { useId, useState } from "react";
import type { DemoSeedResponse, DemoSubject } from "@/server/contracts/api";
import { ApiError, friendlyError, seedJudgeDemo } from "./api";

const QrCode = dynamic(() => import("./QrCode").then((m) => m.QrCode), {
  ssr: false,
});

/** Subjects from fixtures/youcam/ai-demo/showcase (the hero first, the default). */
export const DEMO_SUBJECTS: ReadonlyArray<{
  id: DemoSubject;
  label: string;
  hint: string;
}> = [
  {
    id: "showcase-latina-medium-warm",
    label: "Earrings and necklaces",
    hint: "Medium skin tone · anniversary, up to $300",
  },
  {
    id: "showcase-black-deep-warm",
    label: "Earrings and necklaces",
    hint: "Deep skin tone · anniversary, up to $300",
  },
  {
    id: "showcase-man-lightmed-neutral",
    label: "A watch and chains",
    hint: "Men's gifts · birthday, up to $600",
  },
];

const absoluteUrl = (path: string) =>
  typeof window === "undefined" ? path : `${window.location.origin}${path}`;

export const DEMO_EXPLAINER =
  "This demo uses pre-recorded try-ons of AI-generated models, so it costs nothing and needs no selfie.";

/** The giver link carries ?demo=1 so the report can say "Demo request" until the report API flags it. */
export const demoGiverHref = (path: string) =>
  `${path}${path.includes("?") ? "&" : "?"}demo=1`;

export function JudgeDemo({ compact = false }: { compact?: boolean }) {
  const [subject, setSubject] = useState<DemoSubject>(DEMO_SUBJECTS[0].id);
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "seeding" }
    | { kind: "ready"; seed: DemoSeedResponse }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const name = useId();

  async function seed() {
    setState({ kind: "seeding" });
    try {
      setState({ kind: "ready", seed: await seedJudgeDemo(subject) });
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        const minutes = err.retryAfter
          ? Math.max(1, Math.ceil(err.retryAfter / 60))
          : null;
        setState({
          kind: "error",
          message: `The demo is busy for your network right now (up to 10 demos an hour). ${minutes ? `Please try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.` : "Please try again a little later."}`,
        });
      } else setState({ kind: "error", message: friendlyError(err) });
    }
  }

  const ready = state.kind === "ready" ? state.seed : null;

  return (
    <div className="space-y-4" data-testid="judge-demo">
      <p className="text-sm leading-6 text-ink-soft">{DEMO_EXPLAINER}</p>
      {!compact ? (
        <fieldset>
          <legend className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">
            Choose a demo recipient
          </legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            {DEMO_SUBJECTS.map((d, i) => (
              <label
                key={d.id}
                className={`flex min-h-14 cursor-pointer flex-col justify-center rounded-xl border px-4 py-2 text-sm transition-colors focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ink ${
                  subject === d.id
                    ? "border-ink bg-white text-ink"
                    : "border-line-strong text-ink-soft hover:border-ink"
                }`}
              >
                <input
                  type="radio"
                  name={name}
                  value={d.id}
                  checked={subject === d.id}
                  onChange={() => setSubject(d.id)}
                  className="sr-only"
                  data-testid={`demo-subject-${i + 1}`}
                />
                <span className="font-medium text-ink">
                  AI model {i + 1}: {d.label}
                </span>
                <span className="text-xs text-muted">{d.hint}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      <button
        type="button"
        onClick={seed}
        disabled={state.kind === "seeding"}
        data-testid="try-judge-demo"
        className="inline-flex min-h-12 items-center justify-center gf-cta rounded-full bg-ink px-7 text-sm font-medium text-ivory transition-colors hover:bg-ink-soft disabled:cursor-wait disabled:opacity-80"
      >
        {state.kind === "seeding"
          ? "Preparing your demo…"
          : ready
            ? "Start another demo"
            : "Try the judge demo"}
      </button>
      <div aria-live="polite">
        {state.kind === "error" ? (
          <p
            role="alert"
            className="rounded-lg bg-blush px-3 py-2 text-sm text-rose"
            data-testid="judge-demo-error"
          >
            {state.message}
          </p>
        ) : null}
        {ready ? (
          <div className="gf-fade-in grid gap-4 rounded-2xl border border-line bg-white p-5 sm:grid-cols-[1fr_auto]">
            <div className="space-y-3">
              <p className="text-sm font-semibold text-ink">
                Your demo is ready. It lasts until{" "}
                {new Date(ready.expiresAt).toLocaleString("en-US", {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
                .
              </p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Link
                  href={ready.recipientPath}
                  data-testid="demo-recipient-link"
                  className="inline-flex min-h-11 items-center justify-center gf-cta rounded-full bg-ink px-5 text-sm font-medium text-ivory hover:bg-ink-soft"
                >
                  Open the recipient view
                </Link>
                <Link
                  href={demoGiverHref(ready.giverReportPath)}
                  data-testid="demo-giver-link"
                  className="inline-flex min-h-11 items-center justify-center rounded-full border border-ink px-5 text-sm font-medium text-ink hover:bg-cream"
                >
                  Open the giver&apos;s Fit Report
                </Link>
              </div>
              <p className="text-xs leading-5 text-muted">
                The recipient view is best on a phone: scan the code. Heart a
                few pieces and tap Finish, then open the Fit Report.
              </p>
            </div>
            <div className="justify-self-center">
              <QrCode
                value={absoluteUrl(ready.recipientPath)}
                size={132}
                label="QR code of the demo recipient view"
              />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

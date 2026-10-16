"use client";
import { useEffect, useRef } from "react";
import { DeleteEverythingButton } from "@/components/trust";
import { ShieldIcon } from "../icons";

export function DoneScreen({
  token,
  seconds,
  heartCount,
  alreadyDone = false,
  onDeleted,
  onViewPreviews,
}: {
  token: string;
  seconds?: number;
  heartCount?: number;
  alreadyDone?: boolean;
  onDeleted: () => void;
  /** Shown when the session was already finished and its previews could be restored. */
  onViewPreviews?: () => void;
}) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div
      className="gf-fade-in flex flex-1 flex-col items-center pt-8 text-center"
      data-testid="done-screen"
    >
      <span className="grid h-20 w-20 place-items-center rounded-full bg-sage text-white">
        <ShieldIcon className="h-10 w-10" />
      </span>
      <h1
        ref={ref}
        tabIndex={-1}
        className="mt-6 font-display text-4xl leading-tight text-ink focus:outline-none"
      >
        Done. Your photos are deleted.
        <br />
        <em className="font-normal">The surprise is safe.</em>
      </h1>
      <p className="mt-4 max-w-sm text-sm leading-6 text-ink-soft">
        {alreadyDone
          ? "You've already sent your hearts. "
          : "Your hearts are on their way. "}
        They&apos;ll see fit scores, never your photos, and not which pieces you
        were shown.
      </p>
      <dl className="mt-8 grid w-full grid-cols-3 gap-2">
        <div className="rounded-xl border border-line bg-white p-3">
          <dt className="text-[0.65rem] uppercase tracking-[0.14em] text-muted">
            Photos stored
          </dt>
          <dd
            className="font-display text-3xl text-ink"
            data-testid="photos-stored"
          >
            0
          </dd>
        </div>
        <div className="rounded-xl border border-line bg-white p-3">
          <dt className="text-[0.65rem] uppercase tracking-[0.14em] text-muted">
            Hearts sent
          </dt>
          <dd className="font-display text-3xl text-ink">
            {heartCount ?? "–"}
          </dd>
        </div>
        <div className="rounded-xl border border-line bg-white p-3">
          <dt className="text-[0.65rem] uppercase tracking-[0.14em] text-muted">
            Your time
          </dt>
          <dd
            className="font-display text-3xl text-ink"
            data-testid="time-to-hearts"
          >
            {seconds !== undefined ? `${Math.round(seconds)} s` : "–"}
          </dd>
        </div>
      </dl>
      <p className="mt-6 text-sm text-ink-soft">You can close this page.</p>
      {onViewPreviews ? (
        <button
          type="button"
          onClick={onViewPreviews}
          data-testid="view-previews"
          className="mt-3 min-h-11 text-sm text-ink underline decoration-gold underline-offset-4"
        >
          See your previews again
        </button>
      ) : null}
      <div className="mt-auto w-full rounded-2xl border border-line bg-white p-5 text-left">
        <h2 className="text-sm font-semibold text-ink">
          Want us to forget the rest too?
        </h2>
        <p className="mt-1 text-sm text-ink-soft">
          Your estimates and hearts are deleted automatically when the link
          expires. You can delete them now instead.
        </p>
        <div className="mt-3" data-testid="delete-everything">
          <DeleteEverythingButton sessionToken={token} onDeleted={onDeleted} />
        </div>
      </div>
    </div>
  );
}

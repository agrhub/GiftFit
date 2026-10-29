"use client";
import { useEffect, useRef } from "react";
import { DeleteEverythingButton } from "@/components/trust";
import { ShieldIcon } from "../icons";
import { useRt } from "./i18n";

export function DoneScreen({
  token,
  seconds,
  heartCount,
  alreadyDone = false,
  onDeleted,
  onViewPreviews,
  noTryOn = false,
}: {
  token: string;
  seconds?: number;
  heartCount?: number;
  alreadyDone?: boolean;
  onDeleted: () => void;
  /** Shown when the session was already finished and its previews could be restored. */
  onViewPreviews?: () => void;
  /** No try-on for this gift (store-URL previews, ADR-055): no photo was ever taken. */
  noTryOn?: boolean;
}) {
  const t = useRt();
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
        {noTryOn ? t("done.titleNoTryOn") : t("done.title")}
        <br />
        <em className="font-normal">{t("done.safe")}</em>
      </h1>
      <p className="mt-4 max-w-sm text-sm leading-6 text-ink-soft">
        {alreadyDone ? t("done.already") : t("done.onTheirWay")}{" "}
        {noTryOn ? t("done.seesNoTryOn") : t("done.sees")}
      </p>
      <dl className="mt-8 grid w-full grid-cols-3 gap-2">
        <div className="rounded-xl border border-line bg-white p-3">
          <dt className="text-[0.65rem] uppercase tracking-[0.14em] text-muted">
            {t("done.photosStored")}
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
            {t("done.heartsSent")}
          </dt>
          <dd className="font-display text-3xl text-ink">
            {heartCount ?? "–"}
          </dd>
        </div>
        <div className="rounded-xl border border-line bg-white p-3">
          <dt className="text-[0.65rem] uppercase tracking-[0.14em] text-muted">
            {t("done.yourTime")}
          </dt>
          <dd
            className="font-display text-3xl text-ink"
            data-testid="time-to-hearts"
          >
            {seconds !== undefined
              ? t("done.seconds", { seconds: Math.round(seconds) })
              : "–"}
          </dd>
        </div>
      </dl>
      <p className="mt-6 text-sm text-ink-soft">{t("done.close")}</p>
      {onViewPreviews ? (
        <button
          type="button"
          onClick={onViewPreviews}
          data-testid="view-previews"
          className="mt-3 min-h-11 text-sm text-ink underline decoration-gold underline-offset-4"
        >
          {t("done.viewPreviews")}
        </button>
      ) : null}
      <div className="mt-auto w-full rounded-2xl border border-line bg-white p-5 text-left">
        <h2 className="text-sm font-semibold text-ink">
          {t("done.forgetTitle")}
        </h2>
        <p className="mt-1 text-sm text-ink-soft">
          {t("done.forgetBody")}
        </p>
        <div className="mt-3" data-testid="delete-everything">
          <DeleteEverythingButton
            sessionToken={token}
            onDeleted={onDeleted}
            locale={t.locale}
          />
        </div>
      </div>
    </div>
  );
}

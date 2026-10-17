"use client";
/** Success view of the Giver Panel: share sheet, copy, QR, and the giver's private report link. */
import Link from "next/link";
import { useEffect, useId, useState } from "react";
import type { CreateFitRequestResponse } from "@/lib/contracts/api";
import { formatExpiry } from "@/components/store/format";
import { QrCode } from "./QrCode";
import { CheckIcon, CopyIcon, QrIcon, ShareIcon, ShieldIcon } from "./icons";

export function absoluteUrl(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}${path.startsWith("/") ? "" : "/"}${path}`;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** `curated`: a "Help me choose" request (ADR-045): GiftFit picked every piece, there are no look-alikes. */
export function FitRequestSent({ result, titles, onDone, curated = false }: { result: CreateFitRequestResponse; titles: string[]; onDone: () => void; curated?: boolean }) {
  const link = absoluteUrl(result.recipientPath);
  const reportLink = absoluteUrl(result.giverReportPath);
  const [canShare, setCanShare] = useState(false);
  const [status, setStatus] = useState("");
  const [showQr, setShowQr] = useState(false);
  const linkId = useId();
  const expiry = formatExpiry(result.expiresAt);

  useEffect(() => {
    setCanShare(typeof navigator !== "undefined" && typeof navigator.share === "function");
  }, []);

  async function share() {
    try {
      await navigator.share({
        title: "A little gift question",
        text: `Someone who cares about you is choosing a gift. Try on ${result.carouselSize} pieces and heart the ones you love. They will never see your photos.`,
        url: link,
      });
      setStatus("Shared.");
    } catch {
      /* the person closed the share sheet */
    }
  }

  async function copy(text: string, what: string) {
    setStatus((await copyText(text)) ? `${what} copied.` : "Copy didn't work here. Press and hold the link to copy it.");
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6" data-testid="fit-request-sent">
      <p className="text-sm leading-6 text-ink-soft">
        Send this private link to the person you&apos;re shopping for. {expiry ? <>It works for 72 hours, until {expiry}.</> : "It works for 72 hours."}
      </p>
      {curated ? (
        <p className="mt-3 text-xs text-ink-soft" data-testid="curated-note">
          <span className="rounded-full border border-line bg-white px-2.5 py-1">{result.carouselSize} pieces picked by GiftFit</span>
        </p>
      ) : (
        <ul className="mt-3 flex flex-wrap gap-1.5 text-xs text-ink-soft" aria-label="Your shortlist">
          {titles.map((t) => (
            <li key={t} className="rounded-full border border-line bg-white px-2.5 py-1">
              {t}
            </li>
          ))}
          <li className="rounded-full border border-dashed border-line-strong px-2.5 py-1 text-muted">+ similar pieces</li>
        </ul>
      )}

      <label htmlFor={linkId} className="mt-6 block text-xs font-semibold uppercase tracking-[0.18em] text-muted">
        Their link
      </label>
      <input id={linkId} readOnly value={link} data-testid="recipient-link" onFocus={(e) => e.currentTarget.select()} className="mt-2 block min-h-11 w-full truncate rounded-lg border border-line-strong bg-white px-3 font-mono text-xs text-ink" />

      <div className={`mt-3 grid gap-2 ${canShare ? "grid-cols-3" : "grid-cols-2"}`}>
        {canShare ? (
          <button type="button" onClick={share} data-testid="share-link" className="flex min-h-12 flex-col items-center justify-center gap-1 rounded-xl bg-ink text-xs font-medium text-ivory hover:bg-ink-soft">
            <ShareIcon /> Share
          </button>
        ) : null}
        <button type="button" onClick={() => copy(link, "Link")} data-testid="copy-link" className="flex min-h-12 flex-col items-center justify-center gap-1 rounded-xl border border-ink text-xs font-medium text-ink hover:bg-cream">
          <CopyIcon /> Copy link
        </button>
        <button type="button" onClick={() => setShowQr((v) => !v)} aria-expanded={showQr} data-testid="show-qr" className="flex min-h-12 flex-col items-center justify-center gap-1 rounded-xl border border-ink text-xs font-medium text-ink hover:bg-cream">
          <QrIcon /> {showQr ? "Hide QR" : "QR code"}
        </button>
      </div>
      <p aria-live="polite" role="status" className="mt-2 min-h-5 text-sm text-sage">
        {status}
      </p>
      {showQr ? (
        <div className="gf-fade-in mt-2 flex flex-col items-center gap-2 rounded-xl border border-line bg-white p-5">
          <QrCode value={link} label="QR code of their private try-on link" />
          <p className="text-center text-xs text-muted">Let them scan it with their phone camera.</p>
        </div>
      ) : null}

      <div className="mt-6 rounded-xl border border-line bg-cream/70 p-4">
        <p className="flex items-center gap-2 text-sm font-semibold text-ink">
          <ShieldIcon className="h-4 w-4 text-sage" /> Your Fit Report
        </p>
        <p className="mt-1 text-sm leading-6 text-ink-soft">This is your private key to the report. We keep it in this browser too, but save it somewhere safe.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link href={result.giverReportPath} data-testid="giver-report-link" className="inline-flex min-h-11 items-center rounded-full bg-ink px-5 text-sm font-medium text-ivory hover:bg-ink-soft">
            Open my Fit Report
          </Link>
          <button type="button" onClick={() => copy(reportLink, "Report link")} className="inline-flex min-h-11 items-center rounded-full border border-line-strong px-5 text-sm text-ink hover:border-ink">
            Copy report link
          </button>
        </div>
      </div>

      <dl className="mt-6 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-lg border border-line bg-white p-3">
          <dt className="text-[0.65rem] uppercase tracking-[0.14em] text-muted">Pieces they try</dt>
          <dd className="font-display text-2xl">{result.carouselSize}</dd>
        </div>
        <div className="rounded-lg border border-line bg-white p-3">
          <dt className="text-[0.65rem] uppercase tracking-[0.14em] text-muted">Link lifetime</dt>
          <dd className="font-display text-2xl">72 h</dd>
        </div>
        <div className="rounded-lg border border-line bg-white p-3">
          <dt className="text-[0.65rem] uppercase tracking-[0.14em] text-muted">Photos you see</dt>
          <dd className="font-display text-2xl">0</dd>
        </div>
      </dl>

      <button type="button" onClick={onDone} className="mt-6 flex min-h-12 w-full items-center justify-center gap-2 rounded-full border border-ink text-sm font-medium text-ink hover:bg-cream">
        <CheckIcon /> Done
      </button>
    </div>
  );
}

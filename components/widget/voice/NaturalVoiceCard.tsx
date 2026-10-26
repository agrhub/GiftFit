"use client";
/**
 * "Natural voice (beta)" opt-in (owner: A4, P8.3): Supertonic 3 running in the shopper's browser.
 * Shown only on desktop with WebGPU, and only once voice is on. Shows the download size from the
 * manifest; nothing is downloaded until "Download" is clicked; progress bar and Cancel while it runs.
 */
import type { Locale, MessageKey } from "@/lib/i18n";
import type { NaturalStatus } from "./supertonic/client";
import { formatBytes } from "./supertonic/manifest";

export interface NaturalVoiceCardProps {
  tr: (key: MessageKey, vars?: Record<string, string | number>) => string;
  locale: Locale;
  status: NaturalStatus;
  /** In the panel (dismissible) or in About (always shown). */
  variant: "banner" | "about";
  onDownload(): void;
  onCancel(): void;
  onDismiss?(): void;
  onTurnOff(): void;
  onRetry(): void;
}

export function NaturalVoiceCard({ tr, locale, status, variant, onDownload, onCancel, onDismiss, onTurnOff, onRetry }: NaturalVoiceCardProps) {
  const size = (n: number) => formatBytes(n, locale);
  if (status.kind === "unavailable" || status.kind === "checking") return null;
  if (variant === "banner" && status.kind === "ready" && !status.cacheWarning) return null;

  const frame = variant === "banner" ? "border-b border-line bg-cream/70 px-4 py-3" : "rounded-2xl border border-line bg-white p-4";
  return (
    <section aria-label={tr("natural.title")} className={`${frame} text-sm text-ink`} data-testid="natural-voice" data-status={status.kind}>
      <p className="mb-1 font-semibold">{tr("natural.title")}</p>
      {status.kind === "offer" && (
        <>
          <p className="text-xs leading-5 text-ink-soft">{tr("natural.offer", { size: size(status.total) })}</p>
          {status.cached > 0 && <p className="mt-1 text-xs text-ink-soft">{tr("natural.resume", { cached: size(status.cached), size: size(status.total) })}</p>}
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" onClick={onDownload} data-testid="natural-download" className="min-h-11 rounded-full bg-ink px-4 text-sm font-medium text-ivory hover:bg-ink-soft">
              {status.cached > 0 ? tr("natural.resumeButton") : tr("natural.download", { size: size(status.total) })}
            </button>
            {onDismiss && (
              <button type="button" onClick={onDismiss} className="min-h-11 rounded-full px-4 text-sm text-ink-soft hover:bg-ivory">
                {tr("natural.notNow")}
              </button>
            )}
          </div>
        </>
      )}
      {(status.kind === "downloading" || status.kind === "loading") && (
        <>
          <p className="text-xs text-ink-soft" aria-live="polite">
            {status.kind === "downloading" ? tr("natural.downloading", { done: size(status.loaded), size: size(status.total) }) : tr("natural.loading", { step: status.step, of: status.of })}
          </p>
          <progress
            className="mt-2 h-2 w-full overflow-hidden rounded-full accent-ink"
            aria-label={tr("natural.progress")}
            max={status.kind === "downloading" ? Math.max(1, status.total) : status.of}
            value={status.kind === "downloading" ? status.loaded : status.step}
            data-testid="natural-progress"
          />
          {status.kind === "downloading" && (
            <button type="button" onClick={onCancel} data-testid="natural-cancel" className="mt-2 min-h-11 rounded-full border border-line-strong px-4 text-sm text-ink-soft hover:border-ink">
              {tr("natural.cancel")}
            </button>
          )}
        </>
      )}
      {status.kind === "ready" && (
        <>
          <p className="text-xs text-ink-soft">{tr(status.ep === "wasm" ? "natural.readyWasm" : "natural.ready")}</p>
          {status.cacheWarning === "quota" && <p className="mt-1 text-xs text-rose">{tr("natural.quota")}</p>}
          {variant === "about" && (
            <button type="button" onClick={onTurnOff} className="mt-2 min-h-11 rounded-full border border-line-strong px-4 text-sm text-ink-soft hover:border-ink">
              {tr("natural.turnOff")}
            </button>
          )}
        </>
      )}
      {status.kind === "error" && (
        <>
          <p className="text-xs text-rose">{tr("natural.error")}</p>
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={onRetry} className="min-h-11 rounded-full border border-line-strong px-4 text-sm text-ink-soft hover:border-ink">
              {tr("natural.retry")}
            </button>
            {onDismiss && (
              <button type="button" onClick={onDismiss} className="min-h-11 rounded-full px-4 text-sm text-ink-soft hover:bg-ivory">
                {tr("natural.notNow")}
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

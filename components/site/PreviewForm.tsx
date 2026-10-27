"use client";
/**
 * "Paste your store URL" (owner: A4, P8.4): validates the address, asks GiftFit for a preview store,
 * polls its status with a progress line, then links to the preview and, once, to its private owner page.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { CopyButton } from "./CodeBlock";
import { fill, type PreviewLabels } from "./labels";
import { checkStoreUrl, httpPreviewApi, mockPreviewApi, type CreateError, type PreviewApi, type PreviewCreated, type PreviewStatus } from "./previewApi";

const POLL_MS = 1500;
const MAX_POLLS = 120; // ~3 minutes

type View =
  | { kind: "idle" }
  | { kind: "invalid"; message: string }
  | { kind: "error"; message: string }
  | { kind: "working"; status: PreviewStatus | null }
  | { kind: "ready"; created: PreviewCreated; count: number }
  | { kind: "refused"; message: string }
  | { kind: "failed"; message: string };

export interface PreviewFormProps {
  labels: PreviewLabels;
  /** Use the in-memory mock (tests, `?previewmock=1`). */
  mock?: boolean;
  /** Injected API (tests). */
  api?: PreviewApi;
  pollMs?: number;
}

export function PreviewForm({ labels: l, mock = false, api, pollMs = POLL_MS }: PreviewFormProps) {
  const client = useMemo(() => api ?? (mock ? mockPreviewApi() : httpPreviewApi), [api, mock]);
  const [url, setUrl] = useState("");
  const [view, setView] = useState<View>({ kind: "idle" });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const run = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const createError: Record<CreateError, string> = {
    invalid_url: l["landing.tryInvalid"],
    blocked_url: l["landing.tryBlocked"],
    rate_limited: l["landing.tryRateLimited"],
    daily_cap: l["landing.tryDailyCap"],
    paused: l["landing.tryPaused"],
    network: l["landing.tryNetwork"],
  };

  const endMessage = (s: PreviewStatus): string => {
    if (s.reason === "robots_disallowed") return l["landing.tryRobots"];
    if (s.reason === "site_blocked") return l["landing.trySiteBlocked"];
    if (s.reason === "blocked_url") return l["landing.tryBlocked"];
    if (s.reason === "unreachable") return l["landing.tryUnreachable"];
    if (s.state === "refused") return fill(l["landing.tryRefused"], { count: s.productCount });
    return l["landing.tryFailed"];
  };

  const poll = (id: number, created: PreviewCreated, n: number) => {
    timer.current = setTimeout(async () => {
      const s = await client.status(created.statusPath);
      if (id !== run.current) return;
      if (s?.state === "ready") return setView({ kind: "ready", created, count: s.productCount });
      if (s && (s.state === "refused" || s.state === "failed")) return setView({ kind: s.state, message: endMessage(s) });
      if (n + 1 >= MAX_POLLS) return setView({ kind: "failed", message: l["landing.tryTimeout"] });
      if (s) setView({ kind: "working", status: s });
      poll(id, created, n + 1);
    }, pollMs);
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (view.kind === "working") return;
    const check = checkStoreUrl(url);
    if (!check.ok) {
      setView({ kind: "invalid", message: check.error === "https" ? l["landing.tryHttps"] : l["landing.tryInvalid"] });
      inputRef.current?.focus();
      return;
    }
    clearTimeout(timer.current);
    const id = ++run.current;
    setView({ kind: "working", status: null });
    const res = await client.create(check.url);
    if (id !== run.current) return;
    if (!res.ok) return setView({ kind: "error", message: createError[res.error] });
    poll(id, res.created, 0);
  };

  const working = view.kind === "working";
  const progress =
    view.kind !== "working" ? "" : view.status?.state === "crawling" ? fill(l["landing.tryCrawling"], { count: view.status.productCount }) : l["landing.tryQueued"];
  const abs = (p: string) => (typeof window === "undefined" ? p : new URL(p, window.location.origin).href);

  return (
    <div data-testid="preview">
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3 sm:flex-row" data-testid="preview-form">
        <label htmlFor="store-url" className="sr-only">
          {l["landing.tryLabel"]}
        </label>
        <input
          ref={inputRef}
          id="store-url"
          name="url"
          type="url"
          inputMode="url"
          autoComplete="url"
          spellCheck={false}
          placeholder={l["landing.tryPlaceholder"]}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          aria-invalid={view.kind === "invalid" || undefined}
          aria-describedby={view.kind === "invalid" ? "store-url-error" : undefined}
          className="min-h-12 min-w-0 flex-1 rounded-full border border-night-600 bg-night-950 px-5 text-base text-fog-100 placeholder:text-fog-400 focus:border-glow-violet focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-glow-gold aria-[invalid]:border-glow-rose"
          data-testid="preview-url"
        />
        <button
          type="submit"
          disabled={working}
          className="inline-flex min-h-12 shrink-0 items-center justify-center rounded-full bg-fog-100 px-6 text-sm font-semibold text-night-950 transition-colors hover:bg-white disabled:cursor-progress disabled:opacity-70"
          data-testid="preview-submit"
        >
          {working ? l["landing.tryBusy"] : l["landing.tryButton"]}
        </button>
      </form>
      {mock && <p className="mt-2 text-xs text-fog-400">{l["landing.tryMock"]}</p>}

      <div className="mt-4 min-h-6">
        {view.kind === "invalid" && (
          <p id="store-url-error" role="alert" className="text-sm leading-6 text-glow-rose" data-testid="preview-error">
            {view.message}
          </p>
        )}
        {(view.kind === "error" || view.kind === "failed" || view.kind === "refused") && (
          <p role="alert" className="text-sm leading-6 text-glow-rose" data-testid={view.kind === "refused" ? "preview-refused" : "preview-error"}>
            {view.message}
          </p>
        )}
        <p role="status" className="flex items-center gap-2.5 text-sm leading-6 text-fog-300 empty:hidden" data-testid="preview-progress">
          {working && (
            <>
              <span aria-hidden="true" className="size-2 shrink-0 animate-pulse rounded-full bg-glow-mint" />
              {progress}
            </>
          )}
          {view.kind === "ready" && fill(l["landing.tryReady"], { count: view.count })}
        </p>
        {view.kind === "ready" && (
          <div className="mt-4 space-y-4 rounded-2xl border border-night-700 bg-night-800 p-5" data-testid="preview-ready">
            <div className="flex flex-wrap gap-3">
              <a href={view.created.previewPath} className="inline-flex min-h-11 items-center rounded-full bg-linear-to-r from-glow-gold via-glow-rose to-glow-violet px-6 text-sm font-semibold text-night-950" data-testid="preview-open">
                {l["landing.tryOpen"]}
              </a>
              <a href={view.created.ownerPath} className="inline-flex min-h-11 items-center rounded-full border border-night-600 px-6 text-sm font-medium text-fog-100 hover:border-fog-300" data-testid="preview-manage">
                {l["landing.tryManage"]}
              </a>
              <CopyButton text={abs(view.created.ownerPath)} copyLabel={l["landing.tryCopyOwner"]} copiedLabel={l["site.copied"]} testId="preview-copy-owner" />
            </div>
            <p className="flex gap-2 text-sm leading-6 text-fog-300" data-testid="preview-owner-note">
              <svg aria-hidden="true" viewBox="0 0 20 20" className="mt-1 size-4 shrink-0 text-glow-gold" fill="none" stroke="currentColor" strokeWidth="1.6">
                <rect x="4" y="9" width="12" height="8" rx="2" />
                <path d="M7 9V6.5a3 3 0 0 1 6 0V9" />
              </svg>
              {l["landing.tryOwnerNote"]}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

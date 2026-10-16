"use client";
/**
 * "Ingest store" box (owner: A6): POST /api/ingest (A10) with a store URL, then poll
 * GET /api/ingest/<jobId> for tier, progress and SKU count. Fixture mode (INGEST_FIXTURE=1) is the
 * default for the demo: no live third-party crawling.
 */
import { useEffect, useId, useRef, useState } from "react";
import { Card, Formula, HowCalculated, pct } from "./ui";

interface Job {
  id: string;
  url: string;
  status: "queued" | "running" | "done" | "error";
  progress: { phase: string; discovered: number; processed: number; skus: number; errors: number; message?: string };
  tier?: 1 | 2 | 3;
  platform?: string;
  skuCount: number;
  coverage?: { total: number; withAll3: number; ratio: number };
  extractor?: string;
  errorCount: number;
  error?: string;
}

const TIER_LABEL: Record<number, string> = { 1: "Tier 1 · platform API", 2: "Tier 2 · sitemap + JSON-LD", 3: "Tier 3 · render + extraction" };
const POLL_MS = 1000;

export function IngestBox({ fixtureMode, defaultUrl }: { fixtureMode: boolean; defaultUrl: string }) {
  const ids = { url: useId(), max: useId(), token: useId() };
  const [url, setUrl] = useState(defaultUrl);
  const [maxProducts, setMaxProducts] = useState(25);
  const [token, setToken] = useState("");
  const [needsToken, setNeedsToken] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const headers = (): HeadersInit => (token ? { Authorization: `Bearer ${token}` } : {});

  async function poll(jobId: string) {
    try {
      const res = await fetch(`/api/ingest/${encodeURIComponent(jobId)}`, { headers: headers(), cache: "no-store" });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const j = (await res.json()) as Job;
      setJob(j);
      if (j.status === "queued" || j.status === "running") timer.current = setTimeout(() => poll(jobId), POLL_MS);
      else setBusy(false);
    } catch (e) {
      setError(`Lost track of the job (${e instanceof Error ? e.message : "network"}).`);
      setBusy(false);
    }
  }

  async function start(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setJob(null);
    setBusy(true);
    try {
      const res = await fetch("/api/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers() },
        body: JSON.stringify({ url: url.trim(), maxProducts }),
      });
      const body = (await res.json().catch(() => ({}))) as { jobId?: string; error?: string };
      if (res.status === 401) {
        setNeedsToken(true);
        throw new Error("This server needs the ingest admin token.");
      }
      if (!res.ok || !body.jobId) throw new Error(body.error ?? `Ingest refused (${res.status}).`);
      await poll(body.jobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ingest failed.");
      setBusy(false);
    }
  }

  const p = job?.progress;
  const done = p ? (p.discovered ? p.processed / p.discovered : job?.status === "done" ? 1 : 0) : 0;

  return (
    <Card id="ingest" eyebrow="Auto-Ingest" title="Ingest a store" testId="ingest-box"
      badge={
        <span className="rounded-full border border-line-strong px-3 py-1 text-xs text-ink-soft">{fixtureMode ? "Fixture mode · offline" : "Allow-listed hosts only"}</span>
      }
    >
      <p className="text-sm text-ink-soft">Paste a store URL. GiftFit picks the lowest tier that works, reads public product data only and builds the catalog the Fit Engine scores.</p>
      <form onSubmit={start} className="mt-4 space-y-3">
        <label htmlFor={ids.url} className="block text-xs text-muted">
          Store URL
          <input id={ids.url} type="url" required value={url} onChange={(e) => setUrl(e.target.value)} className="mt-1 block min-h-11 w-full rounded-lg border border-line-strong bg-white px-3 text-sm text-ink" />
        </label>
        <div className="flex flex-wrap items-end gap-3">
          <label htmlFor={ids.max} className="text-xs text-muted">
            Max products
            <input id={ids.max} type="number" min={1} max={300} value={maxProducts} onChange={(e) => setMaxProducts(Math.max(1, Math.min(300, Number(e.target.value) || 1)))} className="mt-1 block min-h-11 w-28 rounded-lg border border-line-strong bg-white px-3 text-sm text-ink" />
          </label>
          {needsToken ? (
            <label htmlFor={ids.token} className="text-xs text-muted">
              Admin token
              <input id={ids.token} type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} className="mt-1 block min-h-11 w-48 rounded-lg border border-line-strong bg-white px-3 text-sm text-ink" />
            </label>
          ) : null}
          <button type="submit" disabled={busy} data-testid="ingest-start" className="min-h-11 rounded-full bg-ink px-6 text-sm font-medium text-ivory hover:bg-ink-soft disabled:opacity-60">
            {busy ? "Ingesting…" : "Ingest store"}
          </button>
        </div>
      </form>

      {error ? (
        <p role="alert" className="mt-3 rounded-lg bg-blush px-3 py-2 text-sm text-rose">
          {error}
        </p>
      ) : null}

      {job ? (
        <div className="mt-4 space-y-3" aria-live="polite" data-testid="ingest-status">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="font-medium text-ink">{job.tier ? TIER_LABEL[job.tier] : "Detecting tier…"}</span>
            <span className="text-muted">
              {job.status === "done" ? "Done" : job.status === "error" ? "Stopped" : `Phase: ${p?.phase ?? "detect"}`}
            </span>
          </div>
          <div role="progressbar" aria-label="Ingest progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(done * 100)} className="h-2.5 w-full overflow-hidden rounded-full bg-cream">
            <div className="h-full rounded-full bg-gold transition-[width] duration-500" style={{ width: `${Math.round(done * 100)}%` }} />
          </div>
          <dl className="grid grid-cols-3 gap-3 text-center">
            <div className="rounded-lg bg-cream py-2">
              <dt className="text-xs text-muted">Pages</dt>
              <dd className="font-display text-2xl text-ink">
                {p?.processed ?? 0}/{p?.discovered ?? 0}
              </dd>
            </div>
            <div className="rounded-lg bg-cream py-2">
              <dt className="text-xs text-muted">SKUs</dt>
              <dd className="font-display text-2xl text-ink" data-testid="ingest-skus">
                {job.skuCount}
              </dd>
            </div>
            <div className="rounded-lg bg-cream py-2">
              <dt className="text-xs text-muted">Complete rows</dt>
              <dd className="font-display text-2xl text-ink">{job.coverage ? pct(job.coverage.ratio) : "–"}</dd>
            </div>
          </dl>
          {job.status === "done" ? (
            <p className="text-sm text-sage">
              {job.skuCount} SKUs from {new URL(job.url).host}
              {job.platform ? ` (${job.platform})` : ""}. {job.errorCount ? `${job.errorCount} pages skipped.` : ""}
            </p>
          ) : null}
          {job.status === "error" ? <p className="text-sm text-rose">{job.error ?? "The ingest stopped."}</p> : null}
        </div>
      ) : null}

      <HowCalculated>
        <p>Tier 1 platform API → Tier 2 sitemap + JSON-LD → Tier 3 headless render + grounded extraction; the lowest tier that works wins (docs/ingest-policy.md).</p>
        <Formula>{"complete rows = SKUs with metal AND price AND images / all SKUs"}</Formula>
        <p>Politeness is enforced in code: robots.txt first, ≤ 1 request/s per host, allow-listed hosts only. In fixture mode every page comes from self-authored fixtures on reserved .test hosts.</p>
      </HowCalculated>
    </Card>
  );
}

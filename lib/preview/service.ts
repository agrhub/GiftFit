/**
 * Store-URL preview service (owner: A10; ADR-055): validation, caps, storage and the in-process crawl
 * queue behind POST /api/preview and GET /api/preview/<key>.
 *
 * Crawls run in this process (Cloud Run max 1 instance; request-based CPU, so they progress while the
 * landing polls). State is persisted at every transition; a record left `queued` / `crawling` by another
 * process (a cold start) or older than STALE_MS is reported — and stored — as `failed` / `interrupted`,
 * so a status poll never hangs. Logs carry the domain and a key prefix only: never URLs with query
 * strings, keys or tokens.
 */
import { randomBytes } from "node:crypto";
import { checkUrl, isSafeFetchError, vetHost, type Resolver, type SafeFetcherOptions } from "@/lib/ingest/safe-fetch";
import type { DailyCounterStore } from "@/lib/store/daily-counter";
import type { Env } from "@/lib/store/config";
import { defaultPreviewCounters, reservePreview } from "./caps";
import { ingestStoreUrl, PREVIEW_DEADLINE_MS, type IngestStoreOptions } from "./ingest";
import { capturePageSnapshot, type CaptureInput, type CaptureOptions, type PageSnapshotInfo, type SnapshotReason } from "./page-snapshot";
import { defaultPreviewRepo, DEFAULT_PREVIEW_SETTINGS, PREVIEW_KEY_RE, PREVIEW_TTL_MS, type PreviewRecord, type PreviewRepo } from "./repo";
import { hashOwnerToken, newOwnerToken, newPreviewKey } from "./tokens";
import type { PreviewReason, PreviewState, StoreIngestResult } from "./types";

/** A crawl still `queued`/`crawling` after this is treated as lost. */
export const STALE_MS = PREVIEW_DEADLINE_MS * 2 + 30_000;
export const MAX_CONCURRENT_CRAWLS = 2;
export const MAX_URL_LENGTH = 2048;

export interface PreviewDeps {
  repo: PreviewRepo;
  counters: DailyCounterStore;
  now: () => number;
  /** DNS for the up-front SSRF check (the crawler re-checks every hop itself). */
  resolver?: Resolver;
  /** Passed to the crawler's SafeFetcher (tests inject a transport and resolver). */
  fetcherOptions?: SafeFetcherOptions;
  ingest: (url: string, opts: IngestStoreOptions) => Promise<StoreIngestResult>;
  /** A15: store-page snapshot after a ready ingest (tests inject a fake). */
  capture: (input: CaptureInput, opts: CaptureOptions) => Promise<PageSnapshotInfo>;
  instanceId: string;
  env: Env;
}

interface ServiceState {
  instanceId: string;
  active: Map<string, Promise<void>>;
  queue: { key: string; origin: string }[];
  override?: Partial<PreviewDeps>;
}

const STATE_KEY = Symbol.for("giftfit.preview.service.v1");
function state(): ServiceState {
  const g = globalThis as typeof globalThis & { [STATE_KEY]?: ServiceState };
  return (g[STATE_KEY] ??= { instanceId: randomBytes(8).toString("hex"), active: new Map(), queue: [] });
}

export function getPreviewDeps(): PreviewDeps {
  const s = state();
  const o = s.override ?? {};
  const env = o.env ?? process.env;
  return {
    repo: o.repo ?? defaultPreviewRepo(env),
    counters: o.counters ?? defaultPreviewCounters(env),
    now: o.now ?? Date.now,
    resolver: o.resolver,
    fetcherOptions: o.fetcherOptions,
    ingest: o.ingest ?? ingestStoreUrl,
    capture: o.capture ?? capturePageSnapshot,
    instanceId: o.instanceId ?? s.instanceId,
    env,
  };
}

/** Tests: override dependencies (undefined restores the defaults and clears the queue). */
export function setPreviewDepsForTests(o: Partial<PreviewDeps> | undefined): void {
  const s = state();
  s.override = o;
  if (!o) {
    s.active.clear();
    s.queue.length = 0;
  }
}

/** Tests: wait for every queued and running crawl. */
export async function drainPreviewJobsForTests(): Promise<void> {
  const s = state();
  while (s.active.size || s.queue.length) await Promise.all([...s.active.values()]);
}

export function previewsEnabled(env: Env = process.env): boolean {
  return !/^(0|off|false|no)$/i.test(env.PREVIEW_ENABLED?.trim() ?? "");
}

export interface CreatedPreview {
  key: string;
  previewPath: string;
  statusPath: string;
  ownerPath: string;
}

export type CreateResult =
  | { ok: true; status: 202; body: CreatedPreview }
  | { ok: false; status: 400 | 429 | 503; error: "invalid_url" | "blocked_url" | "rate_limited" | "daily_cap" | "unavailable" | "disabled"; retryAfterSec?: number };

/** "shop.example.com/x" → "https://shop.example.com/x"; anything else is left for checkUrl to judge. */
export function normaliseInputUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t || t.length > MAX_URL_LENGTH) return null;
  return /^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `https://${t.replace(/^\/+/, "")}`;
}

const keyTag = (key: string) => `${key.slice(0, 6)}…`;

export async function createPreview(req: Request, rawUrl: unknown): Promise<CreateResult> {
  const deps = getPreviewDeps();
  if (!previewsEnabled(deps.env)) return { ok: false, status: 503, error: "disabled" };
  const input = normaliseInputUrl(rawUrl);
  if (!input) return { ok: false, status: 400, error: "invalid_url" };
  let url: URL;
  try {
    url = checkUrl(input);
    await vetHost(url.hostname, deps.resolver);
  } catch (err) {
    if (isSafeFetchError(err, "blocked_url")) return { ok: false, status: 400, error: "blocked_url" };
    return { ok: false, status: 400, error: "invalid_url" };
  }

  const now = deps.now();
  const cap = await reservePreview(req, deps.counters, now, deps.env);
  if (!cap.ok) return { ok: false, status: cap.error === "unavailable" ? 503 : 429, error: cap.error, retryAfterSec: cap.retryAfterSec };

  const key = newPreviewKey();
  const ownerToken = newOwnerToken();
  const rec: PreviewRecord = {
    key,
    domain: url.hostname,
    storeUrl: url.origin,
    state: "queued",
    reason: null,
    storeName: null,
    platform: null,
    currency: null,
    products: [],
    productCount: 0,
    fetches: null,
    createdAt: new Date(now),
    updatedAt: new Date(now),
    expiresAt: new Date(now + PREVIEW_TTL_MS),
    ownerTokenHash: hashOwnerToken(ownerToken),
    runner: deps.instanceId,
    settings: { ...DEFAULT_PREVIEW_SETTINGS },
  };
  try {
    await deps.repo.create(rec);
  } catch (err) {
    console.error("[preview] could not store the preview:", (err as Error).message);
    await cap.refund();
    return { ok: false, status: 503, error: "unavailable" };
  }
  enqueue(key, url.origin);
  console.info(`[preview] ${keyTag(key)} queued ${url.hostname}`);
  return {
    ok: true,
    status: 202,
    body: { key, previewPath: `/s/${key}`, statusPath: `/api/preview/${key}`, ownerPath: `/admin/${key}#t=${ownerToken}` },
  };
}

function enqueue(key: string, origin: string): void {
  state().queue.push({ key, origin });
  pump();
}

/**
 * Admin v0 re-ingest (A6): crawl an existing preview again with the same caps. The caller has already
 * reserved a preview on the daily counters (reservePreview) and checked the owner token; this marks the
 * record queued on this instance (so status polls track it) and queues the crawl. Settings are kept.
 */
export async function requeuePreviewCrawl(key: string): Promise<boolean> {
  const deps = getPreviewDeps();
  const rec = await deps.repo.get(key, deps.now());
  if (!rec || isTracked(key)) return false;
  await deps.repo.update(key, { state: "queued", reason: null, runner: deps.instanceId, updatedAt: new Date(deps.now()) });
  enqueue(key, rec.storeUrl);
  console.info(`[preview] ${keyTag(key)} re-ingest queued ${rec.domain}`);
  return true;
}

function pump(): void {
  const s = state();
  while (s.active.size < MAX_CONCURRENT_CRAWLS && s.queue.length) {
    const { key, origin } = s.queue.shift()!;
    const p = runCrawl(key, origin).finally(() => {
      s.active.delete(key);
      pump();
    });
    s.active.set(key, p);
  }
}

async function runCrawl(key: string, origin: string): Promise<void> {
  const deps = getPreviewDeps();
  const t0 = deps.now();
  try {
    await deps.repo.update(key, { state: "crawling", updatedAt: new Date(t0), runner: deps.instanceId });
    const r = await deps.ingest(origin, { fetcherOptions: { ...(deps.resolver ? { resolver: deps.resolver } : {}), ...deps.fetcherOptions }, now: deps.now });
    const stateOut: PreviewState = r.outcome;
    const snapshot = r.outcome === "ready" ? await snapshotFor(deps, key, r) : null;
    await deps.repo.update(key, {
      state: stateOut,
      reason: r.reason ?? null,
      domain: r.domain,
      storeUrl: r.origin,
      storeName: r.storeName,
      platform: r.platform,
      currency: r.currency,
      products: r.outcome === "ready" ? r.products : [],
      productCount: r.outcome === "ready" ? r.products.length : 0,
      fetches: r.fetches,
      snapshot,
      updatedAt: new Date(deps.now()),
    });
    const look = snapshot ? ` look=${snapshot.mode}${snapshot.reason ? `(${snapshot.reason})` : `(${snapshot.productPages.length} product pages)`}` : "";
    console.info(`[preview] ${keyTag(key)} ${stateOut}${r.reason ? ` (${r.reason})` : ""} ${r.domain} products=${r.products.length} fetches=${r.fetches} ${r.ms}ms${look}`);
  } catch (err) {
    console.error(`[preview] ${keyTag(key)} crawl failed:`, isSafeFetchError(err) ? err.code : (err as Error).name);
    await deps.repo.update(key, { state: "failed", reason: "internal", products: [], productCount: 0, updatedAt: new Date(deps.now()) }).catch(() => undefined);
  }
}

/** A15: the store-page snapshot of a ready ingest; never throws (a failure means the neutral template). */
async function snapshotFor(deps: PreviewDeps, key: string, r: StoreIngestResult): Promise<PageSnapshotInfo> {
  try {
    const rec = await deps.repo.get(key, deps.now());
    const expiresAt = rec?.expiresAt ?? new Date(deps.now() + PREVIEW_TTL_MS);
    const fetcherOptions = { ...(deps.resolver ? { resolver: deps.resolver } : {}), ...deps.fetcherOptions };
    return await deps.capture({ key, origin: r.origin, products: r.products, expiresAt }, { fetcherOptions, now: deps.now, env: deps.env });
  } catch (err) {
    console.error(`[preview] ${keyTag(key)} snapshot failed:`, (err as Error).name);
    return { mode: "template", reason: "storage_failed", capturedAt: new Date(deps.now()), productPages: [], bytes: 0, fetches: 0 };
  }
}

export interface PreviewStatus {
  state: PreviewState;
  domain: string;
  name?: string;
  productCount?: number;
  reason?: PreviewReason;
  /** A15: how a ready preview looks (a copy of the store page, or GiftFit's template and why). */
  look?: { mode: PageSnapshotInfo["mode"]; reason?: SnapshotReason };
}

function isTracked(key: string): boolean {
  const s = state();
  return s.active.has(key) || s.queue.some((q) => q.key === key);
}

/** Status for a key; null when unknown or expired. Lost crawls are marked failed/interrupted here. */
export async function getPreviewStatus(key: string): Promise<PreviewStatus | null> {
  if (!PREVIEW_KEY_RE.test(key)) return null;
  const deps = getPreviewDeps();
  const now = deps.now();
  let rec = await deps.repo.get(key, now);
  if (!rec) return null;
  const pending = (r: PreviewRecord) => r.state === "queued" || r.state === "crawling";
  const lost = (r: PreviewRecord) => r.runner !== deps.instanceId || !isTracked(key) || now - r.updatedAt.getTime() > STALE_MS;
  // A crawl that just finished is no longer tracked but has persisted its result: re-read before judging.
  if (pending(rec) && lost(rec)) rec = (await deps.repo.get(key, now)) ?? rec;
  let st = rec.state;
  let reason = rec.reason;
  if (pending(rec) && lost(rec)) {
    st = "failed";
    reason = "interrupted";
    await deps.repo.update(key, { state: st, reason, updatedAt: new Date(now) }).catch(() => undefined);
  }
  return {
    state: st,
    domain: rec.domain,
    ...(rec.storeName ? { name: rec.storeName } : {}),
    ...(st === "ready" ? { productCount: rec.productCount } : {}),
    ...(reason && (st === "refused" || st === "failed") ? { reason } : {}),
    ...(st === "ready" && rec.snapshot ? { look: { mode: rec.snapshot.mode, ...(rec.snapshot.reason ? { reason: rec.snapshot.reason } : {}) } } : {}),
  };
}

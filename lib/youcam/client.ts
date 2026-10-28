/**
 * Typed YouCam S2S client: upload file -> PUT presigned URL -> create task -> poll
 * (or wake on webhook) -> typed result. Every paid task goes through the CostGuard,
 * every attempt is audited, results are cached by SHA-256(image + params), and
 * YOUCAM_MOCK=1 serves fixtures with no network at all.
 *
 * Server-side only: the API key is read from the environment and never leaves this module.
 */
import { createDefaultAuditSink, defaultAuditSink, type AuditEvent, type AuditSink } from "./audit";
import { cacheKey as computeCacheKey, createDefaultResultCache, defaultResultCache, sha256Hex, type ResultCache } from "./cache";
import { globalLedger, youcamState } from "./global-state";
import { loadYoucamConfig, type JewelryBodyVariant, type YoucamConfig } from "./config";
import { parseFeatureCostPage } from "./costs";
import { CostGuard, type GuardDecision } from "./cost-guard";
import { isValidPaidGrant, logPaidCall, logPaidMode, type PaidGrant } from "./recording";
import { defaultDailyCounterStore, type DailyCounterStore } from "../store/daily-counter";
import { CostGuardError, YoucamApiError, YoucamTaskError, YoucamTimeoutError, YoucamValidationError } from "./errors";
import {
  DEFAULT_UPLOAD_PATH,
  attachFiles,
  getFeature,
  resultCacheTtlMs,
  taskPath,
  type FeatureSlug,
  type FileRef,
  type ParamsOf,
  type ResultOf,
} from "./features";
import {
  DEFAULT_RETRY,
  RateLimiter,
  realSleep,
  send,
  sendJson,
  sharedRateLimiter,
  type FetchLike,
  type RetryPolicy,
  type Sleep,
  type Transport,
} from "./http";
import { loadFixture, mockTaskId } from "./mock";
import type {
  Balance,
  ClothVtoParams,
  CreditBatch,
  FaceAttributesParams,
  FacialColorTonesParams,
  FeatureCostSku,
  FitzpatrickParams,
  HairColorParams,
  ImageInput,
  JewelryKind,
  JewelryVtoParams,
  MakeupVtoParams,
  SkinAnalysisParams,
  SkinSimulationParams,
  TaskData,
} from "./types";
import { waitForTaskSignal } from "./webhook";

export interface YoucamClientOptions {
  /** Overrides on top of the environment config. */
  config?: Partial<YoucamConfig>;
  fetch?: FetchLike;
  sleep?: Sleep;
  retry?: Partial<RetryPolicy>;
  audit?: AuditSink;
  /** null disables result caching. */
  cache?: ResultCache | null;
  now?: () => number;
  random?: () => number;
  /**
   * Durable counter for YOUCAM_DAILY_UNIT_CAP. Default: Firestore with STORE=firestore in "global" state
   * (lib/store/daily-counter.ts), else none (the in-process ledger counts). null disables.
   */
  dailyCounter?: DailyCounterStore | null;
  /** Rate limiter for API requests; defaults to the process-wide 250 req / 300 s bucket. null disables. */
  limiter?: RateLimiter | null;
  /**
   * "global" (default): the cost-guard ledger, default audit sink and default cache are the
   * process-wide ones on globalThis (ADR-023), shared by every client and route bundle.
   * "isolated": this client gets its own ledger and fresh defaults (tests, scripts).
   */
  state?: "global" | "isolated";
  /**
   * A16 owner-recording switch: every paid task needs a valid `RunOptions.paidGrant` (lib/youcam/recording.ts),
   * else it is refused before the cost guard ("recording_off"). The shared server client (getYoucamClient) sets
   * it; scripts that build their own client keep the cost guard alone.
   */
  requirePaidGrant?: boolean;
}

export interface RunOptions {
  /** Use and fill the result cache (default true). */
  cache?: boolean;
  /** Jewelry body variant for this call (default: config.jewelryBodyVariant). */
  jewelryBodyVariant?: JewelryBodyVariant;
  /** Owner-recording grant for a paid task (required when the client has requirePaidGrant). Ignored in mock mode. */
  paidGrant?: PaidGrant;
}

export interface RunResult<R> {
  feature: FeatureSlug;
  taskId: string;
  result: R;
  /** Served from the SHA-256 result cache (0 units). */
  cached: boolean;
  /** Served from fixtures (YOUCAM_MOCK). */
  mock: boolean;
  /** Mock result came from a hand-made synthetic fixture rather than a recorded real run. */
  synthetic: boolean;
  unitsCharged: number;
  /** Price of this task (live price in real mode, 2026-10-15 snapshot in mock mode). */
  unitsExpected?: number;
  cacheKey: string;
  durationMs: number;
}

export type TaskDeleteResult =
  | { taskId: string; ok: true; alreadyGone?: boolean }
  | { taskId: string; ok: false; code: string };

export interface PurgeResult {
  cacheKeysPurged: number;
  tasks: TaskDeleteResult[];
  /** false when at least one task delete failed (e.g. OperationInvalid: still running). */
  ok: boolean;
}

/** One entry of GET /s2s/v1.0/client/credit/history. */
export interface CreditHistoryEntry {
  id?: number;
  timestamp?: number;
  action?: string;
  /** Usually the task id the movement belongs to. */
  target_id?: string;
  info?: { credits?: unknown; [key: string]: unknown };
  [key: string]: unknown;
}

export interface PlanItem<F extends FeatureSlug = FeatureSlug> {
  feature: F;
  params: ParamsOf<F>;
}

interface UploadResponse {
  data?: {
    files?: Array<{
      file_id?: string;
      requests?: Array<{ url?: string; method?: string; headers?: Record<string, string> }>;
    }>;
  };
}

export class YoucamClient {
  readonly config: YoucamConfig;
  readonly guard: CostGuard;
  readonly audit: AuditSink;
  readonly cache: ResultCache | null;
  readonly requirePaidGrant: boolean;
  private readonly transport: Transport;
  private readonly now: () => number;

  constructor(opts: YoucamClientOptions = {}) {
    this.config = { ...loadYoucamConfig(), ...(opts.config ?? {}) };
    if (this.config.mock) this.config.allowPaid = false;
    this.now = opts.now ?? Date.now;
    this.requirePaidGrant = opts.requirePaidGrant === true;
    this.transport = {
      fetch: opts.fetch ?? ((input, init) => fetch(input, init)),
      sleep: opts.sleep ?? realSleep,
      retry: { ...DEFAULT_RETRY, ...(opts.retry ?? {}) },
      random: opts.random,
      limiter: opts.limiter === undefined ? sharedRateLimiter() : (opts.limiter ?? undefined),
    };
    const global = opts.state !== "isolated";
    this.audit = opts.audit ?? (global ? defaultAuditSink(this.config) : createDefaultAuditSink(this.config));
    this.cache = opts.cache !== undefined ? opts.cache : global ? defaultResultCache(this.config) : createDefaultResultCache(this.config);
    this.guard = new CostGuard({
      allowPaid: this.config.allowPaid,
      hasApiKey: Boolean(this.config.apiKey) && !this.config.mock,
      reserveUnits: this.config.reserveUnits,
      maxUnitsPerRun: this.config.maxUnitsPerRun,
      dailyUnitCap: this.config.dailyUnitCap,
      totalUnitCap: this.config.totalUnitCap,
      audit: this.audit,
      fetchBalance: () => this.getBalance(),
      fetchFeatureCosts: () => this.getFeatureCosts(),
      now: this.now,
      ledger: global ? globalLedger() : undefined,
      dailyCounter: (opts.dailyCounter === undefined ? (global ? defaultDailyCounterStore() : undefined) : opts.dailyCounter) ?? undefined,
    });
  }

  get mode(): "mock" | "real" {
    return this.config.mock ? "mock" : "real";
  }

  // ---------- transport ----------

  private authHeaders(): Record<string, string> {
    if (!this.config.apiKey) throw new YoucamValidationError("YOUCAM_API_KEY is not set");
    // Content-Type on every API call, GETs included: /s2s/v1.0/client/credit/history answers
    // 415 "Content type '' not supported" without it (found on the first real smoke, ADR-026).
    return { Authorization: `Bearer ${this.config.apiKey}`, "Content-Type": "application/json" };
  }

  private assertNetworkAllowed(what: string): void {
    if (this.config.mock) throw new YoucamValidationError(`${what}: no network calls in mock mode (YOUCAM_MOCK=1)`);
  }

  private api<T>(method: "GET" | "POST", pathAndQuery: string, json?: unknown): Promise<T> {
    return sendJson<T>(this.transport, {
      method,
      url: `${this.config.baseUrl}${pathAndQuery}`,
      headers: this.authHeaders(),
      json,
      idempotent: method === "GET",
      endpoint: `${method} ${pathAndQuery.split("?")[0]}`,
    });
  }

  // ---------- free account endpoints ----------

  /** GET /s2s/v1.0/client/credit (free). Spendable units = batches whose type starts with "Api". */
  async getBalance(): Promise<Balance> {
    this.assertNetworkAllowed("getBalance");
    const json = await this.api<{ results?: CreditBatch[] }>("GET", "/s2s/v1.0/client/credit");
    const byType: Record<string, number> = {};
    let units = 0;
    for (const b of json.results ?? []) {
      const amount = Number(b.amount_dec ?? b.amount ?? 0);
      const type = b.type ?? "?";
      byType[type] = (byType[type] ?? 0) + amount;
      if (type.startsWith("Api")) units += amount;
    }
    return { units, byType };
  }

  /** GET /s2s/v2.0/credit/feature-cost, all pages (free). */
  async getFeatureCosts(): Promise<FeatureCostSku[]> {
    this.assertNetworkAllowed("getFeatureCosts");
    const all: FeatureCostSku[] = [];
    let token: string | undefined;
    for (let page = 0; page < 50; page++) {
      const q = new URLSearchParams({ page_size: "20" });
      if (token) q.set("starting_token", token);
      const { skus, nextToken } = parseFeatureCostPage(await this.api("GET", `/s2s/v2.0/credit/feature-cost?${q}`));
      all.push(...skus);
      if (!nextToken) break;
      token = nextToken;
    }
    return all;
  }

  // ---------- low-level task API ----------

  /**
   * One POST /s2s/v2.0/file listing every image, then a PUT of each to its presigned URL
   * (with the returned headers). Free. Returns file_ids in input order. In mock mode it
   * returns deterministic fake ids without any network call.
   */
  async uploadFiles(
    imgs: ReadonlyArray<Extract<ImageInput, { bytes: Uint8Array }>>,
    uploadPath: string = DEFAULT_UPLOAD_PATH,
  ): Promise<string[]> {
    if (imgs.length === 0) return [];
    if (this.config.mock) return imgs.map((img) => `mock_file_${sha256Hex(img.bytes).slice(0, 16)}`);
    const meta = await this.api<UploadResponse>("POST", uploadPath, {
      files: imgs.map((img, i) => ({
        content_type: img.contentType,
        file_name: img.fileName ?? `image${imgs.length > 1 ? `-${i + 1}` : ""}.${img.contentType === "image/png" ? "png" : "jpg"}`,
        file_size: img.bytes.byteLength,
      })),
    });
    const files = meta.data?.files ?? [];
    const ids: string[] = [];
    for (let i = 0; i < imgs.length; i++) {
      const file = files[i];
      const put = file?.requests?.[0];
      if (!file?.file_id || !put?.url) {
        throw new YoucamApiError("YouCam upload response has no file_id or presigned URL", 502, undefined, `POST ${uploadPath}`);
      }
      // Send exactly the returned headers, minus Content-Length (fetch derives it from the body).
      const headers = Object.fromEntries(
        Object.entries(put.headers ?? { "Content-Type": imgs[i].contentType }).filter(([k]) => k.toLowerCase() !== "content-length"),
      );
      await send(this.transport, {
        method: "PUT",
        url: put.url,
        headers,
        body: imgs[i].bytes as unknown as BodyInit,
        idempotent: true,
        endpoint: "PUT presigned upload",
        rateLimited: false,
      });
      ids.push(file.file_id);
    }
    return ids;
  }

  /** Single-image form of uploadFiles(). */
  async uploadFile(img: Extract<ImageInput, { bytes: Uint8Array }>, uploadPath?: string): Promise<string> {
    return (await this.uploadFiles([img], uploadPath))[0];
  }

  /** Uploads every byte image that has no fileId yet and returns copies with fileId set. */
  async uploadImages<T extends ImageInput>(imgs: readonly T[]): Promise<T[]> {
    const pending = imgs.filter((i): i is T & Extract<ImageInput, { bytes: Uint8Array }> => "bytes" in i && !i.fileId);
    const ids = await this.uploadFiles(pending);
    return imgs.map((img) => {
      const k = pending.indexOf(img as never);
      return k >= 0 ? { ...img, fileId: ids[k] } : img;
    });
  }

  private async createTask(feature: FeatureSlug, body: Record<string, unknown>): Promise<string> {
    const spec = getFeature(feature);
    const json = await this.api<{ data?: { task_id?: string } }>("POST", taskPath(spec), body);
    const id = json.data?.task_id;
    if (!id) throw new YoucamApiError(`YouCam ${feature} task response has no task_id`, 502, undefined, `POST ${taskPath(spec)}`);
    return id;
  }

  /** GET /task/<slug>/<task_id> once (free). */
  async getTask<F extends FeatureSlug>(feature: F, taskId: string): Promise<TaskData<ResultOf<F>>> {
    this.assertNetworkAllowed("getTask");
    const spec = getFeature(feature);
    const json = await this.api<{ data?: TaskData<ResultOf<F>> }>("GET", `${taskPath(spec)}/${encodeURIComponent(taskId)}`);
    if (!json.data?.task_status) {
      throw new YoucamApiError(`YouCam ${feature} status response has no task_status`, 502, undefined, `GET ${taskPath(spec)}`);
    }
    return json.data;
  }

  /**
   * POST /s2s/v2.0/task/delete (free): deletes a finished task with its inputs and
   * outputs on YouCam's side. Used by "Delete my face data" (A5).
   */
  async deleteTask(taskId: string): Promise<void> {
    if (this.config.mock || taskId.startsWith("mock_")) return; // mock tasks exist nowhere
    await this.api("POST", "/s2s/v2.0/task/delete", { task_id: taskId });
  }

  /**
   * Deletes several YouCam tasks (free). Never throws: each id gets its own outcome.
   * An unknown or expired task id (InvalidTaskId, HTTP 400/404) counts as already gone.
   */
  async deleteTasks(taskIds: readonly string[]): Promise<TaskDeleteResult[]> {
    const out: TaskDeleteResult[] = [];
    for (const taskId of new Set(taskIds)) {
      try {
        await this.deleteTask(taskId);
        out.push({ taskId, ok: true });
      } catch (err) {
        const code = err instanceof YoucamApiError ? (err.code ?? String(err.status)) : (err as Error).name;
        const gone = err instanceof YoucamApiError && (err.code === "InvalidTaskId" || err.status === 404);
        out.push(gone ? { taskId, ok: true, alreadyGone: true } : { taskId, ok: false, code });
      }
    }
    return out;
  }

  /** Removes entries from the SHA-256 result cache. Returns how many keys were processed. */
  async purgeCacheKeys(keys: readonly string[]): Promise<number> {
    if (!this.cache) return 0;
    const unique = [...new Set(keys)].filter((k) => /^[a-f0-9]{64}$/.test(k));
    for (const k of unique) await this.cache.delete(k);
    return unique.length;
  }

  /**
   * Privacy purge for one Fit Request ("delete everything", A5): drops the cached results
   * and deletes the YouCam tasks. Free; works in mock mode (no network). Audited with counts only.
   */
  async purge(input: { cacheKeys?: readonly string[]; taskIds?: readonly string[] }): Promise<PurgeResult> {
    const cacheKeysPurged = await this.purgeCacheKeys(input.cacheKeys ?? []);
    const tasks = await this.deleteTasks(input.taskIds ?? []);
    const failed = tasks.filter((t) => !t.ok);
    await this.writeAudit({
      event: "youcam.purge",
      mode: this.mode,
      detail: { cacheKeys: cacheKeysPurged, tasks: tasks.length, tasksFailed: failed.length },
    });
    return { cacheKeysPurged, tasks, ok: failed.length === 0 };
  }

  /** GET /s2s/v1.0/client/credit/history (free): recent unit movements, for reconciliation. */
  async getCreditHistory(pageSize = 10): Promise<CreditHistoryEntry[]> {
    this.assertNetworkAllowed("getCreditHistory");
    const json = await this.api<{ result?: { history?: CreditHistoryEntry[] } }>(
      "GET",
      `/s2s/v1.0/client/credit/history?page_size=${Math.max(1, Math.min(pageSize, 100))}`,
    );
    return json.result?.history ?? [];
  }

  /**
   * Polls until success/error. Between polls it waits pollIntervalMs, or less when the
   * webhook route reports the task finished. Throws YoucamTimeoutError after maxPolls.
   */
  async waitForTask<F extends FeatureSlug>(
    feature: F,
    taskId: string,
    opts: { intervalMs?: number; maxPolls?: number } = {},
  ): Promise<TaskData<ResultOf<F>>> {
    const interval = opts.intervalMs ?? this.config.pollIntervalMs;
    const maxPolls = opts.maxPolls ?? this.config.maxPolls;
    for (let i = 0; i < maxPolls; i++) {
      const data = await this.getTask(feature, taskId);
      if (data.task_status === "success" || data.task_status === "error") return data;
      if (i < maxPolls - 1) await waitForTaskSignal(taskId, interval, this.transport.sleep);
    }
    throw new YoucamTimeoutError(`YouCam ${feature} task ${taskId} still running after ${maxPolls} polls`, feature, taskId);
  }

  // ---------- high-level ----------

  /** Price of one task from the 2026-10-15 snapshot (no network). Validates params. */
  estimateUnits<F extends FeatureSlug>(feature: F, params: ParamsOf<F>): number | undefined {
    const spec = getFeature(feature);
    spec.buildBody(params);
    return this.guard.estimate(feature, spec.tier(params));
  }

  /** Cost-guard decision for a plan of tasks, using only free GETs. Never creates a task. */
  async preflight(items: ReadonlyArray<PlanItem>): Promise<GuardDecision> {
    const planned = items.map((i) => {
      const spec = getFeature(i.feature);
      spec.buildBody(i.params as never);
      return { feature: i.feature, tier: spec.tier(i.params as never) };
    });
    return this.guard.preflight(planned);
  }

  private async writeAudit(partial: Omit<AuditEvent, "ts">): Promise<void> {
    try {
      await this.audit.write({ ts: new Date(this.now()).toISOString(), ...partial });
    } catch (err) {
      console.error("[youcam] audit write failed:", (err as Error).message);
    }
  }

  private async resolveFile(img: ImageInput, uploadPath?: string): Promise<FileRef> {
    if ("url" in img) return { kind: "url", value: img.url };
    if (img.fileId) return { kind: "id", value: img.fileId };
    return { kind: "id", value: await this.uploadFile(img, uploadPath) };
  }

  /** Runs one feature end to end. See RunResult for how the result was produced. */
  async run<F extends FeatureSlug>(
    feature: F,
    src: ImageInput,
    params: ParamsOf<F>,
    opts: RunOptions = {},
  ): Promise<RunResult<ResultOf<F>>> {
    const started = this.now();
    const spec = getFeature(feature);
    const body = spec.buildBody(params);
    const refs = spec.refs(params);
    const tier = spec.tier(params);
    const objectParameter = spec.objectParameter?.(params);
    const key = computeCacheKey({ feature, version: spec.version, src, refs, body: { body, objectParameter } });
    const useCache = opts.cache !== false && this.cache !== null;
    const base = { feature, cacheKey: key } as const;

    if (this.config.mock) {
      const fx = await loadFixture<ResultOf<F>>(this.config.fixturesDir, feature);
      if (this.config.mockLatencyMs > 0) await this.transport.sleep(this.config.mockLatencyMs);
      const unitsExpected = this.guard.estimate(feature, tier);
      const taskId = mockTaskId(feature, key);
      await this.writeAudit({
        event: "youcam.attempt",
        mode: "mock",
        feature,
        decision: "mock",
        unitsExpected,
        unitsCharged: 0,
        taskId,
        cacheKey: key,
        detail: { fixture: fx.synthetic ? "synthetic" : "real" },
      });
      if (fx.data.task_status !== "success" || fx.data.results === undefined) {
        throw new YoucamTaskError(
          `YouCam ${feature} (mock) failed: ${fx.data.error ?? fx.data.task_status}`,
          feature,
          taskId,
          fx.data.error,
        );
      }
      return {
        ...base,
        taskId,
        result: fx.data.results,
        cached: false,
        mock: true,
        synthetic: fx.synthetic,
        unitsCharged: 0,
        unitsExpected,
        durationMs: this.now() - started,
      };
    }

    if (useCache) {
      const hit = await this.cache!.get<ResultOf<F>>(key);
      if (hit) {
        await this.writeAudit({
          event: "youcam.attempt",
          mode: "real",
          feature,
          decision: "cache_hit",
          unitsCharged: 0,
          taskId: hit.taskId,
          cacheKey: key,
        });
        return {
          ...base,
          taskId: hit.taskId,
          result: hit.result,
          cached: true,
          mock: false,
          synthetic: false,
          unitsCharged: 0,
          durationMs: this.now() - started,
        };
      }
    }

    if (this.requirePaidGrant && !isValidPaidGrant(opts.paidGrant, this.now())) {
      // A16: no owner-recording grant, no paid task. Audited like any other refusal; nothing is reserved.
      const unitsExpected = this.guard.estimate(feature, tier);
      await this.writeAudit({ event: "youcam.attempt", mode: "real", feature, decision: "refused", reason: "recording_off", unitsExpected, cacheKey: key });
      throw new CostGuardError(`YouCam call refused: owner recording is off for this request (${feature})`, "recording_off", feature, unitsExpected);
    }
    const reservation = await this.guard.authorize(feature, tier, key);
    if (opts.paidGrant) logPaidCall({ feature, units: reservation.units, dayUnits: this.guard.unitsToday, dailyUnitCap: this.config.dailyUnitCap });
    let taskId: string | undefined;
    try {
      const srcRef = await this.resolveFile(src, spec.uploadPath);
      const refRefs: FileRef[] = [];
      for (const r of refs) refRefs.push(await this.resolveFile(r, spec.uploadPath));
      const variant = opts.jewelryBodyVariant ?? this.config.jewelryBodyVariant;
      taskId = await this.createTask(feature, attachFiles(spec.refMode, body, srcRef, refRefs, objectParameter, variant));
      const data = await this.waitForTask(feature, taskId);
      if (data.task_status !== "success" || data.results === undefined) {
        throw new YoucamTaskError(
          `YouCam ${feature} task ${taskId} failed: ${data.error ?? "unknown error"}${data.error_message ? ` (${data.error_message})` : ""}`,
          feature,
          taskId,
          data.error,
        );
      }
      await this.guard.settle(reservation, { status: "success", taskId });
      if (useCache) {
        try {
          await this.cache!.set(key, {
            feature,
            taskId,
            result: data.results,
            unitsCharged: reservation.units,
            createdAt: new Date(this.now()).toISOString(),
            expiresAt: new Date(this.now() + resultCacheTtlMs(feature)).toISOString(),
          });
        } catch (err) {
          console.error("[youcam] result cache write failed:", (err as Error).message);
        }
      }
      return {
        ...base,
        taskId,
        result: data.results,
        cached: false,
        mock: false,
        synthetic: false,
        unitsCharged: reservation.units,
        unitsExpected: reservation.units,
        durationMs: this.now() - started,
      };
    } catch (err) {
      if (err instanceof YoucamTimeoutError) {
        await this.guard.settle(reservation, { status: "timeout", taskId });
      } else {
        await this.guard.settle(reservation, {
          status: "error",
          taskId,
          detail: { error: err instanceof YoucamTaskError ? err.engineError : (err as Error).name },
        });
      }
      throw err;
    }
  }

  // ---------- typed convenience wrappers ----------

  /** AI Skin Analysis v2.1, format=json. Default: 16 HD concerns (22 units). */
  skinAnalysis(img: ImageInput, params: SkinAnalysisParams = {}, opts?: RunOptions) {
    return this.run("skin-analysis", img, params, opts);
  }

  /** AI Fitzpatrick Skin Type (10 units). */
  fitzpatrick(img: ImageInput, params: FitzpatrickParams = {}, opts?: RunOptions) {
    return this.run("fitzpatrick-scale-analyzer", img, params, opts);
  }

  /** AI Facial Color Tones (slug skin-tone-analysis, 20 units). */
  facialColorTones(img: ImageInput, params: FacialColorTonesParams = {}, opts?: RunOptions) {
    return this.run("skin-tone-analysis", img, params, opts);
  }

  /** AI Face Attributes & Ratio. Default: GiftFit's 5 features (10 units); more than 5 needs allowHigherTier. */
  faceAttributes(img: ImageInput, params: FaceAttributesParams = {}, opts?: RunOptions) {
    return this.run("face-attr-analysis", img, params, opts);
  }

  /** AI Skin Simulation (4 units for 1-4 concerns, 6 for 5-10). */
  skinSimulation(img: ImageInput, params: SkinSimulationParams, opts?: RunOptions) {
    return this.run("skin-simulation", img, params, opts);
  }

  /** AI Makeup VTO (1 unit). */
  makeupVto(img: ImageInput, params: MakeupVtoParams, opts?: RunOptions) {
    return this.run("makeup-vto", img, params, opts);
  }

  /** AI Hair Color VTO (1 unit). */
  hairColorVto(img: ImageInput, params: HairColorParams, opts?: RunOptions) {
    return this.run("hair-color", img, params, opts);
  }

  /** AI Clothes VTO v4 (2 units). */
  clothVto(img: ImageInput, params: ClothVtoParams, opts?: RunOptions) {
    return this.run("cloth-v4", img, params, opts);
  }

  /**
   * AI Earrings / Necklace / Ring / Bracelet / Watch VTO (1 unit; stacked 2).
   * `img` is a face photo for earring/necklace and a back-of-hand/wrist photo for ring/bracelet/watch.
   */
  jewelryVto(kind: JewelryKind, img: ImageInput, params: JewelryVtoParams, opts?: RunOptions) {
    return this.run(`2d-vto/${kind}` as const, img, params, opts);
  }
}

export function createYoucamClient(opts: YoucamClientOptions = {}): YoucamClient {
  return new YoucamClient(opts);
}

/**
 * Process-wide client for route handlers (lazy; reads env on first use). Kept on globalThis
 * (ADR-023) so every Next.js route bundle gets the same client, guard ledger and rate limiter.
 */
export function getYoucamClient(): YoucamClient {
  const state = youcamState();
  if (!state.client) {
    // A16: the server never pays without an owner-recording grant.
    state.client = new YoucamClient({ requirePaidGrant: true });
    logPaidMode("youcam client");
  }
  return state.client;
}

/** Test helper: drop the shared client so the next call re-reads the environment. */
export function resetYoucamClient(): void {
  delete youcamState().client;
}

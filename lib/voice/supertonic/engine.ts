/**
 * Server-side Supertonic 3 engine (owner: A13, ADR-057 spike). onnxruntime-node on the CPU, stock voice
 * M1, Supertonic's 31 languages.
 *
 * - Lazy: nothing loads at boot. The first voice request calls `ensureLoaded()`, which starts loading in
 *   the background and answers nothing itself. Until the engine is ready, callers use Google TTS.
 * - One synthesis at a time: a promise-chain mutex. Callers wait in a FIFO queue; `queued()` lets the
 *   route send a request to Google instead of making it wait behind too many others.
 * - Abortable between model runs (the per-sentence budget aborts a slow sentence).
 * - Metrics for /api/voice/metrics: load time, state, queue, per-synthesis timings and real-time
 *   factor. Never any text or audio.
 *
 * Weights: the pinned files already in the image (public/voice/supertonic/aafc6e32/, see weights.ts),
 * reassembled from their parts and sha256-checked before a session is created from the bytes.
 */
import { SUPERTONIC_VOICE } from "../assets";
import { SupertonicSynth, SynthAbortedError, voiceStyle, type OrtLike, type Sessions, type Style, type SupertonicConfig, type SupertonicLang, type VoiceStyleJson } from "./inference";
import { readVerified, SERVER_FILES, weightsDir, type PinnedFile, type ReadFileFn } from "./weights";

export type EngineState = "idle" | "loading" | "ready" | "failed";

export interface LoadedModel {
  synth: SupertonicSynth;
  style: Style;
}

export interface EngineOptions {
  threads: number;
  steps: number;
  speed?: number;
  /** Loads the model (default: onnxruntime-node + the verified weights). Tests inject a fake. */
  load?: () => Promise<LoadedModel>;
  now?: () => number;
  log?: (line: string) => void;
}

const SAMPLE_WINDOW = 200;

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

export interface SynthesisResult {
  /** Mono float PCM at `sampleRate` (sentences joined with short silences). */
  pcm: Float32Array;
  sampleRate: number;
  sentences: number;
  /** Time spent waiting for the engine (mutex). */
  queueMs: number;
  /** Model time for all sentences. */
  synthMs: number;
  /** Per-sentence model time. */
  sentenceMs: number[];
}

export interface SynthesizeOptions {
  /** Per-sentence budget in ms (0 = none). The first sentence's clock starts at enqueue time. */
  budgetMs?: number;
  /** Seconds of silence between sentences. */
  gapSec?: number;
}

export class SupertonicServer {
  private stateValue: EngineState = "idle";
  private model: LoadedModel | null = null;
  private loading: Promise<void> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private waiting = 0;
  private running = false;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly stats = {
    loadStartedAt: null as number | null,
    loadMs: null as number | null,
    lastErrorCode: null as string | null,
    requests: 0,
    sentences: 0,
    aborted: 0,
    failures: 0,
    maxQueued: 0,
    synthMs: [] as number[],
    rtf: [] as number[],
    queueMs: [] as number[],
  };

  constructor(private readonly opts: EngineOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((l) => console.info(l));
  }

  get state(): EngineState {
    return this.stateValue;
  }

  /** Requests currently waiting for the engine (not counting the one running). */
  queued(): number {
    return this.waiting;
  }

  busy(): boolean {
    return this.running;
  }

  /** Requests ahead of a newcomer: the one running plus those waiting. */
  pending(): number {
    return this.waiting + (this.running ? 1 : 0);
  }

  /** Starts loading in the background if not loaded yet (or retries after a failure). Never throws. */
  ensureLoaded(): void {
    if (this.stateValue === "ready" || this.stateValue === "loading") return;
    this.stateValue = "loading";
    const t0 = this.now();
    this.stats.loadStartedAt = t0;
    this.loading = (this.opts.load ?? (() => loadModel(this.opts)))()
      .then((m) => {
        this.model = m;
        this.stats.loadMs = this.now() - t0;
        this.stateValue = "ready";
        this.log(`[voice] supertonic-server loaded ms=${this.stats.loadMs} threads=${this.opts.threads} steps=${this.opts.steps}`);
      })
      .catch((err: unknown) => {
        this.stateValue = "failed";
        this.stats.lastErrorCode = errorCode(err);
        this.log(`[voice] supertonic-server load failed code=${this.stats.lastErrorCode} ms=${this.now() - t0}`);
      });
  }

  /** Resolves true once ready (false on failure or timeout). For the spike's forced mode. */
  async waitReady(timeoutMs: number): Promise<boolean> {
    this.ensureLoaded();
    if (this.stateValue === "ready") return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.loading, new Promise((r) => (timer = setTimeout(r, timeoutMs)))]);
    clearTimeout(timer);
    return this.state === "ready";
  }

  /** One request's sentences, synthesised one after another while holding the engine. */
  async synthesize(sentences: string[], lang: SupertonicLang, o: SynthesizeOptions = {}): Promise<SynthesisResult> {
    if (this.stateValue !== "ready" || !this.model) throw new EngineNotReadyError();
    const enqueuedAt = this.now();
    this.waiting += 1;
    this.stats.maxQueued = Math.max(this.stats.maxQueued, this.waiting);
    const run = this.chain.then(async () => {
      this.waiting -= 1;
      this.running = true;
      try {
        return await this.runLocked(sentences, lang, enqueuedAt, o);
      } finally {
        this.running = false;
      }
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async runLocked(sentences: string[], lang: SupertonicLang, enqueuedAt: number, o: SynthesizeOptions): Promise<SynthesisResult> {
    const model = this.model!;
    const startedAt = this.now();
    const queueMs = startedAt - enqueuedAt;
    const budget = o.budgetMs ?? 0;
    const gap = Math.floor((o.gapSec ?? 0.25) * model.synth.sampleRate);
    const pieces: Float32Array[] = [];
    const sentenceMs: number[] = [];
    this.stats.requests += 1;
    try {
      for (let i = 0; i < sentences.length; i++) {
        const s0 = this.now();
        const ctrl = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        if (budget > 0) {
          // The first sentence's budget includes the time spent in the queue.
          const left = budget - (i === 0 ? s0 - enqueuedAt : 0);
          if (left <= 0) throw new SynthAbortedError();
          timer = setTimeout(() => ctrl.abort(), left);
        }
        try {
          const pcm = await model.synth.infer(sentences[i], lang, model.style, { steps: this.opts.steps, speed: this.opts.speed, signal: ctrl.signal });
          if (pieces.length) pieces.push(new Float32Array(gap));
          pieces.push(pcm);
        } finally {
          clearTimeout(timer);
        }
        sentenceMs.push(this.now() - s0);
        this.stats.sentences += 1;
      }
    } catch (err) {
      if (err instanceof SynthAbortedError) this.stats.aborted += 1;
      else {
        this.stats.failures += 1;
        this.stats.lastErrorCode = errorCode(err);
      }
      throw err;
    }
    const pcm = concat(pieces);
    const synthMs = this.now() - startedAt;
    const audioMs = (pcm.length / model.synth.sampleRate) * 1000;
    push(this.stats.synthMs, synthMs);
    push(this.stats.queueMs, queueMs);
    if (audioMs > 0) push(this.stats.rtf, synthMs / audioMs);
    return { pcm, sampleRate: model.synth.sampleRate, sentences: sentences.length, queueMs, synthMs, sentenceMs };
  }

  /** Numbers only (no text, no audio). */
  metrics() {
    const sorted = (a: number[]) => [...a].sort((x, y) => x - y);
    const synth = sorted(this.stats.synthMs);
    const rtf = sorted(this.stats.rtf);
    const queue = sorted(this.stats.queueMs);
    return {
      state: this.stateValue,
      threads: this.opts.threads,
      steps: this.opts.steps,
      loadMs: this.stats.loadMs,
      loadStartedAt: this.stats.loadStartedAt,
      lastErrorCode: this.stats.lastErrorCode,
      requests: this.stats.requests,
      sentences: this.stats.sentences,
      aborted: this.stats.aborted,
      failures: this.stats.failures,
      queue: { waiting: this.waiting, running: this.running, maxQueued: this.stats.maxQueued },
      synthMs: { p50: percentile(synth, 50), p95: percentile(synth, 95), n: synth.length },
      queueMs: { p50: percentile(queue, 50), p95: percentile(queue, 95) },
      rtf: { p50: percentile(rtf, 50), p95: percentile(rtf, 95) },
    };
  }
}

export class EngineNotReadyError extends Error {
  constructor() {
    super("supertonic engine not ready");
    this.name = "EngineNotReadyError";
  }
}

function push(a: number[], v: number) {
  a.push(v);
  if (a.length > SAMPLE_WINDOW) a.shift();
}

function concat(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function errorCode(err: unknown): string {
  const e = err as { code?: unknown; name?: unknown };
  if (typeof e?.code === "string" || typeof e?.code === "number") return String(e.code).slice(0, 40);
  return typeof e?.name === "string" ? e.name.slice(0, 40) : "unknown";
}

// ---- default loader (onnxruntime-node + verified weights) -------------------------------------------

export async function loadModel(o: Pick<EngineOptions, "threads">, deps: { ort?: OrtLike; dir?: string; read?: ReadFileFn; files?: Record<string, PinnedFile> } = {}): Promise<LoadedModel> {
  const files = deps.files ?? SERVER_FILES;
  const ort = deps.ort ?? (await importOrt());
  const dir = deps.dir ?? weightsDir();
  const json = async <T>(rel: string) => JSON.parse((await readVerified(dir, rel, files[rel], deps.read)).toString("utf8")) as T;
  const cfg = await json<SupertonicConfig>("onnx/tts.json");
  const indexer = Int32Array.from(await json<number[]>("onnx/unicode_indexer.json"));
  const style = voiceStyle(ort, await json<VoiceStyleJson>(`voice_styles/${SUPERTONIC_VOICE}.json`));
  const sessionOptions = {
    executionProviders: ["cpu"],
    intraOpNumThreads: o.threads,
    interOpNumThreads: 1,
    executionMode: "sequential",
    graphOptimizationLevel: "all",
  };
  // One file at a time, so at most one model's bytes (≤ 245 MiB) are held next to the sessions.
  const session = async (rel: string) => ort.InferenceSession.create(await readVerified(dir, rel, files[rel], deps.read), sessionOptions);
  const sessions: Sessions = {
    durationPredictor: await session("onnx/duration_predictor.onnx"),
    textEncoder: await session("onnx/text_encoder.onnx"),
    vectorEstimator: await session("onnx/vector_estimator.onnx"),
    vocoder: await session("onnx/vocoder.onnx"),
  };
  return { synth: new SupertonicSynth(ort, cfg, indexer, sessions), style };
}

async function importOrt(): Promise<OrtLike> {
  // CJS interop: in Next's server bundle the package may sit under `default`.
  const mod = (await import("onnxruntime-node")) as unknown as OrtLike & { default?: OrtLike };
  const ort = mod.InferenceSession ? mod : mod.default;
  if (!ort?.InferenceSession) throw new Error("onnxruntime-node: InferenceSession not found");
  return ort;
}

// ---- process-wide instance -------------------------------------------------------------------------

const KEY = Symbol.for("giftfit.voice.supertonic-server.v1");

/** The process's engine (created on first use, never loaded until ensureLoaded()). */
export function supertonicServer(opts: EngineOptions): SupertonicServer {
  const g = globalThis as typeof globalThis & { [KEY]?: SupertonicServer };
  return (g[KEY] ??= new SupertonicServer(opts));
}

/** The engine if it was ever created in this process (metrics), without creating it. */
export function existingSupertonicServer(): SupertonicServer | undefined {
  return (globalThis as typeof globalThis & { [KEY]?: SupertonicServer })[KEY];
}

/** Tests: drop the process-wide engine. */
export function resetSupertonicServer(): void {
  delete (globalThis as typeof globalThis & { [KEY]?: SupertonicServer })[KEY];
}

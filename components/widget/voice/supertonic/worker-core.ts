/**
 * The Supertonic voice worker's logic (owner: A4, P8.3), separate from the Worker entry so it is
 * unit-tested with a fake onnxruntime and fake fetch/Cache Storage.
 *
 *   init   → manifest → weights (cache, or network when allowed) verified → ORT sessions (WebGPU, then
 *            WASM on failure) → "ready" with timings
 *   synth  → one request at a time (a queue); "drop" skips a request that has not started
 *   cancel → aborts a running download; a session being created is released when it finishes
 */
import { MODEL_FILES, REQUIRED_FILES, CACHE_NAME, totalBytes } from "./manifest";
import { SupertonicTTS, voiceStyle, type OrtLike, type OrtSession, type Sessions, type Style, type SupertonicConfig, type VoiceStyleJson } from "./inference";
import type { ExecutionProvider, FromWorker, ToWorker } from "./protocol";
import { fetchWeights, loadManifest, sha256Hex, WeightsError, type CacheLike } from "./weights";

export interface WorkerDeps {
  post(msg: FromWorker, transfer?: Transferable[]): void;
  importOrt(url: string): Promise<OrtLike>;
  fetch: typeof fetch;
  /** Cache Storage (null when unavailable, e.g. blocked site data). */
  openCache(name: string): Promise<CacheLike | null>;
  estimate?(): Promise<{ quota?: number; usage?: number }>;
  digest?(bytes: Uint8Array): Promise<string>;
  hasWebGPU(): boolean;
  /** crossOriginIsolated && hardwareConcurrency, for WASM threads. */
  wasmThreads?(): number;
  now(): number;
}

const SESSION_ORDER = ["durationPredictor", "textEncoder", "vectorEstimator", "vocoder"] as const;

export function createWorkerCore(deps: WorkerDeps): (msg: ToWorker) => Promise<void> {
  let ctrl: AbortController | null = null;
  let tts: SupertonicTTS | null = null;
  let style: Style | null = null;
  let sessions: OrtSession[] = [];
  let initRun = 0;
  let queue: Promise<void> = Promise.resolve();
  const dropped = new Set<number>();
  const digest = deps.digest ?? sha256Hex;

  const releaseAll = async (list: OrtSession[]) => {
    await Promise.all(list.map((s) => s.release?.().catch(() => {})));
  };

  async function createSessions(ort: OrtLike, files: Map<string, Uint8Array>, ep: ExecutionProvider, run: number) {
    const created: OrtSession[] = [];
    const perModelMs: Record<string, number> = {};
    try {
      const out = {} as Record<(typeof SESSION_ORDER)[number], OrtSession>;
      let i = 0;
      for (const key of SESSION_ORDER) {
        const t0 = deps.now();
        const s = await ort.InferenceSession.create(files.get(MODEL_FILES[key])!, { executionProviders: [ep], graphOptimizationLevel: "all" });
        created.push(s);
        out[key] = s;
        perModelMs[key] = Math.round(deps.now() - t0);
        deps.post({ type: "progress", phase: "session", loaded: ++i, total: SESSION_ORDER.length, downloaded: 0 });
        if (run !== initRun) throw new WeightsError("canceled", "canceled");
      }
      return { sessions: out as Sessions, created, perModelMs };
    } catch (err) {
      await releaseAll(created);
      throw err;
    }
  }

  async function init(msg: Extract<ToWorker, { type: "init" }>) {
    const run = ++initRun;
    ctrl?.abort();
    const c = new AbortController();
    ctrl = c;
    try {
      const t0 = deps.now();
      const manifest = await loadManifest(msg.base, deps.fetch, c.signal);
      let cache: CacheLike | null = null;
      try {
        cache = await deps.openCache(CACHE_NAME);
      } catch {
        cache = null;
      }
      const total = totalBytes(manifest);
      let lastProgress = -Infinity;
      const weights = await fetchWeights(manifest, {
        base: msg.base,
        fetch: deps.fetch,
        cache,
        digest,
        allowDownload: msg.allowDownload,
        signal: c.signal,
        estimate: deps.estimate,
        // At most ~10 progress messages a second (a read loop yields one per network chunk).
        onProgress: (p) => {
          const t = deps.now();
          if (t - lastProgress < 100 && p.loaded < total) return;
          lastProgress = t;
          deps.post({ type: "progress", phase: "weights", loaded: p.loaded, total, downloaded: p.downloaded });
        },
      });
      const weightsMs = Math.round(deps.now() - t0);
      if (run !== initRun) return;

      const ort = await deps.importOrt(msg.ortModule);
      if (ort.env?.wasm) {
        ort.env.wasm.wasmPaths = msg.ortBase;
        ort.env.wasm.numThreads = Math.max(1, deps.wasmThreads?.() ?? 1);
        ort.env.wasm.proxy = false;
      }
      const text = (p: string) => new TextDecoder().decode(weights.files.get(p)!);
      const cfg = JSON.parse(text(MODEL_FILES.config)) as SupertonicConfig;
      const indexer = JSON.parse(text(MODEL_FILES.indexer)) as number[];
      const voice = JSON.parse(text(MODEL_FILES.voice)) as VoiceStyleJson;

      const t1 = deps.now();
      const order: ExecutionProvider[] = msg.ep === "wasm" || !deps.hasWebGPU() ? ["wasm"] : ["webgpu", "wasm"];
      const st = voiceStyle(ort, voice);
      let made: Awaited<ReturnType<typeof createSessions>> | null = null;
      let engine: SupertonicTTS | null = null;
      let ep: ExecutionProvider = order[0];
      let lastErr: unknown;
      let sessionMs = 0;
      let warmupMs = 0;
      for (const e of order) {
        let m: Awaited<ReturnType<typeof createSessions>> | null = null;
        try {
          m = await createSessions(ort, weights.files, e, run);
          sessionMs = Math.round(deps.now() - t1);
          // Warm-up: the first run compiles the GPU kernels (~15 s on a 2017 laptop GPU); doing it
          // here keeps that delay off the shopper's first spoken reply. A failure tries the next EP.
          const t2 = deps.now();
          const candidate = new SupertonicTTS(ort, cfg, indexer, m.sessions);
          await candidate.call("Hi.", "en", st, { steps: msg.steps });
          warmupMs = Math.round(deps.now() - t2);
          made = m;
          engine = candidate;
          ep = e;
          break;
        } catch (err) {
          if (m) await releaseAll(m.created);
          if (err instanceof WeightsError && err.code === "canceled") throw err;
          lastErr = err;
        }
      }
      for (const p of REQUIRED_FILES) weights.files.delete(p);
      if (!made || !engine) throw lastErr ?? new Error("no execution provider");
      if (run !== initRun) {
        await releaseAll(made.created);
        return;
      }
      await releaseAll(sessions);
      sessions = made.created;
      tts = engine;
      style = st;
      deps.post({
        type: "ready",
        ep,
        timings: { weightsMs, sessionMs, warmupMs, downloaded: weights.downloaded, perModelMs: made.perModelMs },
        ...(weights.cacheWarning ? { cacheWarning: weights.cacheWarning } : {}),
      });
    } catch (err) {
      if (run !== initRun && !(err instanceof WeightsError && err.code === "canceled")) return;
      if (err instanceof WeightsError) deps.post({ type: "error", code: err.code, message: err.message });
      else deps.post({ type: "error", code: "ort", message: err instanceof Error ? err.message.slice(0, 300) : "runtime error" });
    } finally {
      if (ctrl === c) ctrl = null;
    }
  }

  function synth(msg: Extract<ToWorker, { type: "synth" }>) {
    queue = queue.then(async () => {
      if (dropped.delete(msg.id)) return;
      if (!tts || !style) return deps.post({ type: "synth-error", id: msg.id, message: "not ready" });
      try {
        const t0 = deps.now();
        const pcm = await tts.call(msg.text, msg.lang, style, { steps: msg.steps, speed: msg.speed });
        deps.post({ type: "audio", id: msg.id, pcm, sampleRate: tts.sampleRate, ms: Math.round(deps.now() - t0) }, [pcm.buffer as ArrayBuffer]);
      } catch (err) {
        deps.post({ type: "synth-error", id: msg.id, message: err instanceof Error ? err.message.slice(0, 200) : "synthesis failed" });
      }
    });
    return queue;
  }

  return async (msg) => {
    switch (msg.type) {
      case "init":
        return init(msg);
      case "cancel":
        initRun++;
        ctrl?.abort();
        return;
      case "synth":
        return synth(msg);
      case "drop":
        dropped.add(msg.id);
        return;
    }
  };
}

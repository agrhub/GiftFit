/**
 * Main-thread side of the in-browser Supertonic voice (owner: A4, P8.3). Owns the worker and the
 * opt-in status the panel shows. Nothing is downloaded until `start(true)` (the shopper's click);
 * `probe()` reads only the small manifest and checks Cache Storage for parts kept from an earlier
 * visit on this store site.
 */
import type { Locale } from "@/lib/i18n";
import type { LocalEngine } from "../speaker";
import { CACHE_NAME, ORT_BASE, ORT_MODULE, SUPERTONIC_BASE, totalBytes } from "./manifest";
import { isSupertonicLang } from "./inference";
import type { ExecutionProvider, FromWorker, InitErrorCode, ReadyTimings, ToWorker } from "./protocol";
import { cachedBytes, loadManifest, type CacheLike } from "./weights";

export type NaturalStatus =
  | { kind: "unavailable" }
  | { kind: "checking" }
  | { kind: "offer"; total: number; cached: number }
  | { kind: "downloading"; loaded: number; total: number }
  | { kind: "loading"; step: number; of: number }
  | { kind: "ready"; ep: ExecutionProvider; cacheWarning?: "quota" | "unavailable" }
  | { kind: "error"; code: InitErrorCode | "manifest" };

export interface WorkerLike {
  postMessage(msg: ToWorker): void;
  onmessage: ((e: MessageEvent<FromWorker>) => void) | null;
  onerror: ((e: unknown) => void) | null;
  terminate(): void;
}

export interface SupertonicClientOptions {
  onStatus(s: NaturalStatus): void;
  onReady?(t: ReadyTimings & { ep: ExecutionProvider }): void;
  createWorker?: () => WorkerLike;
  fetchImpl?: typeof fetch;
  openCache?: () => Promise<CacheLike | null>;
  /** Page origin used to build absolute URLs for the worker. */
  origin?: string;
  steps?: number;
  forceEp?: ExecutionProvider;
  synthTimeoutMs?: number;
}

function defaultWorker(): WorkerLike {
  return new Worker(new URL("./supertonic.worker.ts", import.meta.url), { type: "module", name: "giftfit-voice" }) as unknown as WorkerLike;
}

async function defaultCache(): Promise<CacheLike | null> {
  try {
    return typeof caches !== "undefined" ? await caches.open(CACHE_NAME) : null;
  } catch {
    return null;
  }
}

export class SupertonicClient implements LocalEngine {
  private worker: WorkerLike | null = null;
  private status: NaturalStatus = { kind: "checking" };
  private nextId = 1;
  private pending = new Map<number, { resolve(v: { pcm: Float32Array; sampleRate: number }): void; reject(e: Error): void }>();
  private readonly origin: string;

  constructor(private readonly o: SupertonicClientOptions) {
    this.origin = o.origin ?? (typeof location !== "undefined" ? location.origin : "http://localhost");
  }

  get current(): NaturalStatus {
    return this.status;
  }

  private set(s: NaturalStatus) {
    this.status = s;
    this.o.onStatus(s);
  }

  ready(): boolean {
    return this.status.kind === "ready";
  }

  /** Reads the manifest (a few KB) and what the cache already holds; never fetches weights. */
  async probe(): Promise<{ total: number; cached: number } | null> {
    this.set({ kind: "checking" });
    try {
      const fetchImpl = this.o.fetchImpl ?? fetch;
      const m = await loadManifest(this.origin + SUPERTONIC_BASE, fetchImpl);
      const cache = await (this.o.openCache ?? defaultCache)();
      const total = totalBytes(m);
      const cached = await cachedBytes(m, this.origin + SUPERTONIC_BASE, cache);
      if (this.status.kind === "checking") this.set({ kind: "offer", total, cached });
      return { total, cached };
    } catch {
      if (this.status.kind === "checking") this.set({ kind: "error", code: "manifest" });
      return null;
    }
  }

  /** Starts loading: from the cache only (`allowDownload` false) or downloading what is missing. */
  start(allowDownload: boolean): void {
    const total = this.status.kind === "offer" ? this.status.total : 0;
    if (!this.worker) {
      try {
        this.worker = (this.o.createWorker ?? defaultWorker)();
      } catch {
        this.set({ kind: "error", code: "ort" });
        return;
      }
      this.worker.onmessage = (e) => this.onMessage(e.data);
      this.worker.onerror = () => {
        this.failAll("worker error");
        this.set({ kind: "error", code: "ort" });
      };
    }
    this.set({ kind: "downloading", loaded: 0, total });
    this.worker.postMessage({
      type: "init",
      base: this.origin + SUPERTONIC_BASE,
      ortModule: this.origin + ORT_MODULE,
      ortBase: this.origin + ORT_BASE,
      allowDownload,
      ...(this.o.forceEp ? { ep: this.o.forceEp } : {}),
      ...(this.o.steps ? { steps: this.o.steps } : {}),
    });
  }

  /** Cancels a download in progress (parts already verified stay cached for next time). */
  cancel(): void {
    this.worker?.postMessage({ type: "cancel" });
    this.dispose();
    void this.probe();
  }

  private failAll(message: string) {
    for (const p of this.pending.values()) p.reject(new Error(message));
    this.pending.clear();
  }

  private onMessage(m: FromWorker) {
    switch (m.type) {
      case "progress":
        if (m.phase === "weights") this.set({ kind: "downloading", loaded: m.loaded, total: m.total });
        else this.set({ kind: "loading", step: m.loaded, of: m.total });
        return;
      case "ready":
        this.set({ kind: "ready", ep: m.ep, ...(m.cacheWarning ? { cacheWarning: m.cacheWarning } : {}) });
        this.o.onReady?.({ ...m.timings, ep: m.ep });
        return;
      case "error":
        if (m.code === "canceled") return;
        this.dispose();
        this.set({ kind: "error", code: m.code });
        return;
      case "audio": {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        p?.resolve({ pcm: m.pcm, sampleRate: m.sampleRate });
        return;
      }
      case "synth-error": {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        p?.reject(new Error(m.message));
        return;
      }
    }
  }

  synth(text: string, lang: Locale, signal: AbortSignal): Promise<{ pcm: Float32Array; sampleRate: number }> {
    const w = this.worker;
    if (!w || !this.ready()) return Promise.reject(new Error("not ready"));
    if (!isSupertonicLang(lang)) return Promise.reject(new Error(`unsupported language: ${lang}`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => settle(() => reject(new Error("timeout"))), this.o.synthTimeoutMs ?? 30_000);
      const onAbort = () => {
        w.postMessage({ type: "drop", id });
        settle(() => reject(new DOMException("aborted", "AbortError")));
      };
      const settle = (f: () => void) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        f();
      };
      this.pending.set(id, { resolve: (v) => settle(() => resolve(v)), reject: (e) => settle(() => reject(e)) });
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort);
      w.postMessage({ type: "synth", id, text, lang, ...(this.o.steps ? { steps: this.o.steps } : {}) });
    });
  }

  /** Stops the worker and frees the model (GPU and memory). */
  dispose(): void {
    this.failAll("disposed");
    this.worker?.terminate();
    this.worker = null;
    if (this.status.kind === "ready" || this.status.kind === "downloading" || this.status.kind === "loading") this.set({ kind: "checking" });
  }
}

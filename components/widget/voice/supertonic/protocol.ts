/** Messages between the widget and the Supertonic voice worker (owner: A4, P8.3). */
import type { WeightsErrorCode } from "./weights";

export type ExecutionProvider = "webgpu" | "wasm";

export type ToWorker =
  | {
      type: "init";
      /** Absolute URLs (the worker resolves nothing against the page). */
      base: string;
      ortModule: string;
      ortBase: string;
      allowDownload: boolean;
      /** "wasm" forces the WASM provider (bench); default tries WebGPU first. */
      ep?: ExecutionProvider;
      /** Denoising steps for the warm-up run (same as later requests). */
      steps?: number;
    }
  | { type: "cancel" }
  | { type: "synth"; id: number; text: string; lang: "en" | "vi"; steps?: number; speed?: number }
  | { type: "drop"; id: number };

export type InitErrorCode = WeightsErrorCode | "ort" | "storage";

export interface ReadyTimings {
  /** Weights from cache/network, verified (ms). */
  weightsMs: number;
  /** All four ORT sessions created (ms). */
  sessionMs: number;
  /** First synthesis (GPU kernel compilation), done before "ready" (ms). */
  warmupMs: number;
  /** Bytes fetched from the network (0 = all from the cache). */
  downloaded: number;
  perModelMs: Record<string, number>;
}

export type FromWorker =
  | { type: "progress"; phase: "weights" | "session"; loaded: number; total: number; downloaded: number }
  | { type: "ready"; ep: ExecutionProvider; timings: ReadyTimings; cacheWarning?: "quota" | "unavailable" }
  | { type: "error"; code: InitErrorCode; message: string }
  | { type: "audio"; id: number; pcm: Float32Array; sampleRate: number; ms: number }
  | { type: "synth-error"; id: number; message: string };

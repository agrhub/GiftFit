/**
 * Web Worker entry for the in-browser Supertonic voice (owner: A4, P8.3). Weights download,
 * verification and ONNX inference all run here, so the widget UI and the character stay smooth.
 * onnxruntime-web is loaded at runtime from the GiftFit origin (/voice/ort/<version>/), not bundled.
 */
import type { OrtLike } from "./inference";
import type { ToWorker } from "./protocol";
import { createWorkerCore } from "./worker-core";

interface WorkerScope {
  postMessage(msg: unknown, transfer: Transferable[]): void;
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
  crossOriginIsolated?: boolean;
}
const scope = self as unknown as WorkerScope;

const core = createWorkerCore({
  post: (msg, transfer) => scope.postMessage(msg, transfer ?? []),
  importOrt: async (url) => (await import(/* webpackIgnore: true */ url)) as OrtLike,
  fetch: (input, init) => fetch(input, init),
  openCache: async (name) => (typeof caches !== "undefined" ? await caches.open(name) : null),
  estimate: async () => (await navigator.storage?.estimate?.()) ?? {},
  hasWebGPU: () => typeof (navigator as { gpu?: unknown }).gpu !== "undefined",
  wasmThreads: () => (scope.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1),
  now: () => performance.now(),
});

scope.onmessage = (e: MessageEvent<ToWorker>) => {
  void core(e.data);
};

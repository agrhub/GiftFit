/**
 * Live2D loading and fallback selection (owner: A4, ADR-050). Exactly one fixed model: the paths
 * below are constants, and nothing (props, options, query strings, postMessage) can change them, so
 * the widget is never an "Expandable Application" (Live2D PSLA §1.5).
 *
 * Core is only ever loaded from our own origin (public/live2d/core/, git-ignored, placed by hand
 * after accepting Live2D's licence); there is no remote fallback. The Framework (vendor submodule)
 * and our runtime are code-split and fetched only after Core is in, i.e. when a launcher mounts.
 */
import type { CharacterState } from "../types";
import type { CubismModel, CubismShader_WebGL } from "./framework";

export const CORE_SRC = "/live2d/core/live2dcubismcore.min.js";
export const MODEL_DIR = "/live2d/models/Mark/";
export const MODEL_FILE = "Mark.model3.json";
export const SHADER_PATH = "/live2d/shaders/WebGL/";
/**
 * Generous on purpose: it bounds Core (228 KB) + the Framework chunk + the model (0.69 MB) + texture
 * decode/upload on a slow phone. Measured on headless Chromium with software GL (SwiftShader): about
 * 1-2.5 s locally. The SVG art stands in while it loads, so waiting costs nothing visible.
 */
/**
 * Outer bound only. The SVG mascot shows while Live2D loads, so a slow load is not a failure: it keeps
 * loading and swaps in at its first drawn frame. (8 s fell back on real machines with slow shader
 * fetches, disposing a model whose shaders were still loading.)
 */
export const LOAD_TIMEOUT_MS = 45_000;

/** The 13 WebGL shader sources the Framework fetches (copied from the submodule by live2d:fetch). */
export const SHADER_FILES = [
  "vertshadersrc.vert", "vertshadersrcmasked.vert", "vertshadersrcsetupmask.vert", "fragshadersrcsetupmask.frag",
  "fragshadersrcpremultipliedalpha.frag", "fragshadersrcmaskpremultipliedalpha.frag", "fragshadersrcmaskinvertedpremultipliedalpha.frag",
  "vertshadersrccopy.vert", "fragshadersrccopy.frag", "fragshadersrccolorblend.frag", "fragshadersrcalphablend.frag",
  "vertshadersrcblend.vert", "fragshadersrcpremultipliedalphablend.frag",
] as const;

/**
 * Guard before the Framework compiles anything: every shader source must be reachable and non-empty.
 * The Framework then re-fetches them (warm in the HTTP cache), and its own Promise.all waits for all.
 */
export async function prefetchShaders(signal?: AbortSignal): Promise<void> {
  await Promise.all(
    SHADER_FILES.map(async (name) => {
      const buf = await fetchAsset(SHADER_PATH + name, signal);
      if (buf.byteLength === 0) throw new Live2DLoadError("error", `${name}: empty shader source`);
    }),
  );
}

/**
 * The Framework compiles a program for every Cubism 5.3 colour x alpha blend pair (16 x 5 x 3 masks =
 * 237 programs) in one synchronous burst before the first frame, whether the model uses them or not.
 * On Windows (ANGLE/D3D11) that burst was most of the wait for Mark-kun, and it froze the frame and
 * the page around it. Keep only the pairs this model draws with: none for Mark (his moc3 predates
 * blend modes), so only the base and copy programs are built. A model that uses blend modes still
 * gets every pair it draws with. Called after renderer.startUp() and before loadShaders().
 */
export function limitBlendShaders(shader: Pick<CubismShader_WebGL, "_colorBlendValues" | "_alphaBlendValues">, model: CubismModel): void {
  const colors = new Set<number>();
  const alphas = new Set<number>();
  if (model.isBlendModeEnabled()) {
    for (let i = 0; i < model.getDrawableCount(); i++) {
      colors.add(model.getDrawableColorBlend(i));
      alphas.add(model.getDrawableAlphaBlend(i));
    }
    for (let i = 0; i < model.getOffscreenCount(); i++) {
      colors.add(model.getOffscreenColorBlend(i));
      alphas.add(model.getOffscreenAlphaBlend(i));
    }
  }
  shader._colorBlendValues = shader._colorBlendValues.filter((v) => colors.has(v));
  shader._alphaBlendValues = shader._alphaBlendValues.filter((v) => alphas.has(v));
}

export type FallbackReason = "reduced-motion" | "no-webgl" | "core" | "model" | "timeout" | "error";

export class Live2DLoadError extends Error {
  constructor(
    readonly reason: FallbackReason,
    message: string,
  ) {
    super(message);
    this.name = "Live2DLoadError";
  }
}

let fellBack: FallbackReason | null = null;
/** Remembers that Live2D failed in this frame, so the panel header shows the SVG mascot too. */
export function noteFallback(reason: FallbackReason): void {
  fellBack = reason;
}
export function live2dFailed(): boolean {
  return fellBack !== null;
}

/** Live2D only with motion allowed and WebGL 2 present; otherwise the SVG mascot. */
export function pickCharacter(o: { reducedMotion: boolean; webgl: boolean }): "live2d" | "svg" {
  return o.reducedMotion || !o.webgl ? "svg" : "live2d";
}

let webgl2: boolean | undefined;
/** Cached WebGL 2 probe (false on the server and wherever the context can't be created). */
export function hasWebGL2(): boolean {
  if (webgl2 !== undefined) return webgl2;
  if (typeof document === "undefined" || typeof WebGL2RenderingContext === "undefined") return (webgl2 = false);
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    return (webgl2 = !!gl);
  } catch {
    return (webgl2 = false);
  }
}

let corePromise: Promise<void> | null = null;

/** Injects Core once; rejects with reason "core" when the file is missing (404) or does not define the global. */
export function loadCore(src = CORE_SRC): Promise<void> {
  if (typeof window !== "undefined" && "Live2DCubismCore" in window) return Promise.resolve();
  if (corePromise) return corePromise;
  corePromise = new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.dataset.giftfitLive2dCore = "";
    s.onload = () => ("Live2DCubismCore" in window ? resolve() : reject(new Live2DLoadError("core", "Core loaded but defined nothing")));
    s.onerror = () => reject(new Live2DLoadError("core", `Core not found at ${src}`));
    document.head.appendChild(s);
  }).catch((err) => {
    corePromise = null; // allow a retry on the next mount
    document.querySelector("script[data-giftfit-live2d-core]")?.remove();
    throw err;
  });
  return corePromise;
}

/** Downloads started early by warmLive2D(), handed over once to fetchAsset. */
const warm = new Map<string, Promise<ArrayBuffer>>();

/** The files Mark.model3.json lists (moc3, textures, physics, Idle motions), relative to MODEL_DIR. */
export function modelFiles(json: unknown): string[] {
  const refs = (json as { FileReferences?: { Moc?: unknown; Textures?: unknown; Physics?: unknown; Motions?: { Idle?: unknown } } })?.FileReferences;
  if (!refs) return [];
  const idle = Array.isArray(refs.Motions?.Idle) ? (refs.Motions.Idle as Array<{ File?: unknown }>).map((m) => m?.File) : [];
  const all = [refs.Moc, ...(Array.isArray(refs.Textures) ? refs.Textures : []), refs.Physics, ...idle];
  return all.filter((f): f is string => typeof f === "string" && f.length > 0 && !f.includes(".."));
}

const getBytes = (url: string) =>
  fetch(url, { credentials: "same-origin" }).then((r) => {
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return r.arrayBuffer();
  });

let warming: Promise<void> | null = null;
/**
 * Starts every Live2D download at once (Core, the 13 shaders, model3.json and then the files it
 * lists), so no step waits for the one before it to ask for its bytes. In the widget frame the bytes
 * go to fetchAsset (no second request); on the landing they fill the HTTP cache the same-origin widget
 * frame reads after Run. Once per document; never rejects (a failure here just means a normal load).
 */
export function warmLive2D(): Promise<void> {
  if (warming || typeof fetch !== "function") return warming ?? Promise.resolve();
  const keep = (url: string, p: Promise<ArrayBuffer>) => {
    warm.set(url, p);
    p.catch(() => warm.delete(url));
    return p;
  };
  const core = getBytes(CORE_SRC);
  const shaders = SHADER_FILES.map((n) => keep(SHADER_PATH + n, getBytes(SHADER_PATH + n)));
  const model = keep(MODEL_DIR + MODEL_FILE, getBytes(MODEL_DIR + MODEL_FILE)).then((buf) =>
    Promise.all(modelFiles(JSON.parse(new TextDecoder().decode(buf))).map((f) => keep(MODEL_DIR + f, getBytes(MODEL_DIR + f)))),
  );
  warming = Promise.allSettled([core, model, ...shaders]).then(() => undefined);
  return warming;
}

/**
 * Runs `task` after the first paint, when the main thread is idle (requestIdleCallback, or a short
 * timeout where it is missing). Returns a cancel function.
 */
export function afterFirstPaintIdle(task: () => void, idleTimeoutMs = 2000): () => void {
  let cancelled = false;
  let raf = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let idle: number | undefined;
  const run = () => {
    if (!cancelled) task();
  };
  const schedule = () => {
    // rAF fires before the next paint; the timeout after it lands after that paint.
    timer = setTimeout(() => {
      if (typeof requestIdleCallback === "function") idle = requestIdleCallback(run, { timeout: idleTimeoutMs });
      else timer = setTimeout(run, 200);
    }, 0);
  };
  if (typeof requestAnimationFrame === "function") raf = requestAnimationFrame(schedule);
  else schedule();
  return () => {
    cancelled = true;
    if (raf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
    clearTimeout(timer);
    if (idle !== undefined && typeof cancelIdleCallback === "function") cancelIdleCallback(idle);
  };
}

/**
 * The landing's warm-up (A20): after first paint and when idle, and only where the widget would show
 * Mark-kun (WebGL 2, motion allowed) and the visitor has not asked to save data, download Live2D so
 * Run shows him without waiting on the network. Never throws, also without WebGL.
 */
export function scheduleLive2DWarmup(): () => void {
  return afterFirstPaintIdle(() => {
    try {
      const nav = typeof navigator !== "undefined" ? (navigator as Navigator & { connection?: { saveData?: boolean } }) : undefined;
      if (nav?.connection?.saveData) return;
      const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (pickCharacter({ reducedMotion: reduce, webgl: hasWebGL2() }) !== "live2d") return;
      void warmLive2D();
    } catch {
      /* a warm-up is optional */
    }
  });
}

/** Fetches a model asset as bytes; any non-2xx is reason "model". */
export async function fetchAsset(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const early = warm.get(url);
  if (early) {
    warm.delete(url);
    try {
      return await early;
    } catch {
      /* fetch it again below, with the caller's error mapping */
    }
  }
  let res: Response;
  try {
    res = await fetch(url, { signal, credentials: "same-origin" });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new Live2DLoadError("model", `${url}: network error`);
  }
  if (!res.ok) throw new Live2DLoadError("model", `${url}: HTTP ${res.status}`);
  return res.arrayBuffer();
}

/** What the render loop reads every frame. */
export interface Live2DFrame {
  state: CharacterState;
  /** Smoothed 0..1 mouth amplitude. */
  mouth: number;
}

export interface Live2DHandle {
  dispose(): void;
}

/** Rejects after `ms` with reason "timeout"; `onLate` receives a value that arrives afterwards (to dispose it). */
export function withTimeout<T>(p: Promise<T>, ms: number, onLate?: (value: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    // A hidden tab pauses requestAnimationFrame (the first frame can't be drawn), so the clock only
    // fails the load while the page is visible.
    const expire = () => {
      if (typeof document !== "undefined" && document.hidden) {
        t = setTimeout(expire, ms);
        return;
      }
      done = true;
      reject(new Live2DLoadError("timeout", `Live2D did not load within ${ms} ms`));
    };
    let t = setTimeout(expire, ms);
    p.then(
      (v) => {
        if (done) return onLate?.(v);
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        if (done) return;
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * Loads Core, then the Framework + runtime chunk, then the one model, and starts rendering into
 * `canvas`. The model and shader downloads start with Core (warmLive2D) instead of after it. Takes
 * no model URL by design.
 */
export function loadLive2D(canvas: HTMLCanvasElement, frame: () => Live2DFrame, signal: AbortSignal): Promise<Live2DHandle> {
  const run = async () => {
    const t0 = performance.now();
    const log = (step: string) => {
      if (process.env.NODE_ENV !== "production") console.debug(`[live2d] +${Math.round(performance.now() - t0)}ms ${step}`);
    };
    void warmLive2D();
    await loadCore();
    log("core");
    const { startLive2D } = await import("./runtime");
    log("framework chunk");
    const handle = await startLive2D(canvas, frame, signal);
    log("ready");
    return handle;
  };
  return withTimeout(run(), LOAD_TIMEOUT_MS, (late) => late.dispose());
}

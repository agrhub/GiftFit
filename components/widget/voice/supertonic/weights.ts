/**
 * Downloads, verifies and caches the Supertonic weights (owner: A4, P8.3). Runs inside the voice
 * Web Worker; every dependency is injected so it is unit-tested without a browser.
 *
 * Per file: each part is taken from Cache Storage when present, otherwise downloaded (only when the
 * shopper clicked "Download": `allowDownload`), its SHA-256 checked, cached, and copied into one
 * buffer; then the whole file's SHA-256 is checked. A corrupted cached part is evicted and fetched
 * again. A full cache (QuotaExceededError) is not fatal: the voice still works for this visit.
 * Cache Storage is per origin and, in an iframe, per top-level site, so each store a shopper visits
 * keeps its own copy.
 */
import { parseManifest, type Manifest, type ManifestFile } from "./manifest";

export type WeightsErrorCode = "canceled" | "network" | "integrity" | "needs-download" | "manifest";

export class WeightsError extends Error {
  constructor(
    readonly code: WeightsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WeightsError";
  }
}

export interface CacheLike {
  match(url: string): Promise<Response | undefined>;
  put(url: string, res: Response): Promise<void>;
  delete(url: string): Promise<boolean>;
}

export interface Progress {
  loaded: number;
  total: number;
  /** Bytes that came from the network in this run (the rest came from the cache). */
  downloaded: number;
}

export interface WeightsDeps {
  /** Absolute base URL of the weights folder, ending in "/". */
  base: string;
  fetch: typeof fetch;
  cache: CacheLike | null;
  digest(bytes: Uint8Array): Promise<string>;
  allowDownload: boolean;
  signal?: AbortSignal;
  onProgress?(p: Progress): void;
  /** navigator.storage.estimate, to skip caching up front when it clearly won't fit. */
  estimate?(): Promise<{ quota?: number; usage?: number }>;
}

export interface WeightsResult {
  files: Map<string, Uint8Array>;
  downloaded: number;
  /** Set when the cache could not keep the weights (quota): the next visit downloads again. */
  cacheWarning?: "quota" | "unavailable";
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

function isAbort(err: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted) || (err as { name?: string } | null)?.name === "AbortError";
}

export async function loadManifest(base: string, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<Manifest> {
  let res: Response;
  try {
    res = await fetchImpl(`${base}manifest.json`, { signal, cache: "no-cache" });
  } catch (err) {
    if (isAbort(err, signal)) throw new WeightsError("canceled", "canceled");
    throw new WeightsError("network", "manifest unreachable");
  }
  if (!res.ok) throw new WeightsError(res.status === 404 ? "manifest" : "network", `manifest ${res.status}`);
  try {
    return parseManifest(await res.json());
  } catch (err) {
    throw new WeightsError("manifest", err instanceof Error ? err.message : "bad manifest");
  }
}

/** Bytes of the manifest already in the cache (cheap: size checks only, no hashing). */
export async function cachedBytes(manifest: Manifest, base: string, cache: CacheLike | null): Promise<number> {
  if (!cache) return 0;
  let n = 0;
  for (const f of manifest.files)
    for (const p of f.parts) {
      try {
        const hit = await cache.match(base + p.path);
        const len = Number(hit?.headers.get("content-length") ?? NaN);
        if (hit && (len === p.size || Number.isNaN(len))) n += p.size;
      } catch {
        /* treat as missing */
      }
    }
  return n;
}

async function readBody(res: Response, onBytes: (n: number) => void, signal?: AbortSignal): Promise<Uint8Array> {
  const reader = res.body?.getReader?.();
  if (!reader) {
    const b = new Uint8Array(await res.arrayBuffer());
    onBytes(b.length);
    return b;
  }
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    if (signal?.aborted) {
      void reader.cancel().catch(() => {});
      throw new WeightsError("canceled", "canceled");
    }
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    n += value.length;
    onBytes(value.length);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export async function fetchWeights(manifest: Manifest, deps: WeightsDeps): Promise<WeightsResult> {
  const { base, signal } = deps;
  const total = manifest.files.reduce((n, f) => n + f.size, 0);
  let loaded = 0;
  let downloaded = 0;
  let cache = deps.cache;
  let cacheWarning: WeightsResult["cacheWarning"] = cache ? undefined : "unavailable";
  const progress = () => deps.onProgress?.({ loaded, total, downloaded });
  const checkAbort = () => {
    if (signal?.aborted) throw new WeightsError("canceled", "canceled");
  };

  if (cache && deps.estimate && deps.allowDownload) {
    try {
      const have = await cachedBytes(manifest, base, cache);
      const { quota, usage } = await deps.estimate();
      if (typeof quota === "number" && quota - (usage ?? 0) < total - have) {
        cacheWarning = "quota";
        cache = null;
      }
    } catch {
      /* estimate unsupported: try anyway */
    }
  }

  const fromCache = async (url: string, size: number): Promise<Uint8Array | null> => {
    if (!cache) return null;
    try {
      const hit = await cache.match(url);
      if (!hit) return null;
      const b = new Uint8Array(await hit.arrayBuffer());
      return b.length === size ? b : null;
    } catch {
      return null;
    }
  };

  const download = async (url: string, p: ManifestFile["parts"][number]): Promise<Uint8Array> => {
    if (!deps.allowDownload) throw new WeightsError("needs-download", "weights not cached");
    for (let attempt = 0; ; attempt++) {
      checkAbort();
      const before = loaded;
      try {
        const res = await deps.fetch(url, { signal });
        if (!res.ok) throw new WeightsError("network", `${p.path} ${res.status}`);
        const bytes = await readBody(
          res,
          (n) => {
            loaded += n;
            downloaded += n;
            progress();
          },
          signal,
        );
        if (bytes.length !== p.size || (await deps.digest(bytes)) !== p.sha256) throw new WeightsError("integrity", `${p.path} failed verification`);
        if (cache) {
          try {
            await cache.put(url, new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { "content-type": "application/octet-stream", "content-length": String(bytes.length) } }));
          } catch (err) {
            cacheWarning = (err as { name?: string } | null)?.name === "QuotaExceededError" ? "quota" : "unavailable";
            cache = null;
          }
        }
        return bytes;
      } catch (err) {
        if (isAbort(err, signal)) throw new WeightsError("canceled", "canceled");
        downloaded -= loaded - before;
        loaded = before;
        progress();
        if (attempt >= 1) throw err instanceof WeightsError ? err : new WeightsError("network", `${p.path} download failed`);
      }
    }
  };

  const files = new Map<string, Uint8Array>();
  for (const f of manifest.files) {
    for (let attempt = 0; ; attempt++) {
      const buf = new Uint8Array(f.size);
      const start = loaded;
      let offset = 0;
      let usedCache = false;
      for (const p of f.parts) {
        checkAbort();
        const url = base + p.path;
        let bytes = attempt === 0 ? await fromCache(url, p.size) : null;
        if (bytes) {
          usedCache = true;
          loaded += bytes.length;
          progress();
        } else bytes = await download(url, p);
        buf.set(bytes, offset);
        offset += bytes.length;
      }
      checkAbort();
      if ((await deps.digest(buf)) === f.sha256) {
        files.set(f.path, buf);
        break;
      }
      // A cached part was corrupted: evict this file's parts and fetch them again (once).
      if (usedCache && attempt === 0) {
        for (const p of f.parts) await cache?.delete(base + p.path).catch(() => false);
        loaded = start;
        progress();
        continue;
      }
      throw new WeightsError("integrity", `${f.path} failed verification`);
    }
  }
  return { files, downloaded, ...(cacheWarning ? { cacheWarning } : {}) };
}

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { formatBytes, parseManifest, REQUIRED_FILES, totalBytes, type Manifest } from "../supertonic/manifest";
import { cachedBytes, fetchWeights, loadManifest, sha256Hex, WeightsError, type CacheLike } from "../supertonic/weights";

const BASE = "https://giftfit.example/voice/supertonic/aafc6e32/";
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** A fake served model: every required file, split into parts of `partSize` bytes. */
function fixture(partSize = 4) {
  const bodies = new Map<string, Uint8Array>();
  const files = REQUIRED_FILES.map((path, i) => {
    const data = new Uint8Array(10 + i).map((_, j) => (i * 31 + j) & 255);
    const parts = [];
    for (let o = 0, k = 0; o < data.length; o += partSize, k++) {
      const p = data.slice(o, o + partSize);
      const pp = `${path}.part${String(k).padStart(3, "0")}`;
      bodies.set(BASE + pp, p);
      parts.push({ path: pp, size: p.length, sha256: sha(p) });
    }
    return { path, size: data.length, sha256: sha(data), parts, data };
  });
  const manifest = { revision: "aafc6e32416a594460b32413efc49d7fe4ce6d46", files: files.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256, parts: f.parts })) };
  bodies.set(`${BASE}manifest.json`, new TextEncoder().encode(JSON.stringify(manifest)));
  const fetchMock = vi.fn(async (url: string | URL | Request) => {
    const b = bodies.get(String(url));
    return b ? new Response(b.slice() as Uint8Array<ArrayBuffer>) : new Response("nope", { status: 404 });
  });
  return { manifest: parseManifest(manifest) as Manifest, files, bodies, fetchMock: fetchMock as unknown as typeof fetch & typeof fetchMock };
}

class MemCache implements CacheLike {
  map = new Map<string, Uint8Array>();
  failPut: Error | null = null;
  async match(url: string) {
    const b = this.map.get(url);
    return b ? new Response(b.slice() as Uint8Array<ArrayBuffer>, { headers: { "content-length": String(b.length) } }) : undefined;
  }
  async put(url: string, res: Response) {
    if (this.failPut) throw this.failPut;
    this.map.set(url, new Uint8Array(await res.arrayBuffer()));
  }
  async delete(url: string) {
    return this.map.delete(url);
  }
}

const deps = (f: ReturnType<typeof fixture>, cache: CacheLike | null, allowDownload = true) => ({ base: BASE, fetch: f.fetchMock, cache, digest: sha256Hex, allowDownload });

describe("manifest", () => {
  it("parses, tolerates keyed files and alternative field names, checks parts add up", () => {
    const f = fixture();
    expect(f.manifest.files.map((x) => x.path).sort()).toEqual([...REQUIRED_FILES].sort());
    const keyed = Object.fromEntries(f.manifest.files.map(({ path, size, sha256, parts }) => [path, { bytes: size, sha256, parts: parts.map((p) => ({ url: p.path, bytes: p.size, sha256: p.sha256 })) }]));
    expect(totalBytes(parseManifest({ files: keyed }))).toBe(totalBytes(f.manifest));
    const bad = structuredClone(f.manifest);
    bad.files[0].size += 1;
    expect(() => parseManifest(bad)).toThrow(/add up/);
    expect(() => parseManifest({ files: f.manifest.files.slice(1) })).toThrow(/missing/);
    const evil = structuredClone(f.manifest);
    evil.files[0].parts[0].path = "../../etc/passwd";
    expect(() => parseManifest(evil)).toThrow(/bad path/);
  });

  it("formats sizes", () => {
    expect(formatBytes(398_000_000)).toBe("398 MB");
    expect(formatBytes(2_500_000)).toBe("2.5 MB");
  });

  it("loadManifest maps failures to WeightsError codes", async () => {
    const f = fixture();
    expect((await loadManifest(BASE, f.fetchMock)).files).toHaveLength(REQUIRED_FILES.length);
    await expect(loadManifest("https://giftfit.example/missing/", f.fetchMock)).rejects.toMatchObject({ code: "manifest" });
  });
});

describe("fetchWeights", () => {
  it("never touches the network for weights without the shopper's click", async () => {
    const f = fixture();
    await expect(fetchWeights(f.manifest, deps(f, new MemCache(), false))).rejects.toMatchObject({ code: "needs-download" });
    expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it("downloads every part with progress, verifies, reassembles and caches; the next run uses only the cache", async () => {
    const f = fixture();
    const cache = new MemCache();
    const progress = vi.fn();
    const out = await fetchWeights(f.manifest, { ...deps(f, cache), onProgress: progress });
    for (const file of f.files) expect(Array.from(out.files.get(file.path)!)).toEqual(Array.from(file.data));
    const total = totalBytes(f.manifest);
    expect(out.downloaded).toBe(total);
    expect(progress).toHaveBeenLastCalledWith({ loaded: total, total, downloaded: total });
    expect(cache.map.size).toBe(f.manifest.files.reduce((n, x) => n + x.parts.length, 0));
    expect(await cachedBytes(f.manifest, BASE, cache)).toBe(total);

    f.fetchMock.mockClear();
    const again = await fetchWeights(f.manifest, deps(f, cache, false));
    expect(f.fetchMock).not.toHaveBeenCalled();
    expect(again.downloaded).toBe(0);
    expect(again.files.size).toBe(REQUIRED_FILES.length);
  });

  it("rejects a tampered part (after one retry) and never caches it", async () => {
    const f = fixture();
    const url = BASE + f.manifest.files[0].parts[0].path;
    f.bodies.set(url, new Uint8Array([9, 9, 9, 9]));
    const cache = new MemCache();
    await expect(fetchWeights(f.manifest, deps(f, cache))).rejects.toMatchObject({ code: "integrity" });
    expect(f.fetchMock.mock.calls.filter((c) => String(c[0]) === url)).toHaveLength(2);
    expect(cache.map.has(url)).toBe(false);
  });

  it("evicts a corrupted cached part and downloads it again", async () => {
    const f = fixture();
    const cache = new MemCache();
    await fetchWeights(f.manifest, deps(f, cache));
    const url = BASE + f.manifest.files[1].parts[0].path;
    cache.map.set(url, new Uint8Array(cache.map.get(url)!.length).fill(7));
    f.fetchMock.mockClear();
    const out = await fetchWeights(f.manifest, deps(f, cache));
    expect(out.files.get(f.manifest.files[1].path)).toEqual(f.files[1].data);
    expect(f.fetchMock).toHaveBeenCalled();
    expect(cache.map.get(url)).toEqual(f.bodies.get(url));
    // Without permission to download, a corrupted cache is reported, not silently re-fetched.
    cache.map.set(url, new Uint8Array(cache.map.get(url)!.length).fill(7));
    await expect(fetchWeights(f.manifest, deps(f, cache, false))).rejects.toMatchObject({ code: "needs-download" });
  });

  it("keeps working when the cache is full (QuotaExceededError) and says so", async () => {
    const f = fixture();
    const cache = new MemCache();
    cache.failPut = Object.assign(new Error("full"), { name: "QuotaExceededError" });
    const out = await fetchWeights(f.manifest, deps(f, cache));
    expect(out.cacheWarning).toBe("quota");
    expect(out.files.size).toBe(REQUIRED_FILES.length);
  });

  it("skips caching up front when the storage estimate is too small", async () => {
    const f = fixture();
    const cache = new MemCache();
    const out = await fetchWeights(f.manifest, { ...deps(f, cache), estimate: async () => ({ quota: 10, usage: 5 }) });
    expect(out.cacheWarning).toBe("quota");
    expect(cache.map.size).toBe(0);
  });

  it("cancels on abort and keeps the parts already verified", async () => {
    const f = fixture();
    const cache = new MemCache();
    const ctrl = new AbortController();
    let n = 0;
    const p = fetchWeights(f.manifest, {
      ...deps(f, cache),
      signal: ctrl.signal,
      onProgress: () => {
        if (++n === 3) ctrl.abort();
      },
    });
    await expect(p).rejects.toBeInstanceOf(WeightsError);
    await expect(p).rejects.toMatchObject({ code: "canceled" });
    expect(cache.map.size).toBeGreaterThan(0);
    expect(cache.map.size).toBeLessThan(f.manifest.files.reduce((k, x) => k + x.parts.length, 0));
  });
});

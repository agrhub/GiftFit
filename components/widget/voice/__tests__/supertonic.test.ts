import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { chunkText, preprocessText, SupertonicTTS, textToIds, voiceStyle } from "../supertonic/inference";
import { MODEL_FILES, REQUIRED_FILES } from "../supertonic/manifest";
import type { FromWorker } from "../supertonic/protocol";
import { createWorkerCore } from "../supertonic/worker-core";
import type { CacheLike } from "../supertonic/weights";
import { CFG, fakeOrt, INDEXER, modelBytes, VOICE_JSON } from "./fakeOrt";

describe("Supertonic text processing (port of helper.js)", () => {
  it("normalises, replaces symbols, adds a period and wraps in language tags", () => {
    expect(preprocessText("Gold — hoops 🎁 for you", "en")).toBe("<en>Gold - hoops for you.</en>");
    expect(preprocessText("e.g., rings @ $300 !", "en")).toBe("<en>for example, rings at $300!</en>");
    // NFKD: Vietnamese tone marks become combining characters, as in the original.
    expect(preprocessText("Chào bạn", "vi")).toBe(`<vi>${"Chào bạn".normalize("NFKD")}.</vi>`);
    expect(() => preprocessText("x", "fr" as "en")).toThrow(/Invalid language/);
  });

  it("maps code points through the indexer (−1 outside it)", () => {
    const { ids, mask } = textToIds("A", "en", INDEXER);
    const s = "<en>A.</en>";
    expect(Array.from(ids, Number)).toEqual(Array.from(s, (c) => INDEXER[c.codePointAt(0)!]));
    expect(Array.from(mask)).toEqual(new Array(s.length).fill(1));
    expect(Number(textToIds("一", "en", INDEXER).ids[4])).toBe(-1);
  });

  it("chunks long text at sentence boundaries within 300 characters", () => {
    const text = Array.from({ length: 12 }, (_, i) => `Sentence number ${i} talks about a lovely gift idea.`).join(" ");
    const chunks = chunkText(text, 300);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 300 && c.endsWith("."))).toBe(true);
    expect(chunkText("Dr. Smith likes rings. She also likes hoops.", 25)).toEqual(["Dr. Smith likes rings.", "She also likes hoops."]);
  });

  it("runs duration → encoder → N denoising steps → vocoder with the demo's tensor shapes", async () => {
    const { ort, runs } = fakeOrt({ durationSec: 0.105 });
    const sessions = await Promise.all([0, 1, 2, 3].map((i) => ort.InferenceSession.create(modelBytes(i), { executionProviders: ["webgpu"] })));
    const tts = new SupertonicTTS(ort, CFG, INDEXER, { durationPredictor: sessions[0], textEncoder: sessions[1], vectorEstimator: sessions[2], vocoder: sessions[3] });
    const style = voiceStyle(ort, VOICE_JSON);
    expect(style.ttl.dims).toEqual([1, 2, 2]);
    const { wav, duration } = await tts.infer("Hi", "en", style, { steps: 3, speed: 1.05, randn: () => 1 });
    expect(runs.map((r) => r.model)).toEqual(["dp", "enc", "vec", "vec", "vec", "voc"]);
    expect(duration).toBeCloseTo(0.1);
    // 0.1 s at 1000 Hz = 100 samples → latent length ceil(100 / 20) = 5, latent dim 3 × 2 = 6.
    const vec = runs.filter((r) => r.model === "vec");
    expect(vec[0].feeds.noisy_latent.dims).toEqual([1, 6, 5]);
    expect(Array.from(vec.map((r) => Number((r.feeds.current_step.data as Float32Array)[0])))).toEqual([0, 1, 2]);
    expect((runs[0].feeds.text_ids.data as BigInt64Array).constructor).toBe(BigInt64Array);
    // The denoiser's output feeds the next step (×0.5 each step in the fake).
    expect((vec[2].feeds.noisy_latent.data as Float32Array)[0]).toBeCloseTo(0.25);
    // Vocoder output (5 × 20 = 100 samples) trimmed to the predicted duration (float32: 99).
    expect(wav.length).toBe(Math.floor(duration * 1000));
    expect(wav.length).toBeLessThan(100);
  });

  it("call() joins chunks with 0.3 s of silence", async () => {
    const { ort } = fakeOrt({ durationSec: 0.105 });
    const s = await Promise.all([0, 1, 2, 3].map((i) => ort.InferenceSession.create(modelBytes(i), { executionProviders: ["wasm"] })));
    const tts = new SupertonicTTS(ort, CFG, INDEXER, { durationPredictor: s[0], textEncoder: s[1], vectorEstimator: s[2], vocoder: s[3] });
    const long = `${"a".repeat(200)}. ${"b".repeat(200)}.`;
    const pcm = await tts.call(long, "vi", voiceStyle(ort, VOICE_JSON), { steps: 1 });
    const one = Math.floor((Math.fround(0.105) / 1.05) * 1000);
    expect(pcm.length).toBe(one + 300 + one);
  });
});

// ---------------------------------------------------------------- worker

const BASE = "https://giftfit.example/voice/supertonic/aafc6e32/";
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function served() {
  const contents: Record<string, Uint8Array> = {
    [MODEL_FILES.durationPredictor]: modelBytes(0),
    [MODEL_FILES.textEncoder]: modelBytes(1),
    [MODEL_FILES.vectorEstimator]: modelBytes(2),
    [MODEL_FILES.vocoder]: modelBytes(3),
    [MODEL_FILES.config]: new TextEncoder().encode(JSON.stringify(CFG)),
    [MODEL_FILES.indexer]: new TextEncoder().encode(JSON.stringify(INDEXER)),
    [MODEL_FILES.voice]: new TextEncoder().encode(JSON.stringify(VOICE_JSON)),
  };
  const bodies = new Map<string, Uint8Array>();
  const files = REQUIRED_FILES.map((path) => {
    const data = contents[path];
    bodies.set(`${BASE}${path}.part000`, data);
    return { path, size: data.length, sha256: sha(data), parts: [{ path: `${path}.part000`, size: data.length, sha256: sha(data) }] };
  });
  bodies.set(`${BASE}manifest.json`, new TextEncoder().encode(JSON.stringify({ revision: "x", files })));
  return vi.fn(async (url: string | URL | Request) => {
    const b = bodies.get(String(url));
    return b ? new Response(b.slice() as Uint8Array<ArrayBuffer>) : new Response("", { status: 404 });
  });
}

class MemCache implements CacheLike {
  map = new Map<string, Uint8Array>();
  async match(url: string) {
    const b = this.map.get(url);
    return b ? new Response(b.slice() as Uint8Array<ArrayBuffer>) : undefined;
  }
  async put(url: string, res: Response) {
    this.map.set(url, new Uint8Array(await res.arrayBuffer()));
  }
  async delete(url: string) {
    return this.map.delete(url);
  }
}

function worker(o: { failEp?: string; webgpu?: boolean; cache?: MemCache } = {}) {
  const posts: FromWorker[] = [];
  const fake = fakeOrt({ failEp: o.failEp, durationSec: 0.105 });
  const fetchMock = served();
  const importOrt = vi.fn(async () => fake.ort);
  let t = 0;
  const core = createWorkerCore({
    post: (m) => void posts.push(m),
    importOrt,
    fetch: fetchMock as unknown as typeof fetch,
    openCache: async () => o.cache ?? new MemCache(),
    hasWebGPU: () => o.webgpu ?? true,
    now: () => (t += 10),
  });
  const init = (allowDownload = true, ep?: "wasm") => core({ type: "init", base: BASE, ortModule: "https://giftfit.example/voice/ort/1.30.0/ort.webgpu.min.mjs", ortBase: "https://giftfit.example/voice/ort/1.30.0/", allowDownload, ...(ep ? { ep } : {}) });
  return { core, posts, fake, fetchMock, importOrt, init };
}

describe("voice worker", () => {
  it("init: weights → ORT from our origin → WebGPU sessions → ready with timings", async () => {
    const w = worker();
    await w.init();
    expect(w.importOrt).toHaveBeenCalledWith("https://giftfit.example/voice/ort/1.30.0/ort.webgpu.min.mjs");
    expect(w.fake.ort.env.wasm.wasmPaths).toBe("https://giftfit.example/voice/ort/1.30.0/");
    expect(w.fake.created.map((c) => c.ep)).toEqual(["webgpu", "webgpu", "webgpu", "webgpu"]);
    const ready = w.posts.find((p) => p.type === "ready");
    expect(ready).toMatchObject({ type: "ready", ep: "webgpu", timings: { downloaded: expect.any(Number), warmupMs: expect.any(Number), perModelMs: { durationPredictor: expect.any(Number) } } });
    // The warm-up synthesis ran before "ready" (GPU kernels compiled off the first reply).
    expect(w.fake.runs.filter((r) => r.model === "voc").length).toBe(1);
    expect(w.posts.some((p) => p.type === "progress" && p.phase === "weights")).toBe(true);
    expect(w.posts.filter((p) => p.type === "progress" && p.phase === "session")).toHaveLength(4);
  });

  it("falls back to WASM when WebGPU session creation fails, and uses WASM directly without WebGPU", async () => {
    const a = worker({ failEp: "webgpu" });
    await a.init();
    expect(a.posts.find((p) => p.type === "ready")).toMatchObject({ ep: "wasm" });
    const b = worker({ webgpu: false });
    await b.init();
    expect(b.fake.created.every((c) => c.ep === "wasm")).toBe(true);
  });

  it("reports needs-download (and fetches only the manifest) when not allowed and not cached", async () => {
    const w = worker();
    await w.init(false);
    expect(w.posts.at(-1)).toMatchObject({ type: "error", code: "needs-download" });
    expect(w.fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([`${BASE}manifest.json`]);
    expect(w.importOrt).not.toHaveBeenCalled();
  });

  it("synthesises queued requests in order and skips dropped ones", async () => {
    const w = worker();
    await w.init();
    void w.core({ type: "synth", id: 1, text: "Hello there.", lang: "en", steps: 2 });
    void w.core({ type: "drop", id: 2 });
    void w.core({ type: "synth", id: 2, text: "Dropped.", lang: "en" });
    await w.core({ type: "synth", id: 3, text: "Xin chào.", lang: "vi", steps: 1 });
    const audio = w.posts.filter((p) => p.type === "audio");
    expect(audio.map((a) => a.type === "audio" && a.id)).toEqual([1, 3]);
    expect(audio[0]).toMatchObject({ sampleRate: 1000, pcm: expect.any(Float32Array) });
  });

  it("answers synth before ready with an error", async () => {
    const w = worker();
    await w.core({ type: "synth", id: 9, text: "Hi.", lang: "en" });
    expect(w.posts).toEqual([{ type: "synth-error", id: 9, message: "not ready" }]);
  });

  it("cancel during the download posts canceled and loads nothing", async () => {
    const w = worker();
    const p = w.init();
    await w.core({ type: "cancel" });
    await p;
    expect(w.posts.at(-1)).toMatchObject({ type: "error", code: "canceled" });
    expect(w.importOrt).not.toHaveBeenCalled();
  });

  it("a second visit loads from the cache without downloading", async () => {
    const cache = new MemCache();
    await worker({ cache }).init(true);
    const again = worker({ cache });
    await again.init(false);
    expect(again.posts.find((p) => p.type === "ready")).toMatchObject({ timings: { downloaded: 0 } });
    expect(again.fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([`${BASE}manifest.json`]);
  });
});

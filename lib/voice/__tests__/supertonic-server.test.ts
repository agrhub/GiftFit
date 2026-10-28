/** Server-side Supertonic (ADR-057): text processing, inference loop, weights, engine, WAV. Keyless, fake ORT. */
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { loadModel, SupertonicServer } from "../supertonic/engine";
import { isSupertonicLang, preprocessText, splitSentences, SUPERTONIC_LANGS, SynthAbortedError, textToIds } from "../supertonic/inference";
import { partPaths, readVerified, SERVER_FILES, WeightsError } from "../supertonic/weights";
import { decimate2, pcm16Wav, speechWav } from "../wav";
import { fakeModel, fakeOrt, type FakeOptions } from "./fakeOrt";

/** Samples for the fake 0.5 s duration (0.5 × 1.05 through a float32 tensor, / 1.05, at 8 kHz). */
const SAMPLES_05 = Math.floor((Math.fround(0.5 * 1.05) / 1.05) * 8000); // float32 duration tensor
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

describe("text processing (port of helper.js)", () => {
  it("knows Supertonic's 31 languages", () => {
    expect(SUPERTONIC_LANGS).toHaveLength(31);
    for (const l of ["en", "vi", "ja", "es", "ko", "ar", "uk"]) expect(isSupertonicLang(l)).toBe(true);
    for (const l of ["zh", "th", "na", "EN", ""]) expect(isSupertonicLang(l)).toBe(false);
  });

  it("normalises, replaces symbols, adds a final period and wraps in language tags", () => {
    expect(preprocessText("Hi — it’s “great” 😀 @ 5pm", "en")).toBe(`<en>Hi - it's "great" at 5pm.</en>`);
    expect(preprocessText("¿Te gusta?", "es")).toBe("<es>¿Te gusta?</es>");
    expect(preprocessText("毎日つけやすいです。", "ja").normalize("NFC")).toBe("<ja>毎日つけやすいです。</ja>"); // NFKD splits voiced kana
    expect(preprocessText("Xin chào", "vi").normalize("NFC")).toBe("<vi>Xin chào.</vi>");
    expect(() => preprocessText("x", "zh" as never)).toThrow(/unsupported/);
  });

  it("maps characters through the indexer (-1 for unknown)", () => {
    const indexer = Int32Array.from({ length: 200 }, (_, i) => i + 1000);
    const ids = textToIds("A", "en", indexer);
    expect(Array.from(ids).map(Number)).toEqual([..."<en>A.</en>"].map((c) => c.charCodeAt(0) + 1000));
    expect(Number(textToIds("é", "en", indexer)[4])).toBe("e".charCodeAt(0) + 1000); // NFKD splits é → e + U+0301
    expect(Number(textToIds("é", "en", indexer)[5])).toBe(-1);
  });

  it("splits sentences (abbreviations kept), CJK full stops, newlines, and cuts over-long ones", () => {
    expect(splitSentences("Hello Mr. Smith. These are silver! Do you like them? Yes.", "en")).toEqual(["Hello Mr. Smith.", "These are silver!", "Do you like them?", "Yes."]);
    expect(splitSentences("軽いです。毎日つけられます。", "ja")).toEqual(["軽いです。", "毎日つけられます。"]);
    expect(splitSentences("Line one\nLine two", "en")).toEqual(["Line one", "Line two"]);
    const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ");
    const parts = splitSentences(long, "en");
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 300)).toBe(true);
    expect(parts.join(" ")).toBe(long);
    expect(splitSentences("あ".repeat(250), "ja").map((p) => p.length)).toEqual([120, 120, 10]);
  });
});

describe("inference loop (fake ORT)", () => {
  it("runs dp → encoder → N vector-estimator steps → vocoder with the official feed names, and trims to the duration", async () => {
    const calls: NonNullable<FakeOptions["calls"]> = [];
    const m = await fakeModel({ calls, durationSec: 0.5 });
    const pcm = await m.synth.infer("Hello there.", "en", m.style, { steps: 3, randn: () => 0.1 });
    expect(calls.map((c) => c.model)).toEqual(["dp", "enc", "ve", "ve", "ve", "voc"]);
    expect(Object.keys(calls[0].feeds).sort()).toEqual(["style_dp", "text_ids", "text_mask"]);
    expect(Object.keys(calls[2].feeds).sort()).toEqual(["current_step", "latent_mask", "noisy_latent", "style_ttl", "text_emb", "text_mask", "total_step"]);
    expect(Array.from(calls[4].feeds.current_step.data as Float32Array)).toEqual([2]);
    expect(Object.keys(calls[5].feeds)).toEqual(["latent"]);
    expect(pcm.length).toBe(SAMPLES_05); // duration 0.525 s / speed 1.05
  });

  it("stops between model runs when aborted", async () => {
    const m = await fakeModel({ stepDelayMs: 20 });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 30);
    await expect(m.synth.infer("Hello.", "en", m.style, { steps: 8, signal: ctrl.signal })).rejects.toBeInstanceOf(SynthAbortedError);
  });
});

describe("weights from the image's parts", () => {
  it("uses the same pinned files and part rule as scripts/fetch-supertonic.mjs", async () => {
    const script = (await import(/* @vite-ignore */ pathToFileURL(path.resolve(__dirname, "../../../scripts/fetch-supertonic.mjs")).href)) as {
      MODEL_FILES: Record<string, { size: number; sha256: string }>;
      VOICE_STYLES: Record<string, { size: number; sha256: string }>;
      partPaths(rel: string, size: number): string[];
    };
    expect(SERVER_FILES).toEqual({ ...script.MODEL_FILES, "voice_styles/M1.json": script.VOICE_STYLES.M1 });
    for (const [rel, f] of Object.entries(SERVER_FILES)) expect(partPaths(rel, f.size)).toEqual(script.partPaths(rel, f.size));
  });

  it("reassembles parts in order and verifies size and sha256", async () => {
    const whole = Uint8Array.from({ length: 50 }, (_, i) => i);
    const pinned = { size: 50, sha256: sha(whole) };
    const files: Record<string, Uint8Array> = {};
    const names = partPaths("m.onnx", 50, 16);
    expect(names).toEqual(["m.onnx.part000", "m.onnx.part001", "m.onnx.part002", "m.onnx.part003"]);
    names.forEach((p, i) => (files[path.join("/w", p)] = whole.subarray(i * 16, i * 16 + 16)));
    const seen: string[] = [];
    const read = async (p: string) => {
      seen.push(path.basename(p));
      if (!files[p]) throw new Error("ENOENT");
      return files[p];
    };
    expect(Buffer.compare(await readVerified("/w", "m.onnx", pinned, read, 16), Buffer.from(whole))).toBe(0);
    expect(seen).toEqual(names);
    await expect(readVerified("/w", "m.onnx", { size: 50, sha256: "0".repeat(64) }, read, 16)).rejects.toMatchObject({ code: "checksum" });
    await expect(readVerified("/w", "m.onnx", { size: 49, sha256: pinned.sha256 }, read, 16)).rejects.toMatchObject({ code: "checksum" });
    await expect(readVerified("/w", "missing.onnx", pinned, read, 16)).rejects.toBeInstanceOf(WeightsError);
    // The real vector estimator is served as 16 parts.
    expect(partPaths("onnx/vector_estimator.onnx", SERVER_FILES["onnx/vector_estimator.onnx"].size)).toHaveLength(16);
  });

  it("loadModel verifies every file and creates the four sessions from bytes", async () => {
    const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
    const contents: Record<string, Uint8Array> = {
      "onnx/tts.json": enc({ ae: { sample_rate: 8000, base_chunk_size: 100 }, ttl: { chunk_compress_factor: 2, latent_dim: 3 } }),
      "onnx/unicode_indexer.json": enc(Array.from({ length: 300 }, (_, i) => i)),
      "voice_styles/M1.json": enc({ style_ttl: { dims: [1, 2, 4], data: [[[0, 0, 0, 0], [0, 0, 0, 0]]] }, style_dp: { dims: [1, 2, 4], data: [[[0, 0, 0, 0], [0, 0, 0, 0]]] } }),
      "onnx/duration_predictor.onnx": new Uint8Array([1]),
      "onnx/text_encoder.onnx": new Uint8Array([2]),
      "onnx/vector_estimator.onnx": new Uint8Array([3]),
      "onnx/vocoder.onnx": new Uint8Array([4]),
    };
    const files = Object.fromEntries(Object.entries(contents).map(([k, v]) => [k, { size: v.length, sha256: sha(v) }]));
    const read = async (p: string) => contents[path.relative("/w", p).replace(/\\/g, "/")];
    const m = await loadModel({ threads: 1 }, { ort: fakeOrt(), dir: "/w", read, files });
    expect(m.synth.sampleRate).toBe(8000);
    const pcm = await m.synth.infer("Hi.", "en", m.style, { steps: 2 });
    expect(pcm.length).toBeGreaterThan(0);
    await expect(loadModel({ threads: 1 }, { ort: fakeOrt(), dir: "/w", read, files: { ...files, "onnx/vocoder.onnx": { size: 1, sha256: "f".repeat(64) } } })).rejects.toBeInstanceOf(WeightsError);
  });
});

describe("SupertonicServer engine", () => {
  const engine = (o: FakeOptions & { fail?: boolean } = {}) =>
    new SupertonicServer({ threads: 1, steps: 3, log: () => undefined, load: async () => (o.fail ? Promise.reject(Object.assign(new Error("x"), { code: "missing" })) : fakeModel(o)) });

  it("is lazy: nothing loads until ensureLoaded(); then ready with a load time", async () => {
    let loads = 0;
    const e = new SupertonicServer({ threads: 1, steps: 2, log: () => undefined, load: async () => (loads++, fakeModel()) });
    expect(e.state).toBe("idle");
    expect(loads).toBe(0);
    await expect(e.synthesize(["Hi."], "en")).rejects.toThrow(/not ready/);
    e.ensureLoaded();
    e.ensureLoaded();
    expect(e.state).toBe("loading");
    expect(await e.waitReady(1000)).toBe(true);
    expect(loads).toBe(1);
    expect(e.metrics()).toMatchObject({ state: "ready", loadMs: expect.any(Number) });
  });

  it("a failed load is reported (code only) and retried on the next ensureLoaded()", async () => {
    const e = engine({ fail: true });
    expect(await e.waitReady(1000)).toBe(false);
    expect(e.state).toBe("failed");
    expect(e.metrics().lastErrorCode).toBe("missing");
  });

  it("one synthesis at a time: concurrent requests queue (FIFO) and the queue is visible", async () => {
    const e = engine({ stepDelayMs: 5 });
    await e.waitReady(1000);
    const order: number[] = [];
    const runs = [0, 1, 2].map((i) => e.synthesize(["One.", "Two."], "en").then((r) => (order.push(i), r)));
    expect(e.queued()).toBe(3);
    const results = await Promise.all(runs);
    expect(order).toEqual([0, 1, 2]);
    expect(results.every((r) => r.sentences === 2 && r.sentenceMs.length === 2)).toBe(true);
    expect(results[2].queueMs).toBeGreaterThan(0);
    expect(e.queued()).toBe(0);
    expect(e.metrics()).toMatchObject({ requests: 3, sentences: 6, queue: { maxQueued: 3 } });
  });

  it("a sentence over budget is aborted (counted), and the engine keeps serving", async () => {
    const e = engine({ stepDelayMs: 25 });
    await e.waitReady(1000);
    await expect(e.synthesize(["Slow sentence."], "en", { budgetMs: 40 })).rejects.toBeInstanceOf(SynthAbortedError);
    expect(e.metrics().aborted).toBe(1);
    const ok = await e.synthesize(["Fine."], "en");
    expect(ok.pcm.length).toBeGreaterThan(0);
  });

  it("joins sentences with a short silence and reports real-time factor", async () => {
    const e = engine({ durationSec: 0.5 });
    await e.waitReady(1000);
    const r = await e.synthesize(["One.", "Two."], "en", { gapSec: 0.25 });
    expect(r.pcm.length).toBe(SAMPLES_05 + 2000 + SAMPLES_05);
    expect(r.sampleRate).toBe(8000);
    const m = e.metrics();
    expect(m.rtf.p50).not.toBeNull();
    expect(JSON.stringify(m)).not.toMatch(/One|Two/);
  });
});

describe("WAV output", () => {
  it("halves 44.1 kHz to 22.05 kHz, keeps low tones and cuts tones above the new Nyquist", () => {
    const tone = (hz: number) => Float32Array.from({ length: 4410 }, (_, i) => Math.sin((2 * Math.PI * hz * i) / 44_100));
    const rms = (a: Float32Array) => Math.sqrt(a.slice(100, -100).reduce((s, v) => s + v * v, 0) / (a.length - 200));
    expect(decimate2(tone(1000)).length).toBe(2205);
    expect(rms(decimate2(tone(1000)))).toBeGreaterThan(0.65);
    expect(rms(decimate2(tone(16_000)))).toBeLessThan(0.05);
  });

  it("writes a 16-bit mono WAV header and clamps samples", () => {
    const w = pcm16Wav(new Float32Array([0, 2, -2]), 22_050);
    const v = new DataView(w.buffer);
    expect(new TextDecoder().decode(w.subarray(0, 4))).toBe("RIFF");
    expect(v.getUint32(24, true)).toBe(22_050);
    expect(v.getInt16(46, true)).toBe(32767);
    expect(v.getInt16(48, true)).toBe(-32767);
    expect(speechWav(new Float32Array(44_100), 44_100)).toMatchObject({ sampleRate: 22_050, durationMs: 1000 });
  });
});

/** The voice asset scripts' pure parts and their agreement with lib/voice/assets.ts (no network, no weights). */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { ORT_BASE, ORT_WEB_VERSION, SUPERTONIC_BASE, SUPERTONIC_REVISION, SUPERTONIC_VOICE } from "../assets";

type FetchScript = {
  REVISION: string;
  SHORT_REV: string;
  PART_SIZE: number;
  MODEL_FILES: Record<string, { size: number; sha256: string }>;
  VOICE_STYLES: Record<string, { size: number; sha256: string }>;
  LICENSE_FILE: { size: number; sha256: string };
  DEFAULT_VOICES: string[];
  partPaths(rel: string, size: number, partSize?: number): string[];
  wantedFiles(env?: Record<string, string | undefined>): Record<string, { size: number; sha256: string }>;
  noticeText(voices: string[]): string;
};
type OrtScript = { EXPECTED_VERSION: string; CLOUD_RUN_RESPONSE_CAP: number; isRuntimeFile(n: string): boolean; ORT_MIT_LICENSE: string };

const ROOT = path.resolve(__dirname, "../../..");
const load = async <T>(rel: string) => (await import(/* @vite-ignore */ pathToFileURL(path.join(ROOT, rel)).href)) as T;

describe("scripts/fetch-supertonic.mjs", () => {
  it("pins the archived revision the widget loads and ships the files A4 needs", async () => {
    const s = await load<FetchScript>("scripts/fetch-supertonic.mjs");
    expect(s.REVISION).toBe(SUPERTONIC_REVISION);
    expect(SUPERTONIC_BASE).toBe(`/voice/supertonic/${s.SHORT_REV}/`);
    expect(s.DEFAULT_VOICES).toEqual([SUPERTONIC_VOICE]);
    expect(Object.keys(s.wantedFiles({})).sort()).toEqual(
      ["onnx/duration_predictor.onnx", "onnx/text_encoder.onnx", "onnx/vector_estimator.onnx", "onnx/vocoder.onnx", "onnx/tts.json", "onnx/unicode_indexer.json", "voice_styles/M1.json"].sort(),
    );
    for (const f of [...Object.values(s.MODEL_FILES), ...Object.values(s.VOICE_STYLES), s.LICENSE_FILE]) {
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(f.size).toBeGreaterThan(0);
    }
    expect(() => s.wantedFiles({ SUPERTONIC_VOICES: "X9" })).toThrow(/unknown Supertonic voice/);
    expect(Object.keys(s.wantedFiles({ SUPERTONIC_VOICES: "m1,f1" }))).toContain("voice_styles/F1.json");
  });

  it("splits files over 16 MiB into ordered parts under Cloud Run's 32 MiB cap", async () => {
    const s = await load<FetchScript>("scripts/fetch-supertonic.mjs");
    expect(s.PART_SIZE).toBe(16 * 1024 * 1024);
    expect(s.partPaths("onnx/tts.json", 8253)).toEqual(["onnx/tts.json"]);
    expect(s.partPaths("a.onnx", s.PART_SIZE)).toEqual(["a.onnx"]);
    expect(s.partPaths("a.onnx", s.PART_SIZE + 1)).toEqual(["a.onnx.part000", "a.onnx.part001"]);
    const ve = s.MODEL_FILES["onnx/vector_estimator.onnx"];
    const parts = s.partPaths("onnx/vector_estimator.onnx", ve.size);
    expect(parts).toHaveLength(Math.ceil(ve.size / s.PART_SIZE));
    expect(parts.at(-1)).toBe(`onnx/vector_estimator.onnx.part${String(parts.length - 1).padStart(3, "0")}`);
  });

  it("NOTICE states the licence, the use restrictions and that the weights are unmodified", async () => {
    const s = await load<FetchScript>("scripts/fetch-supertonic.mjs");
    const n = s.noticeText(["M1"]);
    expect(n).toMatch(/Open RAIL-M/);
    expect(n).toMatch(/Attachment A/);
    expect(n).toMatch(/NOT modified/);
    expect(n).toContain(SUPERTONIC_REVISION);
  });
});

describe("scripts/copy-ort-web.mjs", () => {
  it("copies the runtime files the engine loads, at the version the widget expects", async () => {
    const o = await load<OrtScript>("scripts/copy-ort-web.mjs");
    expect(o.EXPECTED_VERSION).toBe(ORT_WEB_VERSION);
    expect(ORT_BASE).toBe(`/voice/ort/${o.EXPECTED_VERSION}/`);
    for (const n of ["ort.webgpu.min.mjs", "ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.jsep.wasm", "ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jspi.wasm", "ort-wasm-simd-threaded.asyncify.wasm"]) expect(o.isRuntimeFile(n), n).toBe(true);
    for (const n of ["ort.webgpu.min.mjs.map", "ort.min.js", "ort.all.min.mjs", "ort-wasm-simd-threaded.wasm.map"]) expect(o.isRuntimeFile(n), n).toBe(false);
    expect(o.ORT_MIT_LICENSE).toMatch(/^MIT License\n\nCopyright \(c\) Microsoft Corporation/);
  });
});

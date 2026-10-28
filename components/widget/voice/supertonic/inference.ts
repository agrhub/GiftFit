/**
 * Supertonic 3 text-to-speech inference for the browser (owner: A4, P8.3).
 *
 * MIT, Copyright (c) 2025 Supertone Inc. Modified by the GiftFit team.
 *
 * Ported to TypeScript from Supertone's official web demo, `web/helper.js` in
 * https://github.com/supertone-inc/supertonic (archived as supertone-oss-archive/supertonic, commit
 * 1e9799e964ea4c0dad7cde993b65c3c813a7b373):
 *
 *   MIT License
 *   Copyright (c) 2025 Supertone Inc.
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
 *   associated documentation files (the "Software"), to deal in the Software without restriction,
 *   including without limitation the rights to use, copy, modify, merge, publish, distribute,
 *   sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions:
 *
 *   The above copyright notice and this permission notice shall be included in all copies or
 *   substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
 *   NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 *   NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 *   DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
 *   OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 * Modified by the GiftFit team: TypeScript; onnxruntime-web is injected (loaded at runtime from the
 * GiftFit origin, so this file is testable with a fake runtime); flat typed arrays instead of nested
 * JS arrays; sessions are created from verified in-memory bytes instead of URLs; only en and vi are
 * accepted; the noise source is injectable. The model weights are NOT covered by this licence: they
 * are under the BigScience Open RAIL-M License (see /voice/supertonic/aafc6e32/LICENSE).
 */

/** The parts of onnxruntime-web this file uses (structural, so tests can pass a fake). */
export interface OrtTensor {
  readonly data: ArrayLike<number> | ArrayLike<bigint>;
  readonly dims: readonly number[];
}
export interface OrtSession {
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
  release?(): Promise<void>;
}
export interface OrtLike {
  Tensor: new (type: "float32" | "int64", data: Float32Array | BigInt64Array, dims: readonly number[]) => OrtTensor;
  InferenceSession: { create(model: Uint8Array, options?: Record<string, unknown>): Promise<OrtSession> };
  env?: { wasm?: { wasmPaths?: unknown; numThreads?: number; proxy?: boolean }; logLevel?: string };
}

/**
 * The 31 languages of Supertonic 3 (helper.js AVAILABLE_LANGS without "na"), the same list as the
 * server engine (lib/voice/supertonic/inference.ts). Widget locales outside it (zh, th) never use the
 * in-browser voice: they go to the server, which routes them to Google TTS (ADR-057).
 */
export const SUPERTONIC_LANGS = [
  "en", "ko", "ja", "ar", "bg", "cs", "da", "de", "el", "es", "et", "fi", "fr", "hi", "hr", "hu",
  "id", "it", "lt", "lv", "nl", "pl", "pt", "ro", "ru", "sk", "sl", "sv", "tr", "uk", "vi",
] as const;
export type SupertonicLang = (typeof SUPERTONIC_LANGS)[number];

export function isSupertonicLang(v: unknown): v is SupertonicLang {
  return typeof v === "string" && (SUPERTONIC_LANGS as readonly string[]).includes(v);
}

export interface SupertonicConfig {
  ae: { sample_rate: number; base_chunk_size: number };
  ttl: { chunk_compress_factor: number; latent_dim: number };
}

export interface VoiceStyleJson {
  style_ttl: { dims: number[]; data: unknown };
  style_dp: { dims: number[]; data: unknown };
}

const EMOJI =
  /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu;

const REPLACEMENTS: Array<[string, string]> = [
  ["–", "-"],
  ["‑", "-"],
  ["—", "-"],
  ["_", " "],
  ["“", '"'],
  ["”", '"'],
  ["‘", "'"],
  ["’", "'"],
  ["´", "'"],
  ["`", "'"],
  ["[", " "],
  ["]", " "],
  ["|", " "],
  ["/", " "],
  ["#", " "],
  ["→", " "],
  ["←", " "],
  ["@", " at "],
  ["e.g.,", "for example, "],
  ["i.e.,", "that is, "],
];

/** helper.js UnicodeProcessor.preprocessText. */
export function preprocessText(input: string, lang: SupertonicLang): string {
  if (!isSupertonicLang(lang)) throw new Error(`Invalid language: ${lang}`);
  let text = input.normalize("NFKD").replace(EMOJI, "");
  for (const [k, v] of REPLACEMENTS) text = text.replaceAll(k, v);
  text = text.replace(/[♥☆♡©\\]/g, "");
  text = text.replace(/ ,/g, ",").replace(/ \./g, ".").replace(/ !/g, "!").replace(/ \?/g, "?").replace(/ ;/g, ";").replace(/ :/g, ":").replace(/ '/g, "'");
  while (text.includes('""')) text = text.replace('""', '"');
  while (text.includes("''")) text = text.replace("''", "'");
  text = text.replace(/\s+/g, " ").trim();
  if (!/[.!?;:,'"')\]}…。」』】〉》›»]$/.test(text)) text += ".";
  return `<${lang}>${text}</${lang}>`;
}

/** helper.js UnicodeProcessor.call for one text: token ids (int64) and mask. */
export function textToIds(text: string, lang: SupertonicLang, indexer: readonly number[]): { ids: BigInt64Array; mask: Float32Array } {
  const s = preprocessText(text, lang);
  const ids = new BigInt64Array(s.length);
  for (let j = 0; j < s.length; j++) {
    const cp = s.codePointAt(j)!;
    ids[j] = BigInt(cp < indexer.length ? indexer[cp] : -1);
  }
  return { ids, mask: new Float32Array(s.length).fill(1) };
}

/** helper.js chunkText (paragraphs, then sentences packed up to maxLen). */
export function chunkText(text: string, maxLen = 300): string[] {
  const paragraphs = text
    .trim()
    .split(/\n\s*\n+/)
    .filter((p) => p.trim());
  const chunks: string[] = [];
  for (const para of paragraphs) {
    const sentences = para.trim().split(/(?<!Mr\.|Mrs\.|Ms\.|Dr\.|Prof\.|Sr\.|Jr\.|Ph\.D\.|etc\.|e\.g\.|i\.e\.|vs\.|Inc\.|Ltd\.|Co\.|Corp\.|St\.|Ave\.|Blvd\.)(?<!\b[A-Z]\.)(?<=[.!?])\s+/);
    let cur = "";
    for (const s of sentences) {
      if (cur.length + s.length + 1 <= maxLen) cur += (cur ? " " : "") + s;
      else {
        if (cur) chunks.push(cur.trim());
        cur = s;
      }
    }
    if (cur) chunks.push(cur.trim());
  }
  return chunks;
}

function flatNumbers(data: unknown): Float32Array {
  const flat = Array.isArray(data) ? (data as unknown[]).flat(Infinity as 1) : [];
  return Float32Array.from(flat as number[]);
}

export interface Style {
  ttl: OrtTensor;
  dp: OrtTensor;
}

/** helper.js loadVoiceStyle for one voice JSON. */
export function voiceStyle(ort: OrtLike, json: VoiceStyleJson): Style {
  const td = json.style_ttl.dims;
  const dd = json.style_dp.dims;
  return {
    ttl: new ort.Tensor("float32", flatNumbers(json.style_ttl.data), [1, td[1], td[2]]),
    dp: new ort.Tensor("float32", flatNumbers(json.style_dp.data), [1, dd[1], dd[2]]),
  };
}

export interface Sessions {
  durationPredictor: OrtSession;
  textEncoder: OrtSession;
  vectorEstimator: OrtSession;
  vocoder: OrtSession;
}

export interface SynthOptions {
  /** Denoising steps (the demo's UI default is 8; fewer is faster). */
  steps?: number;
  speed?: number;
  silenceSec?: number;
  /** Standard-normal noise source (tests pass a deterministic one). */
  randn?: () => number;
}

function boxMuller(): number {
  const u1 = Math.max(0.0001, Math.random());
  const u2 = Math.random();
  return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
}

export class SupertonicTTS {
  readonly sampleRate: number;
  constructor(
    private readonly ort: OrtLike,
    private readonly cfg: SupertonicConfig,
    private readonly indexer: readonly number[],
    private readonly s: Sessions,
  ) {
    this.sampleRate = cfg.ae.sample_rate;
  }

  /** helper.js TextToSpeech._infer, batch size 1. Returns mono float PCM. */
  async infer(text: string, lang: SupertonicLang, style: Style, o: SynthOptions = {}): Promise<{ wav: Float32Array; duration: number }> {
    const { Tensor } = this.ort;
    const steps = o.steps ?? 5;
    const speed = o.speed ?? 1.05;
    const randn = o.randn ?? boxMuller;
    const { ids, mask } = textToIds(text, lang, this.indexer);
    const textIds = new Tensor("int64", ids, [1, ids.length]);
    const textMask = new Tensor("float32", mask, [1, 1, mask.length]);

    const dp = await this.s.durationPredictor.run({ text_ids: textIds, style_dp: style.dp, text_mask: textMask });
    const duration = Number((dp.duration.data as ArrayLike<number>)[0]) / speed;

    const enc = await this.s.textEncoder.run({ text_ids: textIds, style_ttl: style.ttl, text_mask: textMask });
    const textEmb = enc.text_emb;

    // sampleNoisyLatent
    const wavLen = Math.floor(duration * this.sampleRate);
    const chunkSize = this.cfg.ae.base_chunk_size * this.cfg.ttl.chunk_compress_factor;
    const latentLen = Math.max(1, Math.floor((wavLen + chunkSize - 1) / chunkSize));
    const latentDim = this.cfg.ttl.latent_dim * this.cfg.ttl.chunk_compress_factor;
    let xt = new Float32Array(latentDim * latentLen);
    for (let d = 0; d < latentDim; d++) for (let t = 0; t < latentLen; t++) xt[d * latentLen + t] = randn();
    // Batch size 1: the latent mask is all ones (the sequence is its own maximum length).
    const latentMask = new Tensor("float32", new Float32Array(latentLen).fill(1), [1, 1, latentLen]);
    const totalStep = new Tensor("float32", new Float32Array([steps]), [1]);

    for (let step = 0; step < steps; step++) {
      const out = await this.s.vectorEstimator.run({
        noisy_latent: new Tensor("float32", xt, [1, latentDim, latentLen]),
        text_emb: textEmb,
        style_ttl: style.ttl,
        latent_mask: latentMask,
        text_mask: textMask,
        current_step: new Tensor("float32", new Float32Array([step]), [1]),
        total_step: totalStep,
      });
      xt = Float32Array.from(out.denoised_latent.data as ArrayLike<number>);
    }

    const voc = await this.s.vocoder.run({ latent: new Tensor("float32", xt, [1, latentDim, latentLen]) });
    const wav = Float32Array.from(voc.wav_tts.data as ArrayLike<number>);
    // The vocoder pads to whole chunks; trim to the predicted duration like the demo's player does.
    return { wav: wavLen > 0 && wavLen < wav.length ? wav.subarray(0, wavLen) : wav, duration };
  }

  /** helper.js TextToSpeech.call: chunks of ≤ 300 chars joined with short silences. */
  async call(text: string, lang: SupertonicLang, style: Style, o: SynthOptions = {}): Promise<Float32Array> {
    const silence = Math.floor((o.silenceSec ?? 0.3) * this.sampleRate);
    const parts: Float32Array[] = [];
    for (const chunk of chunkText(text, 300)) {
      if (parts.length) parts.push(new Float32Array(silence));
      parts.push((await this.infer(chunk, lang, style, o)).wav);
    }
    const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }
}

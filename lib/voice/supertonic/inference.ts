/**
 * Supertonic 3 text-to-speech inference on the SERVER (owner: A13, ADR-057 spike), onnxruntime-node.
 *
 * MIT, Copyright (c) 2025 Supertone Inc. Modified by the GiftFit team.
 *
 * Ported to TypeScript from Supertone's official Node example, `nodejs/helper.js` in
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
 * Modified by the GiftFit team: TypeScript; the runtime is injected (structural types, so tests use a
 * fake); batch size 1 with flat typed arrays; sessions come from verified in-memory bytes; an abort
 * signal is checked between model runs; sentence splitting for streaming-style synthesis; the noise
 * source is injectable. The model weights are NOT covered by this licence: they are under the
 * BigScience Open RAIL-M License (public/voice/supertonic/aafc6e32/LICENSE).
 */

/** The parts of onnxruntime this file uses. */
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
}

/** The 31 languages of Supertonic 3 (helper.js AVAILABLE_LANGS without the language-agnostic "na"). */
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
  ["–", "-"], ["‑", "-"], ["—", "-"], ["_", " "],
  ["“", '"'], ["”", '"'], ["‘", "'"], ["’", "'"], ["´", "'"], ["`", "'"],
  ["[", " "], ["]", " "], ["|", " "], ["/", " "], ["#", " "], ["→", " "], ["←", " "],
];
const EXPRESSIONS: Array<[string, string]> = [
  ["@", " at "],
  ["e.g.,", "for example, "],
  ["i.e.,", "that is, "],
];

/** helper.js UnicodeProcessor._preprocessText. */
export function preprocessText(input: string, lang: SupertonicLang): string {
  if (!isSupertonicLang(lang)) throw new Error(`unsupported language: ${String(lang)}`);
  let text = input.normalize("NFKD").replace(EMOJI, "");
  for (const [k, v] of REPLACEMENTS) text = text.replaceAll(k, v);
  text = text.replace(/[♥☆♡©\\]/g, "");
  for (const [k, v] of EXPRESSIONS) text = text.replaceAll(k, v);
  text = text.replace(/ ,/g, ",").replace(/ \./g, ".").replace(/ !/g, "!").replace(/ \?/g, "?").replace(/ ;/g, ";").replace(/ :/g, ":").replace(/ '/g, "'");
  while (text.includes('""')) text = text.replace('""', '"');
  while (text.includes("''")) text = text.replace("''", "'");
  text = text.replace(/\s+/g, " ").trim();
  if (!/[.!?;:,'"')\]}…。」』】〉》›»]$/.test(text)) text += ".";
  return `<${lang}>${text}</${lang}>`;
}

/** helper.js UnicodeProcessor.call for one text: token ids (int64; -1 for characters the model lacks). */
export function textToIds(text: string, lang: SupertonicLang, indexer: ArrayLike<number>): BigInt64Array {
  const chars = Array.from(preprocessText(text, lang));
  const ids = new BigInt64Array(chars.length);
  for (let j = 0; j < chars.length; j++) {
    const cu = chars[j].charCodeAt(0);
    const id = cu < indexer.length ? indexer[cu] : -1;
    ids[j] = BigInt(Number.isFinite(id) ? id : -1);
  }
  return ids;
}

const ABBREVIATIONS = /(?<!Mr\.|Mrs\.|Ms\.|Dr\.|Prof\.|Sr\.|Jr\.|Ph\.D\.|etc\.|e\.g\.|i\.e\.|vs\.|Inc\.|Ltd\.|Co\.|Corp\.|St\.|Ave\.|Blvd\.)(?<!\b[A-Z]\.)/;

/**
 * Sentences for sentence-by-sentence synthesis (helper.js chunkText's sentence rule, plus CJK full
 * stops and newlines), each at most `maxLen` characters (120 for ko/ja like helper.js, else 300);
 * an over-long sentence is cut on spaces (or anywhere, for scripts without spaces).
 */
export function splitSentences(text: string, lang: SupertonicLang): string[] {
  const maxLen = lang === "ko" || lang === "ja" ? 120 : 300;
  const re = new RegExp(`${ABBREVIATIONS.source}(?<=[.!?…])\\s+|(?<=[。！？])\\s*|\\n+`, "u");
  const out: string[] = [];
  for (const raw of text.split(re)) {
    const s = raw?.replace(/\s+/g, " ").trim();
    if (!s) continue;
    if (s.length <= maxLen) {
      out.push(s);
      continue;
    }
    let cur = "";
    for (const word of s.includes(" ") ? s.split(" ") : Array.from(s)) {
      const sep = s.includes(" ") && cur ? " " : "";
      if ((cur + sep + word).length > maxLen && cur) {
        out.push(cur);
        cur = word;
      } else cur += sep + word;
    }
    if (cur) out.push(cur);
  }
  return out;
}

function flatNumbers(data: unknown): Float32Array {
  const flat = Array.isArray(data) ? (data as unknown[]).flat(Infinity as 1) : [];
  return Float32Array.from(flat as number[]);
}

export interface Style {
  ttl: OrtTensor;
  dp: OrtTensor;
}

/** helper.js loadVoiceStyle for one stock voice JSON. */
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
  steps?: number;
  speed?: number;
  /** Checked between model runs; an aborted synthesis throws SynthAbortedError. */
  signal?: AbortSignal;
  randn?: () => number;
}

export class SynthAbortedError extends Error {
  constructor() {
    super("synthesis aborted");
    this.name = "SynthAbortedError";
  }
}

function boxMuller(): number {
  const u1 = Math.max(1e-10, Math.random());
  const u2 = Math.random();
  return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
}

export class SupertonicSynth {
  readonly sampleRate: number;
  constructor(
    private readonly ort: OrtLike,
    private readonly cfg: SupertonicConfig,
    private readonly indexer: ArrayLike<number>,
    private readonly s: Sessions,
  ) {
    this.sampleRate = cfg.ae.sample_rate;
  }

  /** helper.js TextToSpeech._infer, batch size 1: mono float PCM at `sampleRate`, trimmed to the predicted duration. */
  async infer(text: string, lang: SupertonicLang, style: Style, o: SynthOptions = {}): Promise<Float32Array> {
    const { Tensor } = this.ort;
    const steps = o.steps ?? 5;
    const speed = o.speed ?? 1.05;
    const randn = o.randn ?? boxMuller;
    const check = () => {
      if (o.signal?.aborted) throw new SynthAbortedError();
    };
    check();
    const ids = textToIds(text, lang, this.indexer);
    const textIds = new Tensor("int64", ids, [1, ids.length]);
    const textMask = new Tensor("float32", new Float32Array(ids.length).fill(1), [1, 1, ids.length]);

    const dp = await this.s.durationPredictor.run({ text_ids: textIds, style_dp: style.dp, text_mask: textMask });
    const duration = Number((dp.duration.data as ArrayLike<number>)[0]) / speed;
    check();
    const enc = await this.s.textEncoder.run({ text_ids: textIds, style_ttl: style.ttl, text_mask: textMask });
    check();

    const wavLen = Math.floor(duration * this.sampleRate);
    const chunkSize = this.cfg.ae.base_chunk_size * this.cfg.ttl.chunk_compress_factor;
    const latentLen = Math.max(1, Math.floor((wavLen + chunkSize - 1) / chunkSize));
    const latentDim = this.cfg.ttl.latent_dim * this.cfg.ttl.chunk_compress_factor;
    let xt = new Float32Array(latentDim * latentLen);
    for (let i = 0; i < xt.length; i++) xt[i] = randn();
    const latentMask = new Tensor("float32", new Float32Array(latentLen).fill(1), [1, 1, latentLen]);
    const totalStep = new Tensor("float32", new Float32Array([steps]), [1]);

    for (let step = 0; step < steps; step++) {
      const out = await this.s.vectorEstimator.run({
        noisy_latent: new Tensor("float32", xt, [1, latentDim, latentLen]),
        text_emb: enc.text_emb,
        style_ttl: style.ttl,
        text_mask: textMask,
        latent_mask: latentMask,
        total_step: totalStep,
        current_step: new Tensor("float32", new Float32Array([step]), [1]),
      });
      xt = Float32Array.from(out.denoised_latent.data as ArrayLike<number>);
      check();
    }

    const voc = await this.s.vocoder.run({ latent: new Tensor("float32", xt, [1, latentDim, latentLen]) });
    const wav = voc.wav_tts.data as ArrayLike<number>;
    const n = wavLen > 0 && wavLen < wav.length ? wavLen : wav.length;
    const outPcm = new Float32Array(n);
    for (let i = 0; i < n; i++) outPcm[i] = Number(wav[i]);
    return outPcm;
  }
}

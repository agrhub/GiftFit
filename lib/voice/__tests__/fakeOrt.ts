/** A tiny fake onnxruntime for the server Supertonic tests (no weights, no native code). */
import type { LoadedModel } from "../supertonic/engine";
import { SupertonicSynth, type OrtLike, type OrtSession, type OrtTensor, type SupertonicConfig } from "../supertonic/inference";

export class FakeTensor implements OrtTensor {
  constructor(
    readonly type: "float32" | "int64",
    readonly data: Float32Array | BigInt64Array,
    readonly dims: readonly number[],
  ) {}
}

export const FAKE_CFG: SupertonicConfig = { ae: { sample_rate: 8000, base_chunk_size: 100 }, ttl: { chunk_compress_factor: 2, latent_dim: 3 } };

export interface FakeOptions {
  /** Seconds the duration predictor reports (before speed). */
  durationSec?: number;
  /** Delay per vector-estimator step (ms). */
  stepDelayMs?: number;
  /** Every run's feed names, for shape assertions. */
  calls?: Array<{ model: string; feeds: Record<string, OrtTensor> }>;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function fakeOrt(o: FakeOptions = {}): OrtLike {
  const calls = o.calls;
  const session = (model: string, run: (f: Record<string, OrtTensor>) => Promise<Record<string, OrtTensor>>): OrtSession => ({
    async run(feeds) {
      calls?.push({ model, feeds });
      return run(feeds);
    },
  });
  const sessions: Record<string, OrtSession> = {
    dp: session("dp", async () => ({ duration: new FakeTensor("float32", new Float32Array([(o.durationSec ?? 0.5) * 1.05]), [1]) })),
    enc: session("enc", async (f) => ({ text_emb: new FakeTensor("float32", new Float32Array(4 * f.text_ids.dims[1]), [1, 4, f.text_ids.dims[1]]) })),
    ve: session("ve", async (f) => {
      if (o.stepDelayMs) await delay(o.stepDelayMs);
      const x = f.noisy_latent.data as Float32Array;
      return { denoised_latent: new FakeTensor("float32", x.map((v) => v * 0.5), f.noisy_latent.dims) };
    }),
    voc: session("voc", async (f) => {
      const latentLen = f.latent.dims[2];
      const n = latentLen * FAKE_CFG.ae.base_chunk_size * FAKE_CFG.ttl.chunk_compress_factor;
      return { wav_tts: new FakeTensor("float32", Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 220 * i) / FAKE_CFG.ae.sample_rate)), [1, n]) };
    }),
  };
  const order = ["dp", "enc", "ve", "voc"];
  let next = 0;
  return {
    Tensor: FakeTensor as unknown as OrtLike["Tensor"],
    InferenceSession: { create: async () => sessions[order[next++ % order.length]] },
  };
}

/** A loaded model on the fake runtime (what SupertonicServer's `load` returns). */
export async function fakeModel(o: FakeOptions = {}): Promise<LoadedModel> {
  const ort = fakeOrt(o);
  const create = () => ort.InferenceSession.create(new Uint8Array());
  const sessions = { durationPredictor: await create(), textEncoder: await create(), vectorEstimator: await create(), vocoder: await create() };
  const indexer = Int32Array.from({ length: 65536 }, (_, i) => (i < 0x3000 ? i % 200 : -1));
  const style = { ttl: new FakeTensor("float32", new Float32Array(8), [1, 2, 4]), dp: new FakeTensor("float32", new Float32Array(8), [1, 2, 4]) };
  return { synth: new SupertonicSynth(ort, FAKE_CFG, indexer, sessions), style };
}

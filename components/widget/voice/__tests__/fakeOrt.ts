/** A tiny stand-in for onnxruntime-web: records runs and returns shaped outputs (tests only). */
import { vi } from "vitest";
import type { OrtLike, OrtSession, OrtTensor } from "../supertonic/inference";

export class FakeTensor implements OrtTensor {
  constructor(
    readonly type: string,
    readonly data: Float32Array | BigInt64Array,
    readonly dims: readonly number[],
  ) {}
}

export const CFG = { ae: { sample_rate: 1000, base_chunk_size: 10 }, ttl: { chunk_compress_factor: 2, latent_dim: 3 } };

/** Session behaviour by model name, keyed on the first byte of the model bytes (see modelBytes). */
export function fakeOrt(opts: { failEp?: string; durationSec?: number } = {}) {
  const runs: Array<{ model: string; feeds: Record<string, OrtTensor> }> = [];
  const created: Array<{ model: string; ep: string }> = [];
  const released: string[] = [];
  const names = ["dp", "enc", "vec", "voc"];
  const ort: OrtLike & { env: { wasm: Record<string, unknown> } } = {
    Tensor: FakeTensor as unknown as OrtLike["Tensor"],
    env: { wasm: {} },
    InferenceSession: {
      create: vi.fn(async (bytes: Uint8Array, options?: Record<string, unknown>) => {
        const ep = (options?.executionProviders as string[])[0];
        const model = names[bytes[0]] ?? "?";
        if (opts.failEp === ep) throw new Error(`${ep} unavailable`);
        created.push({ model, ep });
        const session: OrtSession = {
          release: async () => void released.push(model),
          run: async (feeds): Promise<Record<string, OrtTensor>> => {
            runs.push({ model, feeds });
            if (model === "dp") return { duration: new FakeTensor("float32", new Float32Array([opts.durationSec ?? 0.1]), [1]) };
            if (model === "enc") return { text_emb: new FakeTensor("float32", new Float32Array(4), [1, 4]) };
            if (model === "vec") {
              const x = feeds.noisy_latent.data as Float32Array;
              return { denoised_latent: new FakeTensor("float32", x.map((v) => v * 0.5), feeds.noisy_latent.dims) };
            }
            const latentLen = feeds.latent.dims[2];
            const n = latentLen * CFG.ae.base_chunk_size * CFG.ttl.chunk_compress_factor;
            return { wav_tts: new FakeTensor("float32", new Float32Array(n).fill(0.25), [1, n]) };
          },
        };
        return session;
      }),
    },
  };
  return { ort, runs, created, released };
}

/** Model bytes whose first byte tells fakeOrt which model it is. */
export const modelBytes = (i: number) => new Uint8Array([i, 1, 2, 3]);

export const VOICE_JSON = { style_ttl: { dims: [1, 2, 2], data: [[[0.1, 0.2], [0.3, 0.4]]] }, style_dp: { dims: [1, 1, 2], data: [[[0.5, 0.6]]] } };
export const INDEXER = Array.from({ length: 256 }, (_, i) => i % 97);

/**
 * Supertonic 3 weights for the server engine (owner: A13, ADR-057). The image already holds them,
 * fetched at build by scripts/fetch-supertonic.mjs into public/voice/supertonic/aafc6e32/ as parts of
 * at most 16 MiB (for the browser path). Here the parts are read back in order, concatenated in memory
 * and checked against the same pinned sha256 values (a test keeps this table equal to the script's).
 * Nothing is written to disk (Cloud Run's /tmp is memory).
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { SUPERTONIC_VOICE } from "../assets";

export const PART_SIZE = 16 * 1024 * 1024;

export interface PinnedFile {
  size: number;
  sha256: string;
}

/** Same values as MODEL_FILES / VOICE_STYLES.M1 in scripts/fetch-supertonic.mjs (revision aafc6e32). */
export const SERVER_FILES: Record<string, PinnedFile> = {
  "onnx/duration_predictor.onnx": { size: 3_700_147, sha256: "c3eb91414d5ff8a7a239b7fe9e34e7e2bf8a8140d8375ffb14718b1c639325db" },
  "onnx/text_encoder.onnx": { size: 36_416_150, sha256: "c7befd5ea8c3119769e8a6c1486c4edc6a3bc8365c67621c881bbb774b9902ff" },
  "onnx/vector_estimator.onnx": { size: 256_534_781, sha256: "883ac868ea0275ef0e991524dc64f16b3c0376efd7c320af6b53f5b780d7c61c" },
  "onnx/vocoder.onnx": { size: 101_424_195, sha256: "085de76dd8e8d5836d6ca66826601f615939218f90e519f70ee8a36ed2a4c4ba" },
  "onnx/tts.json": { size: 8_253, sha256: "42078d3aef1cd43ab43021f3c54f47d2d75ceb4e75f627f118890128b06a0d09" },
  "onnx/unicode_indexer.json": { size: 277_676, sha256: "9bf7346e43883a81f8645c81224f786d43c5b57f3641f6e7671a7d6c493cb24f" },
  [`voice_styles/${SUPERTONIC_VOICE}.json`]: { size: 291_748, sha256: "e35604687f5d23694b8e91593a93eec0e4eca6c0b02bb8ed69139ab2ea6b0a5b" },
};

/** Same rule as the fetch script: the file itself when it fits one part, else `.partNNN`. */
export function partPaths(rel: string, size: number, partSize = PART_SIZE): string[] {
  if (size <= partSize) return [rel];
  return Array.from({ length: Math.ceil(size / partSize) }, (_, i) => `${rel}.part${String(i).padStart(3, "0")}`);
}

/** VOICE_SUPERTONIC_DIR, else <cwd>/public/voice/supertonic/aafc6e32 (the standalone server's cwd is /app). */
export function weightsDir(env: Record<string, string | undefined> = process.env): string {
  const d = env.VOICE_SUPERTONIC_DIR?.trim();
  return d ? path.resolve(d) : path.join(process.cwd(), "public", "voice", "supertonic", "aafc6e32");
}

export class WeightsError extends Error {
  constructor(readonly code: "missing" | "checksum") {
    super(`supertonic weights ${code}`);
    this.name = "WeightsError";
  }
}

export type ReadFileFn = (p: string) => Promise<Uint8Array>;

/** Reads one pinned file (all its parts), verifying size and sha256. */
export async function readVerified(dir: string, rel: string, pinned: PinnedFile = SERVER_FILES[rel], read: ReadFileFn = readFile, partSize = PART_SIZE): Promise<Buffer> {
  if (!pinned) throw new WeightsError("missing");
  const parts: Uint8Array[] = [];
  for (const p of partPaths(rel, pinned.size, partSize)) {
    try {
      parts.push(await read(path.join(dir, p)));
    } catch {
      throw new WeightsError("missing");
    }
  }
  const buf = parts.length === 1 ? Buffer.from(parts[0].buffer, parts[0].byteOffset, parts[0].byteLength) : Buffer.concat(parts);
  if (buf.length !== pinned.size || createHash("sha256").update(buf).digest("hex") !== pinned.sha256) throw new WeightsError("checksum");
  return buf;
}

/**
 * Supertonic 3 weights as GiftFit serves them (owner: A4 client side; A13's build script writes the
 * files). Weights are licensed under BigScience Open RAIL-M (not MIT) and are never in git; they are
 * fetched at image build from Supertone's archived Hugging Face repo at a pinned revision and served
 * from the GiftFit origin in parts of at most 16 MiB:
 *
 *   /voice/supertonic/aafc6e32/manifest.json
 *   { "revision": "aafc6e32…", "files": [ { "path": "onnx/vocoder.onnx", "size": N, "sha256": "…",
 *       "parts": [ { "path": "onnx/vocoder.onnx.part000", "size": N, "sha256": "…" }, … ] }, … ] }
 *   /voice/supertonic/aafc6e32/LICENSE   (Open RAIL-M, with Attachment A)
 */

export const SUPERTONIC_REVISION = "aafc6e32416a594460b32413efc49d7fe4ce6d46";
export const SUPERTONIC_BASE = "/voice/supertonic/aafc6e32/";
export const SUPERTONIC_LICENSE_URL = `${SUPERTONIC_BASE}LICENSE`;
export const ORT_VERSION = "1.30.0";
export const ORT_BASE = `/voice/ort/${ORT_VERSION}/`;
export const ORT_MODULE = `${ORT_BASE}ort.webgpu.min.mjs`;
/** Cache Storage name, versioned by the weights revision (a new revision never reuses old parts). */
export const CACHE_NAME = "giftfit-supertonic-aafc6e32";

/** One stock voice shared by English and Vietnamese (no cloning, no uploads: OpenRAIL-M A(g)). */
export const VOICE_STYLE = "voice_styles/M1.json";
export const MODEL_FILES = {
  durationPredictor: "onnx/duration_predictor.onnx",
  textEncoder: "onnx/text_encoder.onnx",
  vectorEstimator: "onnx/vector_estimator.onnx",
  vocoder: "onnx/vocoder.onnx",
  config: "onnx/tts.json",
  indexer: "onnx/unicode_indexer.json",
  voice: VOICE_STYLE,
} as const;
export const REQUIRED_FILES: readonly string[] = Object.values(MODEL_FILES);

export interface ManifestPart {
  path: string;
  size: number;
  sha256: string;
}
export interface ManifestFile extends ManifestPart {
  parts: ManifestPart[];
}
export interface Manifest {
  revision: string;
  files: ManifestFile[];
}

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

const HEX64 = /^[0-9a-f]{64}$/;

function part(raw: unknown, where: string): ManifestPart {
  const r = (raw ?? {}) as Record<string, unknown>;
  const path = r.path ?? r.url ?? r.name;
  const size = r.size ?? r.bytes;
  const sha = typeof r.sha256 === "string" ? r.sha256.toLowerCase() : "";
  if (typeof path !== "string" || !path || path.includes("..") || /^[a-z]+:|^\//i.test(path)) throw new ManifestError(`${where}: bad path`);
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) throw new ManifestError(`${where}: bad size`);
  if (!HEX64.test(sha)) throw new ManifestError(`${where}: bad sha256`);
  return { path, size, sha256: sha };
}

/**
 * Validates the manifest (tolerates `files` keyed by path, `url`/`name` for paths and `bytes` for
 * sizes) and checks that every file the engine needs is there and its parts add up.
 */
export function parseManifest(raw: unknown): Manifest {
  const r = (raw ?? {}) as Record<string, unknown>;
  const rawFiles = Array.isArray(r.files) ? r.files : r.files && typeof r.files === "object" ? Object.entries(r.files as Record<string, unknown>).map(([path, v]) => ({ path, ...(v as object) })) : null;
  if (!rawFiles) throw new ManifestError("no files");
  const files = rawFiles.map((f, i): ManifestFile => {
    const base = part(f, `file ${i}`);
    const parts = ((f as { parts?: unknown }).parts ?? []) as unknown[];
    if (!Array.isArray(parts) || parts.length === 0) throw new ManifestError(`${base.path}: no parts`);
    const ps = parts.map((p, j) => part(p, `${base.path} part ${j}`));
    if (ps.reduce((n, p) => n + p.size, 0) !== base.size) throw new ManifestError(`${base.path}: parts don't add up`);
    return { ...base, parts: ps };
  });
  for (const need of REQUIRED_FILES) if (!files.some((f) => f.path === need)) throw new ManifestError(`missing ${need}`);
  return { revision: typeof r.revision === "string" ? r.revision : "", files: files.filter((f) => REQUIRED_FILES.includes(f.path)) };
}

export const totalBytes = (m: Manifest) => m.files.reduce((n, f) => n + f.size, 0);

/** "398 MB" (decimal megabytes, as download sizes are usually shown). */
export function formatBytes(n: number, locale: "en" | "vi" = "en"): string {
  const mb = n / 1_000_000;
  const fmt = new Intl.NumberFormat(locale === "vi" ? "vi-VN" : "en-US", { maximumFractionDigits: mb < 10 ? 1 : 0 });
  return `${fmt.format(mb)} MB`;
}

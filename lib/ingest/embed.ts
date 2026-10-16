/**
 * Embeddings for catalog.embedding (vector(EMBEDDING_DIM) = 1024, db/schema.ts).
 * - `VoyageEmbedder`: voyage-3.5 (1024 dims by default) behind VOYAGE_API_KEY.
 * - `HashEmbedder`: deterministic feature-hashing embedder of the same width for tests, fixtures and
 *   key-less runs. It captures token overlap only (no semantics), which is enough to exercise
 *   hybrid retrieval end to end.
 */
import { createHash } from "node:crypto";
import { EMBEDDING_DIM } from "@/db/schema";
import type { IngestedSku } from "./types";

export interface Embedder {
  readonly name: string;
  readonly dim: number;
  /** `kind` lets providers that distinguish them embed queries and documents differently. */
  embed(texts: string[], kind?: "document" | "query"): Promise<number[][]>;
}

export function l2normalise(v: number[]): number[] {
  const n = Math.hypot(...v);
  return n > 0 ? v.map((x) => x / n) : v;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export const tokenize = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);

export class HashEmbedder implements Embedder {
  readonly name = "hash";
  constructor(readonly dim: number = EMBEDDING_DIM) {}

  embedOne(text: string): number[] {
    const v = new Array<number>(this.dim).fill(0);
    const toks = tokenize(text);
    const feats = [...toks, ...toks.slice(1).map((t, i) => `${toks[i]}_${t}`)];
    for (const f of feats) {
      const h = createHash("sha256").update(f).digest();
      const idx = h.readUInt32BE(0) % this.dim;
      v[idx] += h[4] & 1 ? 1 : -1;
    }
    return l2normalise(v);
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }
}

export const VOYAGE_MODEL = "voyage-3.5";
export const VOYAGE_BATCH = 64;

export class VoyageEmbedder implements Embedder {
  readonly name = `voyage:${VOYAGE_MODEL}`;
  readonly dim = EMBEDDING_DIM;
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async embed(texts: string[], kind: "document" | "query" = "document"): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += VOYAGE_BATCH) {
      const res = await this.fetchImpl("https://api.voyageai.com/v1/embeddings", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: VOYAGE_MODEL, input: texts.slice(i, i + VOYAGE_BATCH), input_type: kind, output_dimension: this.dim }),
      });
      if (!res.ok) throw new Error(`voyage embeddings: HTTP ${res.status}`);
      const body = (await res.json()) as { data: { embedding: number[]; index: number }[] };
      for (const d of [...body.data].sort((a, b) => a.index - b.index)) {
        if (d.embedding.length !== this.dim) throw new Error(`voyage embeddings: got ${d.embedding.length} dims, want ${this.dim}`);
        out.push(d.embedding);
      }
    }
    return out;
  }
}

export function createEmbedder(env: Record<string, string | undefined> = process.env): Embedder {
  const key = env.VOYAGE_API_KEY?.trim();
  return key ? new VoyageEmbedder(key) : new HashEmbedder();
}

/** The text embedded for a SKU: title, category, canonical attributes and description words. */
export function skuEmbeddingText(s: Pick<IngestedSku, "title" | "category" | "attributes">): string {
  const a = s.attributes;
  return [
    s.title,
    s.category,
    typeof a.metal === "string" ? a.metal.replace(/_/g, " ") : null,
    a.metal_tone ? `${a.metal_tone} tone` : null,
    a.stone && a.stone !== "none" ? a.stone : null,
    typeof a.earring_shape === "string" ? a.earring_shape.replace(/_/g, " ") : null,
    typeof a.necklace_style === "string" ? a.necklace_style.replace(/_/g, " ") : null,
    a.style && a.style !== "unspecified" ? a.style : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

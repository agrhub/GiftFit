/**
 * Synthetic demo Fit Requests (owner: A6). MASTER_PLAN v2 §3.3 step 7: the Retailer Console runs on
 * clearly labelled demo data. Every fact made here has `source: "synthetic"` and the console shows
 * a "Synthetic demo data" label wherever it is counted. Never present these numbers as real.
 *
 * Deterministic: the same seed, count and catalog always give the same requests (mulberry32 from
 * server/fit/rng). The generator follows the published model rather than inventing outcomes:
 *   - recipients heart a piece with p = 0.30, or 0.55 when its metal is "recommended" for their tone;
 *   - each piece's Fit Score uses the published weights from server/fit/weights.ts (FIT_WEIGHTS, kept in
 *     sync automatically; metal via jewelryRules.metalFit and a confidence factor);
 *   - so catalog gaps (few cool-suiting watches) show up in the funnel the way they would in real use.
 * The rates below are assumptions for a demo, not measurements.
 */
import type { CatalogSku, FaceShape, Undertone } from "@/server/contracts/giftfit";
import { seededRandom } from "@/server/fit/rng";
import { FIT_WEIGHTS } from "@/server/fit/weights";
import { jewelryRules } from "@/server/verticals/jewelry";
import type { FitRequestStatus } from "@/server/privacy/repos/types";
import type { RequestFact } from "./types";

export const SYNTHETIC_SEED = "giftfit-retailer-demo-v1";
export const SYNTHETIC_COUNT = 240;
/** Synthetic requests are spread over the 30 days before this instant. */
export const SYNTHETIC_ANCHOR = new Date("2026-10-14T00:00:00Z");

/** Demo assumptions (documented in A6.md and in the console's "How this is calculated"). */
export const SYNTHETIC_ASSUMPTIONS = {
  openRate: 0.82,
  completeGivenOpened: 0.71,
  heartBase: 0.3,
  heartIfMetalSuits: 0.55,
  buyIfHearted: 0.62,
  buyHeartedPiece: 0.85,
  buyIfNoHearts: 0.28,
  toneMix: { warm: 0.38, neutral: 0.34, cool: 0.28 } as Record<Undertone, number>,
} as const;

const SHAPE_MIX: Array<[FaceShape, number]> = [
  ["Oval", 0.3],
  ["Round", 0.18],
  ["Square", 0.14],
  ["Heart", 0.14],
  ["Oblong", 0.1],
  ["Diamond", 0.08],
  ["Triangle", 0.06],
];

function pick<T>(rand: () => number, weighted: ReadonlyArray<[T, number]>): T {
  const total = weighted.reduce((s, [, w]) => s + w, 0);
  let x = rand() * total;
  for (const [v, w] of weighted) {
    x -= w;
    if (x < 0) return v;
  }
  return weighted[weighted.length - 1][0];
}

const between = (rand: () => number, lo: number, hi: number) => lo + rand() * (hi - lo);

/** A synthetic Fit Score with the published weights (server/fit/weights.ts, WEIGHTS.md). */
function syntheticScore(rand: () => number, sku: Pick<CatalogSku, "attributes">, tone: Undertone, hearted: boolean): number {
  const W = FIT_WEIGHTS;
  const hearts = hearted ? W.hearts : rand() < 0.4 ? W.hearts * 0.4 * between(rand, 0.5, 1) : 0;
  const w = Math.max(-1, Math.min(1, jewelryRules.metalFit(sku.attributes.metal, tone).weight));
  const c = rand() < 0.15 ? 1 : between(rand, 0.45, 0.9);
  const metal = W.metal * (0.5 + c * ((w + 1) / 2 - 0.5));
  const style = W.style * between(rand, 0.47, 1);
  const b = rand() < 0.85 ? 1 : between(rand, 0.4, 1);
  const o = rand() < 0.7 ? 1 : 0.4;
  const budgetOccasion = W.budgetOccasion * (0.6 * b + 0.4 * o);
  return Math.max(0, Math.min(100, Math.round(hearts + metal + style + budgetOccasion)));
}

export interface SyntheticOptions {
  seed?: string;
  count?: number;
  anchor?: Date;
}

export function generateSyntheticFacts(catalog: readonly Pick<CatalogSku, "id" | "attributes">[], opts: SyntheticOptions = {}): RequestFact[] {
  const seed = opts.seed ?? SYNTHETIC_SEED;
  const count = opts.count ?? SYNTHETIC_COUNT;
  const anchor = (opts.anchor ?? SYNTHETIC_ANCHOR).getTime();
  const pool = catalog.filter((s) => s.attributes.vto_spec_ok !== false);
  if (!pool.length || count <= 0) return [];
  const rand = seededRandom(`${seed}:${count}:${pool.length}`);
  const A = SYNTHETIC_ASSUMPTIONS;
  const toneMix = Object.entries(A.toneMix) as Array<[Undertone, number]>;
  const facts: RequestFact[] = [];

  for (let i = 0; i < count; i++) {
    const createdAt = new Date(anchor - Math.floor(rand() * 30 * 24 * 3600 * 1000));
    const size = 1 + Math.floor(rand() * 4);
    const shortlist: typeof pool = [];
    while (shortlist.length < Math.min(size, pool.length)) {
      const s = pool[Math.floor(rand() * pool.length)];
      if (!shortlist.includes(s)) shortlist.push(s);
    }
    const tone = pick(rand, toneMix);
    const shape = pick(rand, SHAPE_MIX);
    const opened = rand() < A.openRate;
    const completed = opened && rand() < A.completeGivenOpened;

    let status: FitRequestStatus = "created";
    if (completed) status = "completed";
    else if (opened) status = pick<FitRequestStatus>(rand, [["opened", 0.35], ["consented", 0.25], ["tried_on", 0.3], ["deleted", 0.1]]);
    else if (anchor - createdAt.getTime() > 72 * 3600 * 1000) status = "expired";

    const hearted: string[] = [];
    const purchased: string[] = [];
    const scores: number[] = [];
    if (completed) {
      const scored = shortlist.map((s) => {
        const suits = jewelryRules.metalFit(s.attributes.metal, tone).strength === "recommended";
        const h = rand() < (suits ? A.heartIfMetalSuits : A.heartBase);
        if (h) hearted.push(s.id);
        return { id: s.id, score: syntheticScore(rand, s, tone, h), hearted: h };
      });
      const best = (xs: typeof scored) => [...xs].sort((a, b) => b.score - a.score)[0];
      const heartedOnes = scored.filter((x) => x.hearted);
      let bought: (typeof scored)[number] | undefined;
      if (heartedOnes.length) {
        if (rand() < A.buyIfHearted) {
          const others = scored.filter((x) => !x.hearted);
          bought = rand() < A.buyHeartedPiece || !others.length ? best(heartedOnes) : best(others);
        }
      } else if (rand() < A.buyIfNoHearts) {
        bought = best(scored);
      }
      if (bought) {
        purchased.push(bought.id);
        scores.push(bought.score);
      }
    }

    facts.push({
      source: "synthetic",
      status,
      createdAt,
      opened,
      completed,
      shortlistIds: shortlist.map((s) => s.id),
      heartedShortlistIds: hearted,
      purchasedSkuIds: purchased,
      purchasedScores: scores,
      tone: opened ? tone : undefined,
      shape: opened ? shape : undefined,
    });
  }
  return facts;
}

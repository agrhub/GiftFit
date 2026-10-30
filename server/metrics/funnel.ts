/**
 * Aggregates over RequestFacts (owner: A6). Formulas, as shown in the console:
 *
 *   sent       = Fit Requests created
 *   opened     = the recipient opened the link (status opened, consented, tried_on, completed or deleted)
 *   completed  = the recipient sent their hearts (status completed)
 *   purchased  = completed requests where a shortlisted piece was bought as a gift (purchase event)
 *   step rate  = stage / previous stage; overall rate = stage / sent
 *
 *   hearted→bought        = completed requests where a hearted shortlist piece was bought
 *                           / completed requests with ≥ 1 hearted shortlist piece
 *   bought were hearted   = bought pieces the recipient hearted / bought pieces
 *
 *   recipient mix (tone, shape): completed requests only, shown when the cohort is ≥ MIN_COHORT;
 *   any cell below MIN_COHORT is reported as "fewer than 5" (count null).
 */
import type { FaceShape, Undertone } from "@/server/contracts/giftfit";
import { MIN_COHORT, type CohortMix, type Funnel, type FunnelStage, type HeartedToBought, type Rate, type RequestFact } from "./types";

export const rate = (numerator: number, denominator: number): Rate => ({ numerator, denominator, value: denominator ? numerator / denominator : null });

const isPurchased = (f: RequestFact) => f.completed && f.purchasedSkuIds.length > 0;

export function computeFunnel(facts: readonly RequestFact[]): Funnel {
  const sent = facts.length;
  const opened = facts.filter((f) => f.opened).length;
  const completed = facts.filter((f) => f.completed).length;
  const purchased = facts.filter(isPurchased).length;
  const counts: Array<[FunnelStage["key"], string, number]> = [
    ["sent", "Sent", sent],
    ["opened", "Opened", opened],
    ["completed", "Completed", completed],
    ["purchased", "Purchased", purchased],
  ];
  const stages = counts.map(([key, label, count], i) => ({
    key,
    label,
    count,
    stepRate: i === 0 ? null : rate(count, counts[i - 1][2]),
    overallRate: rate(count, sent),
  }));
  const closedUnknown = facts.filter((f) => !f.opened && (f.status === "expired" || f.status === "deleted")).length;
  return { stages, closedUnknown };
}

export function computeHeartedToBought(facts: readonly RequestFact[]): HeartedToBought {
  const eligible = facts.filter((f) => f.completed && f.heartedShortlistIds.length > 0);
  const converted = eligible.filter((f) => f.purchasedSkuIds.some((id) => f.heartedShortlistIds.includes(id)));
  const bought = facts.filter(isPurchased).flatMap((f) => f.purchasedSkuIds.map((id) => f.heartedShortlistIds.includes(id)));
  return {
    requestRate: rate(converted.length, eligible.length),
    boughtWereHearted: rate(bought.filter(Boolean).length, bought.length),
  };
}

/** Fit Scores of the pieces bought through a Fit Request (input to portfolioReturnRisk). */
export function purchasedScores(facts: readonly RequestFact[]): number[] {
  return facts.filter(isPurchased).flatMap((f) => f.purchasedScores);
}

/** k-anonymous mix over completed requests. */
export function cohortMix<K extends string>(facts: readonly RequestFact[], keys: readonly K[], get: (f: RequestFact) => K | undefined, min = MIN_COHORT): CohortMix<K> {
  const values = facts.filter((f) => f.completed).map(get).filter((v): v is K => v !== undefined);
  const cohort = values.length;
  if (cohort < min) return { cohort, suppressed: true, cells: [] };
  const cells: CohortMix<K>["cells"] = keys.map((key) => {
    const n = values.filter((v) => v === key).length;
    return n === 0 || n >= min ? { key, count: n, share: n / cohort } : { key, count: null, share: null };
  });
  // One hidden cell could be recovered as cohort − the others: hide the next smallest one too.
  if (cells.filter((c) => c.count === null).length === 1) {
    const next = cells.filter((c) => c.count !== null && c.count > 0).sort((a, b) => (a.count ?? 0) - (b.count ?? 0))[0];
    if (next) Object.assign(next, { count: null, share: null });
  }
  return { cohort, suppressed: false, cells };
}

export const toneMix = (facts: readonly RequestFact[]) => cohortMix<Undertone>(facts, ["warm", "neutral", "cool"], (f) => f.tone);

export const SHAPE_KEYS: readonly Exclude<FaceShape, "Unknown" | "InvTriangle">[] = ["Oval", "Round", "Square", "Heart", "Oblong", "Diamond", "Triangle"];
export const shapeMix = (facts: readonly RequestFact[]) =>
  cohortMix(facts, SHAPE_KEYS, (f) => (f.shape === "InvTriangle" ? "Heart" : (f.shape as (typeof SHAPE_KEYS)[number] | undefined)));

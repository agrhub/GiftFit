/**
 * Retailer metrics types (owner: A6). Server-side facts are per request but never leave the
 * server: the console and /api/retailer/* only ever see the aggregates built in funnel.ts.
 *
 * Key names in serialised aggregates avoid the giver-guard vocabulary on purpose ("tone", not
 * "undertone"; "shape", not "faceShape"): every retailer response also passes assertGiverSafe, so
 * a per-person field added by mistake fails closed.
 */
import type { FaceShape, JewelryCategory, Undertone } from "@/server/contracts/giftfit";
import type { FitRequestStatus } from "@/server/privacy/repos/types";

export type DataSource = "real" | "synthetic";

/** One Fit Request as the metrics see it. Server-only; never serialised. */
export interface RequestFact {
  source: DataSource;
  status: FitRequestStatus;
  createdAt: Date;
  opened: boolean;
  completed: boolean;
  shortlistIds: string[];
  /** Hearted catalog ids that are on the giver's shortlist. */
  heartedShortlistIds: string[];
  /** Shortlisted pieces bought as a gift (purchase events). */
  purchasedSkuIds: string[];
  /** Fit Score of each piece in `purchasedSkuIds`, when the giver's report scored it. */
  purchasedScores: number[];
  /** Effective undertone (override ?? estimate). Only for k-anonymous aggregates (MIN_COHORT). */
  tone?: Undertone;
  /** Only for k-anonymous aggregates (MIN_COHORT). */
  shape?: FaceShape;
}

/** Minimum cohort before any undertone or face-shape breakdown is shown (orchestrator rule). */
export const MIN_COHORT = 5;

export interface Rate {
  numerator: number;
  denominator: number;
  /** numerator / denominator, 0..1; null when the denominator is 0. */
  value: number | null;
}

export interface FunnelStage {
  key: "sent" | "opened" | "completed" | "purchased";
  label: string;
  count: number;
  /** Share of the previous stage (sent: null). */
  stepRate: Rate | null;
  /** Share of sent. */
  overallRate: Rate;
}

export interface Funnel {
  stages: FunnelStage[];
  /** Requests closed by expiry or deletion before we know how far they got. */
  closedUnknown: number;
}

export interface HeartedToBought {
  /** Completed requests where a hearted shortlist piece was bought / completed requests with ≥ 1 hearted shortlist piece. */
  requestRate: Rate;
  /** Bought pieces that the recipient had hearted / bought pieces. */
  boughtWereHearted: Rate;
}

export interface ToneShare {
  count: number;
  share: number;
}

export interface CategoryCoverage {
  category: JewelryCategory;
  total: number;
  warm: ToneShare;
  neutral: ToneShare;
  cool: ToneShare;
}

export interface CoverageGap {
  tone: Undertone;
  share: number;
  count: number;
  total: number;
  /** The category with the lowest share for that tone. */
  category: JewelryCategory;
  categoryShare: number;
  categoryCount: number;
  categoryTotal: number;
  /** SKUs that suit `tone` to add to `category` to reach `targetShare`. */
  toAdd: number;
  targetShare: number;
  /** Metals the rules recommend for `tone`. */
  metals: string[];
}

export interface Coverage {
  total: number;
  byTone: Record<Undertone, ToneShare>;
  byCategory: CategoryCoverage[];
  gap: CoverageGap | null;
  rule: string;
}

/** Aggregate recipient mix; `cells` is empty (suppressed) below MIN_COHORT. */
export interface CohortMix<K extends string> {
  cohort: number;
  suppressed: boolean;
  /** Cells below MIN_COHORT carry `count: null` ("fewer than 5"). */
  cells: Array<{ key: K; count: number | null; share: number | null }>;
}

export interface SourceCounts {
  real: number;
  synthetic: number;
}

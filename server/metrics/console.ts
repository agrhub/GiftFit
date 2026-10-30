/**
 * Retailer Console snapshot (owner: A6): everything /retailer and GET /api/retailer/metrics show.
 * Aggregates only. The snapshot is checked with assertGiverSafe before it leaves the server, so a
 * per-person field added by mistake fails closed.
 */
import { assertGiverSafe } from "@/server/privacy/giver-guard";
import type { PrivacyRepos } from "@/server/privacy/repos/types";
import { portfolioReturnRisk, type PortfolioReturnRisk } from "@/server/fit/returnRisk";
import { DEFAULT_STORE, findStore, type RetailStore } from "./catalog";
import { computeCoverage } from "./coverage";
import { computeFunnel, computeHeartedToBought, purchasedScores, shapeMix, toneMix } from "./funnel";
import type { PurchaseLog } from "./purchases";
import { readRealFacts } from "./real";
import { generateSyntheticFacts, SYNTHETIC_COUNT, SYNTHETIC_SEED } from "./synthetic";
import type { CohortMix, Coverage, Funnel, HeartedToBought, RequestFact, SourceCounts } from "./types";

export type DataView = "all" | "real";

export interface ConsoleSlice {
  funnel: Funnel;
  heartedToBought: HeartedToBought;
  /** Fit Scores of bought pieces: aggregate numbers only, no ids. */
  boughtScores: number[];
  returnRisk: PortfolioReturnRisk;
  mix: { tone: CohortMix<"warm" | "neutral" | "cool">; shape: CohortMix<string> };
}

export interface RetailerSnapshot {
  store: { key: string; name: string; skuCount: number };
  view: DataView;
  generatedAt: string;
  sources: SourceCounts;
  /** true whenever synthetic requests are part of `combined`. */
  includesSynthetic: boolean;
  syntheticLabel: string;
  combined: ConsoleSlice;
  /** Real requests only, always shown next to the combined numbers. */
  real: ConsoleSlice;
  coverage: Coverage;
}

export const SYNTHETIC_LABEL = "Synthetic demo data";

function slice(facts: readonly RequestFact[]): ConsoleSlice {
  const boughtScores = purchasedScores(facts);
  return {
    funnel: computeFunnel(facts),
    heartedToBought: computeHeartedToBought(facts),
    boughtScores,
    returnRisk: portfolioReturnRisk(boughtScores),
    mix: { tone: toneMix(facts), shape: shapeMix(facts) },
  };
}

export interface SnapshotDeps {
  repos: PrivacyRepos;
  purchases: PurchaseLog;
  now?: () => Date;
}

export async function buildRetailerSnapshot(deps: SnapshotDeps, opts: { store?: string; view?: DataView; syntheticCount?: number } = {}): Promise<RetailerSnapshot> {
  const store: RetailStore = findStore(opts.store) ?? DEFAULT_STORE;
  const view: DataView = opts.view === "real" ? "real" : "all";
  const real = await readRealFacts(deps.repos, deps.purchases, { storeId: store.id, isDefaultStore: store === DEFAULT_STORE });
  const synthetic = view === "all" ? generateSyntheticFacts(store.skus, { seed: SYNTHETIC_SEED, count: opts.syntheticCount ?? SYNTHETIC_COUNT }) : [];
  const snapshot: RetailerSnapshot = {
    store: { key: store.key, name: store.name, skuCount: store.skus.length },
    view,
    generatedAt: (deps.now?.() ?? new Date()).toISOString(),
    sources: { real: real.length, synthetic: synthetic.length },
    includesSynthetic: synthetic.length > 0,
    syntheticLabel: SYNTHETIC_LABEL,
    combined: slice([...real, ...synthetic]),
    real: slice(real),
    coverage: computeCoverage(store.skus),
  };
  return assertGiverSafe(snapshot);
}

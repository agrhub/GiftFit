/** Fit Engine public API (A3). Weights and formulas: lib/fit/WEIGHTS.md. */
export * from "./weights";
export * from "./score";
export * from "./decoys";
export * from "./guess";
export * from "./explain";
export * from "./returnRisk";
export * from "./repository";
export * from "./variants";
export * from "./curate";
export * from "./taste";
export { configureFit, getFitDeps, resetFitDeps, type FitDeps } from "./deps";
export type { CreateFitRequestResponse, DecoysResponse, FitErrorResponse, FitWeightsResponse, GiverFitReportResponse, GiverFitResponse, GiverReportStatus } from "./api";
export { FIT_DISCLAIMER, GIVER_FIT_ROUTES, decoySeed, giverStatus, recipientLabels } from "./api";

/** Retailer metrics (owner: A6). Server-side; client code imports purchase-beacon.ts or the pure modules directly. */
export * from "./types";
export * from "./coverage";
export * from "./funnel";
export * from "./synthetic";
export * from "./purchases";
export * from "./catalog";
export * from "./console";
export { readRealFacts, toFact, reportScores, OPENED_STATUSES } from "./real";

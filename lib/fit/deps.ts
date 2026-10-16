/**
 * Dependency wiring for app/api/fit/*. Route files call `getFitDeps()`.
 * - repository: `PrivacyFitRepository` over lib/privacy `PrivacyRepos` (single store, ADR-021: memory
 *   without DATABASE_URL, Drizzle with it) plus the Aurum catalog JSON (no-DB default, ADR-020).
 * - rules: A10's `jewelryRules` (ADR-017); tests can inject `rules: null` for the 503 path.
 */
import { randomBytes } from "node:crypto";
import type { CatalogSku, JewelryRules } from "@/lib/contracts/giftfit";
import { jewelryRules } from "@/lib/verticals/jewelry";
import aurumCatalog from "@/data/aurum/catalog.json";
import { type ExplainClient, createExplainClient } from "./explain";
import { getPrivacyDeps } from "@/lib/privacy/runtime";
import { type FitRepository, PrivacyFitRepository, StaticCatalog } from "./repository";

export interface FitDeps {
  repository: FitRepository;
  rules: JewelryRules | null;
  explainer: ExplainClient | null;
  /** Secret mixed into decoy seeds so the recipient cannot reproduce the order. */
  decoySecret: string;
  now: () => Date;
}

let overrides: Partial<FitDeps> = {};
let defaults: FitDeps | null = null;

function buildDefaults(): FitDeps {
  return {
    // Requests live only in lib/privacy (ADR-021); SKUs come from the Aurum demo catalog, so decoys and
    // reports work on a fresh deploy without a DB (ADR-020).
    repository: new PrivacyFitRepository(async () => (await getPrivacyDeps()).repos, new StaticCatalog(aurumCatalog as unknown as CatalogSku[])),
    rules: jewelryRules,
    explainer: createExplainClient(),
    decoySecret: process.env.FIT_DECOY_SECRET || randomBytes(32).toString("hex"),
    now: () => new Date(),
  };
}

export function configureFit(deps: Partial<FitDeps>): void {
  overrides = { ...overrides, ...deps };
}

export function resetFitDeps(): void {
  overrides = {};
  defaults = null;
}

export function getFitDeps(): FitDeps {
  defaults ??= buildDefaults();
  return { ...defaults, ...overrides };
}

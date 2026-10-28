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
import { type TasteClient, createTasteClient } from "./taste";
import { getPrivacyDeps } from "@/lib/privacy/runtime";
import type { StoreProductSnapshot } from "@/lib/contracts/api";
import { PreviewAwareCatalog } from "@/lib/widget/preview";
import { previewStoreHooks } from "@/lib/widget/preview-snapshot";
import { type FitRepository, PrivacyFitRepository, StaticCatalog } from "./repository";
import { tryOnOfferedTo } from "@/lib/privacy/tryon-mode";

/**
 * Hooks for requests made from a store other than the Aurum catalog (A6, ADR-055: store-URL previews).
 * All optional: Aurum requests never call them.
 */
export interface StoreHooks {
  /** Product display data to freeze into the request (undefined = none). */
  snapshot(storeId: string | undefined): Promise<StoreProductSnapshot[] | undefined>;
  /** After the request is stored (previews: keep the preview alive as long as the request, capped). */
  afterCreate(storeId: string | undefined, requestExpiresAt: Date): Promise<void>;
  /** The store behind the request is gone (previews: deleted or expired). */
  isGone(storeId: string | undefined): Promise<boolean>;
  /** The store's display name, frozen into the request (previews: "gorjana"); undefined = the Aurum demo store. */
  name?(storeId: string | undefined): Promise<string | undefined>;
  /** false when the store has no try-on (previews): no photo, no undertone or face-shape estimate. */
  tryOnEnabled?(storeId: string | undefined): boolean;
}

export interface FitDeps {
  /** Store-URL preview hooks (A6); absent in unit tests = plain Aurum behaviour. */
  stores?: StoreHooks;
  /**
   * A16: would THIS caller's recipient be offered a try-on in this deployment (lib/privacy/tryon-mode.ts)?
   * false on the public production site (0 YouCam units: hearts-only); true for the owner's recording session
   * and in mock mode. Only giver-side copy depends on it; recipient routes decide again for themselves.
   * Absent = true (unit tests, legacy behaviour).
   */
  tryOnOffered?: (req?: Request) => boolean;
  repository: FitRepository;
  rules: JewelryRules | null;
  explainer: ExplainClient | null;
  /** "help_me_choose" taste summary writer (Claude when ANTHROPIC_API_KEY is set; null = template). */
  taster?: TasteClient | null;
  /** Secret mixed into decoy and curation seeds so the recipient cannot reproduce the order. */
  decoySecret: string;
  now: () => Date;
}

let overrides: Partial<FitDeps> = {};
let defaults: FitDeps | null = null;

function buildDefaults(): FitDeps {
  return {
    // Requests live only in lib/privacy (ADR-021); SKUs come from the Aurum demo catalog, so decoys and
    // reports work on a fresh deploy without a DB (ADR-020).
    // A6 (ADR-055): key-scoped preview-store SKUs ("<key>~pv-…", storeId "preview:<key>") resolve from the
    // preview repo; every other id from the Aurum catalog.
    repository: new PrivacyFitRepository(async () => (await getPrivacyDeps()).repos, new PreviewAwareCatalog(new StaticCatalog(aurumCatalog as unknown as CatalogSku[]))),
    rules: jewelryRules,
    stores: previewStoreHooks,
    tryOnOffered: (req) => tryOnOfferedTo(req),
    explainer: createExplainClient(),
    taster: createTasteClient(),
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

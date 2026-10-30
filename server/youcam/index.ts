/**
 * Public API of server/youcam. Server-side only (reads the API key from the environment and
 * uses node:fs). GiftFit critical path: analyzeRecipient, runTryOns, jewelryVto,
 * facialColorTones, faceAttributes, verifyYoucamWebhook.
 */
export * from "./types";
export * from "./errors";
export {
  DEFAULT_DAILY_UNIT_CAP,
  DEFAULT_MAX_UNITS_PER_RUN,
  DEFAULT_RESERVE_UNITS,
  JEWELRY_BODY_VARIANTS,
  loadYoucamConfig,
  type JewelryBodyVariant,
  type YoucamConfig,
} from "./config";
export {
  FEATURES,
  GIFT_FACE_FEATURES,
  HAND_JEWELRY,
  JEWELRY_KINDS,
  JEWELRY_LIGHT_DEFAULTS,
  buildJewelryBody,
  getFeature,
  resultCacheTtlMs,
  taskPath,
  type FileRef,
  type FeatureSlug,
  type ParamsOf,
  type ResultOf,
  type TierSelector,
} from "./features";
export { FEATURE_COST_SNAPSHOT, FEATURE_COST_SNAPSHOT_DATE, priceFor } from "./costs";
export { DEFAULT_FIXTURES_ROOT, fixtureImagePath } from "./mock";
export { YOUCAM_STATE_KEY, resetYoucamState, youcamState, type GuardLedger } from "./global-state";
export { CostGuard, type GuardDecision, type PlannedTask, type Reservation } from "./cost-guard";
export {
  MemoryAuditSink,
  JsonlAuditSink,
  DbAuditSink,
  createDefaultAuditSink,
  jsonlAuditPath,
  type AuditEvent,
  type AuditSink,
} from "./audit";
export {
  MemoryResultCache,
  FileResultCache,
  createDefaultResultCache,
  cacheKey,
  sha256Hex,
  type CachedResult,
  type ResultCache,
} from "./cache";
export {
  YoucamClient,
  createYoucamClient,
  getYoucamClient,
  resetYoucamClient,
  type CreditHistoryEntry,
  type PurgeResult,
  type TaskDeleteResult,
  type PlanItem,
  type RunOptions,
  type RunResult,
  type YoucamClientOptions,
} from "./client";
export {
  analyzeRecipient,
  fitRequestPlan,
  runTryOns,
  type RecipientAnalysis,
  type TryOnItem,
  type TryOnPhotos,
  type TryOnResult,
} from "./fit-request";
/** v1 (TrueShelf) leftover, off the GiftFit critical path. */
export {
  LEAN_HD_ACTIONS,
  buildSkinPassport,
  passportPlan,
  runSkinPassport,
  type PassportConcern,
  type RunSkinPassportOptions,
  type SkinPassport,
} from "./passport";
export {
  verifyYoucamWebhook,
  signYoucamWebhook,
  notifyTaskCompleted,
  WebhookSignatureError,
  type YoucamWebhookPayload,
} from "./webhook";

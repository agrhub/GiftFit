/**
 * GiftFit Postgres schema (Neon + pgvector), MASTER_PLAN v2 4.1.
 *
 * Privacy (v2 4.4): no table stores a photo, a photo URL of the recipient's face, or the
 * recipient's raw hex colors / face attributes. recipient_profiles keeps only the
 * estimated undertone (+ override) and face shape, and expires with its Fit Request.
 * Tokens are stored as SHA-256 hashes, never in clear.
 */
import { sql } from "drizzle-orm";
import type { MetalVariant } from "../lib/contracts/giftfit";
import {
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

/** Embedding width for catalog.embedding. Provisional (Voyage/OpenAI 1024); A10 confirms. */
export const EMBEDDING_DIM = 1024;

/** Fit Request link lifetime (v2 G7). recipient_profiles and tryons expire with it. */
export const FIT_REQUEST_TTL_HOURS = 72;

export type Undertone = "warm" | "neutral" | "cool";
export type MetalTone = Undertone;
export type JewelryCategory = "earring" | "necklace" | "ring" | "bracelet" | "watch";

/** catalog.attributes for the jewelry vertical (A2/A10 fill it; A3 scores on it). */
export interface JewelryAttributes {
  /** e.g. "yellow gold", "white gold", "rose gold", "silver", "platinum". */
  metal?: string;
  metal_tone?: MetalTone;
  /** e.g. "pearl", "diamond", "none". */
  stone?: string;
  /** e.g. "drop", "hoop", "stud", "pendant", "choker", "minimal". */
  style?: string;
  category?: JewelryCategory;
  /** Product image meets the YouCam 2d-vto spec for its category (api_matrix.md section 9). */
  vto_spec_ok?: boolean;
  /** Product image used for try-on (white background / spec-compliant). */
  vto_image?: string;
  /**
   * Metal variants of this design (ADR-032). **Source of truth for variants**: there is no
   * catalog_variants table. A2's seed writes CatalogSku.variants here; variants[0] is the default
   * listing and mirrors the row's price / metal / images. variantId = "<externalId>:<metal>".
   */
  variants?: MetalVariant[];
  [key: string]: unknown;
}

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const fitRequestTtl = sql`(now() + interval '72 hours')`;

export const stores = pgTable(
  "stores",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    url: text("url").notNull(),
    /** shopify | jsonld | render | unknown */
    platform: text("platform").notNull().default("unknown"),
    /** jewelry | beauty */
    vertical: text("vertical").notNull().default("jewelry"),
    /** pending | running | done | error */
    ingestStatus: text("ingest_status").notNull().default("pending"),
    ingestTier: integer("ingest_tier"),
    ingestProgress: jsonb("ingest_progress"),
    skuCount: integer("sku_count").notNull().default(0),
    lastIngestedAt: timestamp("last_ingested_at", { withTimezone: true }),
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("stores_url_uq").on(t.url)],
);

export const catalog = pgTable(
  "catalog",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    /** Product id in the source store (Shopify id, SKU, URL slug). */
    externalId: text("external_id").notNull(),
    vertical: text("vertical").notNull().default("jewelry"),
    title: text("title").notNull(),
    /** earring | necklace | ring | bracelet | watch (mirrors attributes.category for indexing). */
    category: text("category"),
    brand: text("brand"),
    price: numeric("price", { precision: 12, scale: 2 }),
    currency: text("currency"),
    images: jsonb("images").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** metal, metal_tone, stone, style, category, vto_spec_ok, ... */
    attributes: jsonb("attributes").$type<JewelryAttributes>().notNull().default(sql`'{}'::jsonb`),
    sourceUrl: text("source_url"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIM }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("catalog_store_external_uq").on(t.storeId, t.externalId),
    index("catalog_store_category_idx").on(t.storeId, t.category),
    index("catalog_attributes_gin").using("gin", t.attributes),
    index("catalog_embedding_hnsw").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);

export const fitRequests = pgTable(
  "fit_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").references(() => stores.id, { onDelete: "set null" }),
    /** SHA-256 of the giver's secret link token. */
    giverTokenHash: text("giver_token_hash").notNull(),
    /** SHA-256 of the recipient's secret link token. */
    recipientTokenHash: text("recipient_token_hash").notNull(),
    occasion: text("occasion"),
    budgetMin: numeric("budget_min", { precision: 12, scale: 2 }),
    budgetMax: numeric("budget_max", { precision: 12, scale: 2 }),
    currency: text("currency"),
    /** catalog ids the giver shortlisted (1-4). Never exposed to the recipient as such. */
    shortlistIds: jsonb("shortlist_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** catalog ids mixed in as decoys (>= 2). */
    decoyIds: jsonb("decoy_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /**
     * Giver's optional metal lock (ADR-032): only variants in these metals reach the recipient.
     * NULL or an empty array means no lock. Values are lib/contracts `Metal` ids.
     */
    metalLock: text("metal_lock").array(),
    /** created | opened | consented | tried_on | completed | expired | deleted */
    status: text("status").notNull().default("created"),
    createdAt: createdAt(),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /**
     * When the recipient tapped "Delete my photo now" (ADR-036). Their photos are already gone at
     * that point; this only records the fact. NULL = not requested.
     */
    photoDeletedAt: timestamp("photo_deleted_at", { withTimezone: true }),
    /**
     * Seeded judge-demo request (ADR-038). Excluded from real retailer metrics; never set by
     * the public create route.
     */
    demo: boolean("demo").notNull().default(false),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull().default(fitRequestTtl),
  },
  (t) => [
    uniqueIndex("fit_requests_giver_token_uq").on(t.giverTokenHash),
    uniqueIndex("fit_requests_recipient_token_uq").on(t.recipientTokenHash),
    index("fit_requests_store_idx").on(t.storeId, t.createdAt),
    index("fit_requests_expires_idx").on(t.expiresAt),
  ],
);

/**
 * Numbers-only recipient profile. Deliberately has NO image, image URL, hex color or
 * raw face-attribute columns, so no giver route can leak them from this table.
 */
export const recipientProfiles = pgTable(
  "recipient_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fitRequestId: uuid("fit_request_id")
      .notNull()
      .references(() => fitRequests.id, { onDelete: "cascade" }),
    /** warm | neutral | cool, estimated by lib/verticals/jewelry.ts (A10). */
    undertoneEstimate: text("undertone_estimate"),
    undertoneConfidence: real("undertone_confidence"),
    /** The recipient's own correction (warm | neutral | cool); wins over the estimate. */
    undertoneOverride: text("undertone_override"),
    /** YouCam faceshape label (Oval, Round, ...). */
    faceShape: text("face_shape"),
    /** The recipient also supplied a back-of-hand capture (unlocks ring/bracelet/watch). */
    hasHandCapture: boolean("has_hand_capture").notNull().default(false),
    consentAt: timestamp("consent_at", { withTimezone: true }),
    createdAt: createdAt(),
    /** Same as the Fit Request's expires_at; rows are purged after it. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull().default(fitRequestTtl),
  },
  (t) => [uniqueIndex("recipient_profiles_request_uq").on(t.fitRequestId), index("recipient_profiles_expires_idx").on(t.expiresAt)],
);

export const tryons = pgTable(
  "tryons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** SHA-256(image bytes + SKU image + params), see lib/youcam/cache.ts. */
    cacheKey: text("cache_key").notNull(),
    fitRequestId: uuid("fit_request_id").references(() => fitRequests.id, { onDelete: "cascade" }),
    catalogId: uuid("catalog_id").references(() => catalog.id, { onDelete: "set null" }),
    /** 2d-vto/earring | 2d-vto/necklace | ... */
    feature: text("feature").notNull(),
    taskId: text("task_id"),
    /**
     * Recipient-only try-on image reference (short-lived signed URL or blob key; YouCam's
     * own URL expires after 2 h). Never served on a giver route (A5 enforces).
     */
    resultRef: text("result_ref"),
    status: text("status").notNull().default("pending"),
    errorCode: text("error_code"),
    unitsCharged: integer("units_charged").notNull().default(0),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull().default(fitRequestTtl),
  },
  (t) => [
    uniqueIndex("tryons_request_cache_key_uq").on(t.fitRequestId, t.cacheKey),
    index("tryons_request_idx").on(t.fitRequestId),
  ],
);

export const hearts = pgTable(
  "hearts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fitRequestId: uuid("fit_request_id")
      .notNull()
      .references(() => fitRequests.id, { onDelete: "cascade" }),
    /** The design (catalog row). A hearted variant implies its design is hearted. */
    catalogId: uuid("catalog_id")
      .notNull()
      .references(() => catalog.id, { onDelete: "cascade" }),
    /**
     * Hearted metal variant, `<designId>:<metal>` as in catalog.attributes.variants[].variantId
     * (ADR-032). NULL = a legacy design-level heart (counts for every visible variant).
     */
    variantId: text("variant_id"),
    createdAt: createdAt(),
  },
  // One heart per (request, design, variant); NULLS NOT DISTINCT so a design-level heart is unique too.
  (t) => [unique("hearts_request_catalog_variant_uq").on(t.fitRequestId, t.catalogId, t.variantId).nullsNotDistinct()],
);

/**
 * "Love the style, wish it came in another metal" (ADR-032): one row per request and design.
 * A separate table (not a flag on hearts) because a wish is not a heart and can exist without one.
 * Deleted with the request (FK cascade) and by delete-everything (deleteRecipientData).
 */
export const metalWishes = pgTable(
  "metal_wishes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fitRequestId: uuid("fit_request_id")
      .notNull()
      .references(() => fitRequests.id, { onDelete: "cascade" }),
    catalogId: uuid("catalog_id")
      .notNull()
      .references(() => catalog.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("metal_wishes_request_catalog_uq").on(t.fitRequestId, t.catalogId)],
);

/** What the giver sees: scores and reasons per shortlisted item. No images, no hex, no raw attributes. */
export const fitReports = pgTable(
  "fit_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fitRequestId: uuid("fit_request_id")
      .notNull()
      .references(() => fitRequests.id, { onDelete: "cascade" }),
    /** [{ catalogId, score, breakdown, reasons[], caution, hearted }] (A3). */
    items: jsonb("items").notNull(),
    weights: jsonb("weights"),
    model: text("model"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("fit_reports_request_uq").on(t.fitRequestId)],
);

export const retailerMetrics = pgTable(
  "retailer_metrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    catalogId: uuid("catalog_id").references(() => catalog.id, { onDelete: "cascade" }),
    /** completion_rate | hearted_to_bought | undertone_coverage | return_risk | ... */
    metric: text("metric").notNull(),
    value: doublePrecision("value").notNull(),
    dims: jsonb("dims"),
    /** true for labelled demo data (v2 3.3 step 7). */
    demo: boolean("demo").notNull().default(false),
    periodStart: timestamp("period_start", { withTimezone: true }),
    periodEnd: timestamp("period_end", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("retailer_metrics_store_metric_idx").on(t.storeId, t.metric, t.periodStart)],
);

/** Every YouCam attempt and outcome (lib/youcam/audit.ts) plus privacy events. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    event: text("event").notNull(),
    mode: text("mode"),
    feature: text("feature"),
    decision: text("decision"),
    reason: text("reason"),
    unitsExpected: integer("units_expected"),
    unitsCharged: integer("units_charged"),
    balanceBefore: numeric("balance_before", { precision: 12, scale: 2 }),
    runUnits: integer("run_units"),
    taskId: text("task_id"),
    cacheKey: text("cache_key"),
    status: text("status"),
    detail: jsonb("detail"),
  },
  (t) => [index("audit_log_ts_idx").on(t.ts), index("audit_log_feature_idx").on(t.feature, t.ts)],
);

/**
 * SHA-256-keyed YouCam result cache shared by all server instances (results only, no
 * images). Holds raw API results, including recipient hex colors for tones, so it is
 * server-only and entries expire (lib/youcam/features.ts resultCacheTtlMs).
 */
export const youcamResults = pgTable(
  "youcam_results",
  {
    cacheKey: text("cache_key").primaryKey(),
    feature: text("feature").notNull(),
    taskId: text("task_id").notNull(),
    result: jsonb("result").notNull(),
    unitsCharged: integer("units_charged").notNull().default(0),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => [index("youcam_results_expires_idx").on(t.expiresAt)],
);

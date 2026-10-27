/**
 * Repositories for the recipient-side tables (owner: A5). Implementations: MemoryPrivacyRepos (tests,
 * local dev without DATABASE_URL), DrizzlePrivacyRepos, and FirestorePrivacyRepos (STORE=firestore, A11).
 *
 * Analysis tasks (Facial Color Tones, Face Attributes) are recorded as `tryons` rows whose
 * `feature` is the analysis slug and whose `result_ref` is null: the schema has no other
 * per-request home for their task id and cache key, and both are needed to delete the
 * YouCam task and purge the result cache. `isRenderFeature` separates them from try-ons.
 */
import type { GiftMode, StoreProductSnapshot, StyleFamily } from "@/lib/contracts/api";
import type { FaceShape, JewelryCategory, Metal, Undertone } from "@/lib/contracts/giftfit";

export const FIT_REQUEST_STATUSES = ["created", "opened", "consented", "tried_on", "completed", "expired", "deleted"] as const;
export type FitRequestStatus = (typeof FIT_REQUEST_STATUSES)[number];

/** Terminal states: links stop working and recipient data is gone. */
export const CLOSED_STATUSES: readonly FitRequestStatus[] = ["expired", "deleted"];

export interface FitRequestRecord {
  id: string;
  storeId: string | null;
  giverTokenHash: string;
  recipientTokenHash: string;
  occasion: string | null;
  budgetMin: number | null;
  budgetMax: number | null;
  currency: string | null;
  shortlistIds: string[];
  decoyIds: string[];
  status: FitRequestStatus;
  createdAt: Date;
  expiresAt: Date;
  /** Giver's metal lock (fit_requests.metal_lock, ADR-032). Null/empty = no lock. */
  metalLock?: Metal[] | null;
  /** "Delete my photo now" (fit_requests.photo_deleted_at, ADR-036). Null = not requested. */
  photoDeletedAt?: Date | null;
  /**
   * Seeded judge demo (lib/privacy/demo.ts): AI-generated model, fixture try-ons, never counted as a
   * real request. Memory: kept in a separate map; Drizzle: no column yet (request to A1), derived from
   * fixture try-on rows (isDemoRequest).
   */
  demo?: boolean;
  /**
   * Giver mode (ADR-045). Absent on older rows and in Drizzle (no column yet): lib/fit reads a request
   * with no decoys and ≥ 5 shortlisted designs as "help_me_choose", anything else as "i_have_ideas".
   * For "help_me_choose", `shortlistIds` holds the curated designs (all real candidates) and
   * `decoyIds` is empty.
   */
  mode?: GiftMode;
  /** "help_me_choose" brief (ADR-045). Memory and Firestore keep them; Drizzle drops them (TODO A1: a `brief jsonb` column). */
  categories?: JewelryCategory[] | null;
  styleHints?: StyleFamily[] | null;
  genderPresentation?: "feminine" | "masculine" | "unisex" | null;
  /**
   * Store-URL preview requests (ADR-055): display data of the preview's pieces, frozen at creation so the
   * giver's report outlives the 24 h preview. Memory and Firestore keep it; Drizzle drops it (no column).
   */
  productSnapshot?: StoreProductSnapshot[] | null;
  /**
   * Store-URL preview requests (ADR-055): the store's display name at creation ("gorjana"), for the gift
   * pages' header after the preview is gone. Memory and Firestore keep it; Drizzle drops it (no column).
   */
  storeName?: string | null;
}

export type NewFitRequest = Omit<FitRequestRecord, "id" | "status" | "createdAt" | "expiresAt"> &
  Partial<Pick<FitRequestRecord, "id" | "status" | "createdAt" | "expiresAt">>;

/** recipient_profiles: estimates only. No photo, no hex, no raw face attributes. */
export interface RecipientProfileRecord {
  fitRequestId: string;
  undertoneEstimate: Undertone | null;
  undertoneConfidence: number | null;
  undertoneOverride: Undertone | null;
  faceShape: FaceShape | null;
  hasHandCapture: boolean;
  consentAt: Date | null;
  expiresAt: Date;
}

export interface TryOnRecord {
  id: string;
  fitRequestId: string;
  catalogId: string | null;
  /** "2d-vto/earring" ... for renders; "skin-tone-analysis" / "face-attr-analysis" for analysis tasks. */
  feature: string;
  taskId: string | null;
  cacheKey: string;
  /** "store:<photo-store key>" for a render we hold; null for analysis tasks. Recipient-only. */
  resultRef: string | null;
  status: string;
  unitsCharged: number;
  expiresAt: Date;
}

export type NewTryOn = Omit<TryOnRecord, "id"> & { id?: string };

export interface HeartRecord {
  fitRequestId: string;
  /** The design. */
  catalogId: string;
  /** Hearted metal variant `<designId>:<metal>`; null = legacy design-level heart. */
  variantId: string | null;
}

/** A heart to store: a design id (design-level) or a design + variant. */
export type HeartInput = string | { catalogId: string; variantId?: string | null };

/** Row prefix A3's parseHeartRows reads as "wish it came in another metal" (lib/fit/repository.ts). */
export const WISH_ROW_PREFIX = "wish:";

export interface FitReportRecord {
  fitRequestId: string;
  items: unknown;
  weights?: unknown;
  model?: string | null;
}

/** Rows that reference one Fit Request, per table. */
export interface RequestRowCounts {
  recipient_profiles: number;
  tryons: number;
  hearts: number;
  metal_wishes: number;
  fit_reports: number;
}

export interface PrivacyRepos {
  readonly kind: string;
  fitRequests: {
    create(input: NewFitRequest): Promise<FitRequestRecord>;
    findById(id: string): Promise<FitRequestRecord | undefined>;
    findByRecipientTokenHash(hash: string): Promise<FitRequestRecord | undefined>;
    findByGiverTokenHash(hash: string): Promise<FitRequestRecord | undefined>;
    setStatus(id: string, status: FitRequestStatus): Promise<void>;
    /** Sets or clears fit_requests.photo_deleted_at. */
    setPhotoDeletedAt(id: string, at: Date | null): Promise<void>;
    /** Ids of requests past expires_at that are not yet closed. */
    listExpired(now: Date): Promise<string[]>;
  };
  profiles: {
    get(fitRequestId: string): Promise<RecipientProfileRecord | undefined>;
    upsert(profile: RecipientProfileRecord): Promise<void>;
    setOverride(fitRequestId: string, undertone: Undertone | null): Promise<boolean>;
  };
  tryons: {
    /** Inserts, or replaces the row with the same (fitRequestId, cacheKey) (re-capture of the same task). */
    insert(row: NewTryOn): Promise<TryOnRecord>;
    get(id: string): Promise<TryOnRecord | undefined>;
    listForRequest(fitRequestId: string): Promise<TryOnRecord[]>;
  };
  hearts: {
    add(fitRequestId: string, heart: HeartInput): Promise<void>;
    /** Replaces the request's hearted set (wishes are separate and untouched). */
    set(fitRequestId: string, hearts: readonly HeartInput[]): Promise<void>;
    /**
     * Rows in lib/fit's convention (parseHeartRows): a variant id, a design id (legacy heart),
     * or `wish:<designId>` for each metal wish. This is what A3's report adapter reads.
     */
    list(fitRequestId: string): Promise<string[]>;
    /** Structured hearts only (no wishes). */
    entries(fitRequestId: string): Promise<HeartRecord[]>;
  };
  /** metal_wishes: "Love the style, wish it came in another metal" (no render). */
  wishes: {
    add(fitRequestId: string, catalogId: string): Promise<void>;
    list(fitRequestId: string): Promise<string[]>;
  };
  reports: {
    get(fitRequestId: string): Promise<FitReportRecord | undefined>;
    upsert(report: FitReportRecord): Promise<void>;
  };
  /** Deletes every recipient-derived row of a request (profiles, tryons, hearts, metal_wishes, fit_reports). */
  deleteRecipientData(fitRequestId: string): Promise<RequestRowCounts>;
  countForRequest(fitRequestId: string): Promise<RequestRowCounts>;
}

export const ANALYSIS_FEATURES = ["skin-tone-analysis", "face-attr-analysis"] as const;

export function isRenderFeature(feature: string): boolean {
  return feature.startsWith("2d-vto/");
}

export function toHeartRecord(fitRequestId: string, h: HeartInput): HeartRecord {
  return typeof h === "string" ? { fitRequestId, catalogId: h, variantId: null } : { fitRequestId, catalogId: h.catalogId, variantId: h.variantId ?? null };
}

/** lib/fit row convention for one heart. */
export const heartRow = (h: Pick<HeartRecord, "catalogId" | "variantId">) => h.variantId ?? h.catalogId;

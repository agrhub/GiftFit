/**
 * Data access for the Fit Engine routes.
 *
 * Single store (ADR-021): Fit Requests, recipient profiles and hearts live only in server/privacy's
 * `PrivacyRepos` (memory or Drizzle). `PrivacyFitRepository` is a read/write adapter over it plus a
 * catalog source (the Aurum JSON by default, ADR-020). There is never a second copy of a request.
 * `InMemoryFitRepository` stays as a self-contained helper for unit tests.
 */
import type { StoreProductSnapshot } from "@/server/contracts/api";
import type { GiftMode, StyleFamily } from "@/server/contracts/api";
import type { CatalogSku, FaceShape, FitRequestInput, JewelryCategory, Metal, Occasion, RecipientProfile, Undertone } from "@/server/contracts/giftfit";
import { OCCASIONS } from "@/server/contracts/giftfit";
import { hashToken } from "@/server/privacy/tokens";
import type { FitReportRecord, FitRequestRecord, FitRequestStatus, NewFitRequest, PrivacyRepos } from "@/server/privacy/repos/types";
import { variantIndex } from "./variants";

export type { FitRequestStatus };
export { hashToken };

/** The giver's mode and "help_me_choose" brief (ADR-045), as stored with the request. */
export interface StoredBrief {
  mode: GiftMode;
  categories?: JewelryCategory[];
  styleHints?: StyleFamily[];
  genderPresentation?: "feminine" | "masculine" | "unisex";
}

/** A Fit Request as the giver routes need it. `profile` is null until the recipient produced data. */
export interface StoredFitRequest {
  id: string;
  storeId?: string;
  /** For "help_me_choose", `input.shortlistIds` are the curated designs (all real candidates). */
  input: FitRequestInput;
  decoyIds: string[];
  status: FitRequestStatus;
  expiresAt: Date;
  /** Estimates and hearted catalog ids (shortlist and decoys). Never returned on a giver route as-is. */
  profile: RecipientProfile | null;
  /** Absent on older test fixtures = "i_have_ideas". */
  brief?: StoredBrief;
  /** Seeded judge demo (AI-generated model). */
  demo?: boolean;
  /** Store-URL preview requests (ADR-055): frozen product display data. */
  productSnapshot?: StoreProductSnapshot[];
  /** Store-URL preview requests (ADR-055): the store's display name at creation. */
  storeName?: string;
  /**
   * Whether the recipient's capture produced estimates (undertone, face shape). false = no try-on (store
   * previews never capture; or the recipient finished without a photo): the report drops the metal and
   * style factors. Absent (test fixtures) = decide from the profile.
   */
  captured?: boolean;
  /** The giver's conversation language at creation (CreateFitRequestBody.giverLang). Absent = English. */
  giverLang?: string;
}

/**
 * Mode and brief of a stored request. Rows without a `mode` (Drizzle has no column yet; older rows)
 * read as "help_me_choose" when they have no decoys and ≥ 5 designs (that mode's shape: 6–8 real
 * candidates, never decoys), else "i_have_ideas" (1–4 picks plus ≥ 2 decoys).
 */
export function briefOf(rec: Pick<FitRequestRecord, "mode" | "categories" | "styleHints" | "genderPresentation" | "decoyIds" | "shortlistIds">): StoredBrief {
  const mode: GiftMode = rec.mode ?? (rec.decoyIds.length === 0 && rec.shortlistIds.length >= 5 ? "help_me_choose" : "i_have_ideas");
  const brief: StoredBrief = { mode };
  if (rec.categories && rec.categories.length) brief.categories = [...rec.categories];
  if (rec.styleHints && rec.styleHints.length) brief.styleHints = [...rec.styleHints];
  if (rec.genderPresentation) brief.genderPresentation = rec.genderPresentation;
  return brief;
}

/** Cached giver report (fit_reports), keyed by a fingerprint of everything it was computed from. */
export interface CachedFitReport {
  fingerprint: string;
  items: unknown;
  weights?: unknown;
  model?: string | null;
  /** "help_me_choose" extras (taste summary, not-tried picks), cached with the results so Claude runs once. */
  extras?: unknown;
}

export interface CatalogSource {
  getSkus(ids: readonly string[]): Promise<CatalogSku[]>;
  /** All SKUs of a store (or every SKU when storeId is omitted): the decoy pool. */
  listCatalog(storeId?: string): Promise<CatalogSku[]>;
}

export interface FitRepository extends CatalogSource {
  /** Stores a new request (token hashes only). */
  createRequest(input: NewFitRequestWithLock): Promise<{ id: string; expiresAt: Date }>;
  /** Looks up a Fit Request by the giver's secret link token (stored as SHA-256 only). */
  findByGiverToken(token: string): Promise<StoredFitRequest | null>;
  getReport(fitRequestId: string): Promise<CachedFitReport | null>;
  saveReport(fitRequestId: string, report: CachedFitReport): Promise<void>;
}

/** Catalog source over a fixed list of SKUs (the Aurum JSON, or test fixtures). */
export class StaticCatalog implements CatalogSource {
  private readonly byId = new Map<string, CatalogSku>();

  constructor(skus: readonly CatalogSku[] = []) {
    for (const s of skus) this.byId.set(s.id, s);
  }

  add(sku: CatalogSku): void {
    this.byId.set(sku.id, sku);
  }

  async getSkus(ids: readonly string[]): Promise<CatalogSku[]> {
    return ids.flatMap((id) => {
      const s = this.byId.get(id);
      return s ? [s] : [];
    });
  }

  async listCatalog(storeId?: string): Promise<CatalogSku[]> {
    const all = [...this.byId.values()];
    return storeId ? all.filter((s) => s.storeId === storeId) : all;
  }
}

const asOccasion = (o: string | null): Occasion => ((OCCASIONS as readonly string[]).includes(o ?? "") ? (o as Occasion) : "just_because");

/** Prefix of a hearts row that records "love the style, wish it came in another metal". */
export const WISH_PREFIX = "wish:";

export interface ParsedHearts {
  /** Designs hearted (directly, or through one of their variants). */
  designIds: string[];
  variantIds: string[];
  /** Designs flagged "wish it came in another metal". */
  wishIds: string[];
}

/**
 * Reads hearts rows (PrivacyRepos.hearts, ADR-032 convention until a dedicated column exists):
 * a row is a design id, a variant id (`<designId>:<metal>`, resolved with `variantToDesign`), or
 * `wish:<designId>`. A hearted variant implies its design is hearted.
 */
export function parseHeartRows(rows: readonly string[], variantToDesign: ReadonlyMap<string, string> = new Map()): ParsedHearts {
  const designIds = new Set<string>();
  const variantIds = new Set<string>();
  const wishIds = new Set<string>();
  for (const row of rows) {
    if (row.startsWith(WISH_PREFIX)) {
      wishIds.add(row.slice(WISH_PREFIX.length));
      continue;
    }
    const design = variantToDesign.get(row);
    if (design) {
      variantIds.add(row);
      designIds.add(design);
    } else designIds.add(row);
  }
  return { designIds: [...designIds], variantIds: [...variantIds], wishIds: [...wishIds] };
}

/** Builds the scoring profile from the privacy rows. Missing estimates mean "no information". */
export function toRecipientProfile(
  row: { undertoneEstimate: Undertone | null; undertoneConfidence: number | null; undertoneOverride: Undertone | null; faceShape: FaceShape | null } | undefined,
  hearts: readonly string[] | ParsedHearts,
): RecipientProfile | null {
  const parsed = Array.isArray(hearts) ? parseHeartRows(hearts as readonly string[]) : (hearts as ParsedHearts);
  if (!row && parsed.designIds.length === 0 && parsed.wishIds.length === 0) return null;
  const profile: RecipientProfile = {
    undertoneEstimate: row?.undertoneEstimate ?? "neutral",
    undertoneConfidence: row?.undertoneEstimate ? (row.undertoneConfidence ?? 0) : 0,
    faceShape: row?.faceShape ?? "Unknown",
    heartedSkuIds: [...parsed.designIds],
  };
  if (parsed.variantIds.length > 0) profile.heartedVariantIds = [...parsed.variantIds];
  if (parsed.wishIds.length > 0) profile.wishOtherMetalSkuIds = [...parsed.wishIds];
  if (row?.undertoneOverride) profile.undertoneOverride = row.undertoneOverride;
  return profile;
}

/** The P3 default: requests, profiles, hearts and reports from server/privacy; SKUs from a catalog source. */
export class PrivacyFitRepository implements FitRepository {
  constructor(
    private readonly repos: () => Promise<PrivacyRepos>,
    private readonly catalog: CatalogSource,
  ) {}

  getSkus(ids: readonly string[]): Promise<CatalogSku[]> {
    return this.catalog.getSkus(ids);
  }

  listCatalog(storeId?: string): Promise<CatalogSku[]> {
    return this.catalog.listCatalog(storeId);
  }

  async createRequest(input: NewFitRequestWithLock): Promise<{ id: string; expiresAt: Date }> {
    const rec = await (await this.repos()).fitRequests.create(input);
    return { id: rec.id, expiresAt: rec.expiresAt };
  }

  async findByGiverToken(token: string): Promise<StoredFitRequest | null> {
    const repos = await this.repos();
    const rec = await repos.fitRequests.findByGiverTokenHash(hashToken(token));
    if (!rec) return null;
    const [row, hearts, catalog] = await Promise.all([repos.profiles.get(rec.id), repos.hearts.list(rec.id), this.catalog.listCatalog(rec.storeId ?? undefined)]);
    return {
      id: rec.id,
      storeId: rec.storeId ?? undefined,
      input: toFitRequestInput(rec),
      decoyIds: [...rec.decoyIds],
      status: rec.status,
      expiresAt: rec.expiresAt,
      profile: toRecipientProfile(row, parseHeartRows(hearts, variantIndex(catalog))),
      brief: briefOf(rec),
      ...(rec.demo ? { demo: true } : {}),
      ...(rec.productSnapshot?.length ? { productSnapshot: rec.productSnapshot } : {}),
      ...(rec.storeName ? { storeName: rec.storeName } : {}),
      ...(rec.giverLang ? { giverLang: rec.giverLang } : {}),
      captured: Boolean(row?.undertoneEstimate),
    };
  }

  async getReport(fitRequestId: string): Promise<CachedFitReport | null> {
    const rec = await (await this.repos()).reports.get(fitRequestId);
    const items = rec?.items as { fingerprint?: unknown; items?: unknown; extras?: unknown } | undefined;
    if (!rec || typeof items?.fingerprint !== "string") return null;
    return { fingerprint: items.fingerprint, items: items.items, weights: rec.weights, model: rec.model, ...(items.extras !== undefined ? { extras: items.extras } : {}) };
  }

  async saveReport(fitRequestId: string, report: CachedFitReport): Promise<void> {
    const rec: FitReportRecord = {
      fitRequestId,
      items: { fingerprint: report.fingerprint, items: report.items, ...(report.extras !== undefined ? { extras: report.extras } : {}) },
      weights: report.weights,
      model: report.model ?? null,
    };
    await (await this.repos()).reports.upsert(rec);
  }
}

/**
 * The metal lock is not a fit_requests column yet (request to R0/A5): it rides along as an extra
 * `metalLock` property, which MemoryPrivacyRepos keeps and a Drizzle repo would drop.
 */
export type FitRequestRecordWithLock = FitRequestRecord & { metalLock?: Metal[] | null };
export type NewFitRequestWithLock = NewFitRequest & { metalLock?: Metal[] };

export function toFitRequestInput(rec: FitRequestRecordWithLock): FitRequestInput {
  const input: FitRequestInput = {
    occasion: asOccasion(rec.occasion),
    budgetMax: rec.budgetMax ?? Number.MAX_SAFE_INTEGER,
    currency: rec.currency ?? "USD",
    shortlistIds: [...rec.shortlistIds],
  };
  if (rec.budgetMin !== null && rec.budgetMin !== undefined && rec.budgetMin > 0) input.budgetMin = rec.budgetMin;
  if (rec.metalLock && rec.metalLock.length > 0) input.metalLock = [...rec.metalLock];
  return input;
}

/** Self-contained repository for unit tests (no server/privacy state). */
export class InMemoryFitRepository extends StaticCatalog implements FitRepository {
  private readonly requests = new Map<string, StoredFitRequest>();
  private readonly reports = new Map<string, CachedFitReport>();

  constructor(init: { skus?: readonly CatalogSku[]; requests?: readonly { giverToken: string; request: StoredFitRequest }[] } = {}) {
    super(init.skus);
    for (const r of init.requests ?? []) this.addRequest(r.giverToken, r.request);
  }

  addSku(sku: CatalogSku): void {
    this.add(sku);
  }

  addRequest(giverToken: string, request: StoredFitRequest): void {
    this.requests.set(hashToken(giverToken), request);
  }

  async createRequest(input: NewFitRequestWithLock): Promise<{ id: string; expiresAt: Date }> {
    const id = input.id ?? `req-${this.requests.size + 1}`;
    const expiresAt = input.expiresAt ?? new Date(Date.now() + 72 * 3600_000);
    this.requests.set(input.giverTokenHash, {
      id,
      storeId: input.storeId ?? undefined,
      input: toFitRequestInput({ ...input, id, status: "created", createdAt: new Date(), expiresAt } as FitRequestRecord),
      decoyIds: [...input.decoyIds],
      status: input.status ?? "created",
      expiresAt,
      profile: null,
      brief: briefOf(input),
      ...(input.giverLang ? { giverLang: input.giverLang } : {}),
    });
    return { id, expiresAt };
  }

  async findByGiverToken(token: string): Promise<StoredFitRequest | null> {
    return this.requests.get(hashToken(token)) ?? null;
  }

  async getReport(fitRequestId: string): Promise<CachedFitReport | null> {
    return this.reports.get(fitRequestId) ?? null;
  }

  async saveReport(fitRequestId: string, report: CachedFitReport): Promise<void> {
    this.reports.set(fitRequestId, report);
  }
}

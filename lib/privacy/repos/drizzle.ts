/**
 * Drizzle repositories over the A1 schema (db/schema.ts). The database is reached lazily
 * through db/index.ts getDb(); tests pass any PgDatabase (e.g. a pg-proxy recorder).
 *
 * neon-http has no interactive transactions, so deleteRecipientData issues one DELETE per
 * table, children first. Every statement is idempotent, so a retry after a partial failure
 * finishes the job.
 */
import { and, count, eq, lte, notInArray } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { FaceShape, Metal, Undertone } from "@/lib/contracts/giftfit";
import * as schema from "@/db/schema";
import { fitRequests, fitReports, hearts, metalWishes, recipientProfiles, tryons } from "@/db/schema";
import { fitRequestExpiresAt } from "../tokens";
import {
  CLOSED_STATUSES,
  type FitReportRecord,
  type FitRequestRecord,
  type FitRequestStatus,
  type HeartInput,
  type HeartRecord,
  type NewFitRequest,
  type NewTryOn,
  type PrivacyRepos,
  type RecipientProfileRecord,
  type RequestRowCounts,
  type TryOnRecord,
  WISH_ROW_PREFIX,
  heartRow,
  toHeartRecord,
} from "./types";

export type AnyPgDb = PgDatabase<PgQueryResultHKT, typeof schema>;

const num = (v: string | number | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));
const str = (v: number | null | undefined): string | null => (v === null || v === undefined ? null : String(v));

type FitRequestRow = typeof fitRequests.$inferSelect;
type TryOnRow = typeof tryons.$inferSelect;
type ProfileRow = typeof recipientProfiles.$inferSelect;

function toFitRequest(r: FitRequestRow): FitRequestRecord {
  return {
    id: r.id,
    storeId: r.storeId,
    giverTokenHash: r.giverTokenHash,
    recipientTokenHash: r.recipientTokenHash,
    occasion: r.occasion,
    budgetMin: num(r.budgetMin),
    budgetMax: num(r.budgetMax),
    currency: r.currency,
    shortlistIds: r.shortlistIds ?? [],
    decoyIds: r.decoyIds ?? [],
    status: r.status as FitRequestStatus,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    metalLock: r.metalLock && r.metalLock.length ? (r.metalLock as Metal[]) : null,
    photoDeletedAt: r.photoDeletedAt ?? null,
  };
}

function toTryOn(r: TryOnRow): TryOnRecord {
  return {
    id: r.id,
    fitRequestId: r.fitRequestId ?? "",
    catalogId: r.catalogId,
    feature: r.feature,
    taskId: r.taskId,
    cacheKey: r.cacheKey,
    resultRef: r.resultRef,
    status: r.status,
    unitsCharged: r.unitsCharged,
    expiresAt: r.expiresAt,
  };
}

function toProfile(r: ProfileRow): RecipientProfileRecord {
  return {
    fitRequestId: r.fitRequestId,
    undertoneEstimate: r.undertoneEstimate as Undertone | null,
    undertoneConfidence: r.undertoneConfidence,
    undertoneOverride: r.undertoneOverride as Undertone | null,
    faceShape: r.faceShape as FaceShape | null,
    hasHandCapture: r.hasHandCapture,
    consentAt: r.consentAt,
    expiresAt: r.expiresAt,
  };
}

export class DrizzlePrivacyRepos implements PrivacyRepos {
  readonly kind = "drizzle";
  constructor(private readonly db: () => AnyPgDb) {}

  fitRequests = {
    create: async (input: NewFitRequest): Promise<FitRequestRecord> => {
      const createdAt = input.createdAt ?? new Date();
      const [row] = await this.db()
        .insert(fitRequests)
        .values({
          ...(input.id ? { id: input.id } : {}),
          storeId: input.storeId,
          giverTokenHash: input.giverTokenHash,
          recipientTokenHash: input.recipientTokenHash,
          occasion: input.occasion,
          budgetMin: str(input.budgetMin),
          budgetMax: str(input.budgetMax),
          currency: input.currency,
          shortlistIds: input.shortlistIds,
          decoyIds: input.decoyIds,
          metalLock: input.metalLock && input.metalLock.length ? [...input.metalLock] : null,
          status: input.status ?? "created",
          createdAt,
          expiresAt: input.expiresAt ?? fitRequestExpiresAt(createdAt),
        })
        .returning();
      return toFitRequest(row);
    },
    findById: async (id: string) => {
      const [row] = await this.db().select().from(fitRequests).where(eq(fitRequests.id, id)).limit(1);
      return row ? toFitRequest(row) : undefined;
    },
    findByRecipientTokenHash: async (hash: string) => {
      const [row] = await this.db().select().from(fitRequests).where(eq(fitRequests.recipientTokenHash, hash)).limit(1);
      return row ? toFitRequest(row) : undefined;
    },
    findByGiverTokenHash: async (hash: string) => {
      const [row] = await this.db().select().from(fitRequests).where(eq(fitRequests.giverTokenHash, hash)).limit(1);
      return row ? toFitRequest(row) : undefined;
    },
    setStatus: async (id: string, status: FitRequestStatus) => {
      const stamp = status === "completed" ? { completedAt: new Date() } : status === "opened" ? { openedAt: new Date() } : {};
      await this.db()
        .update(fitRequests)
        .set({ status, ...stamp })
        .where(eq(fitRequests.id, id));
    },
    setPhotoDeletedAt: async (id: string, at: Date | null) => {
      await this.db().update(fitRequests).set({ photoDeletedAt: at }).where(eq(fitRequests.id, id));
    },
    listExpired: async (now: Date) => {
      const rows = await this.db()
        .select({ id: fitRequests.id })
        .from(fitRequests)
        .where(and(lte(fitRequests.expiresAt, now), notInArray(fitRequests.status, [...CLOSED_STATUSES])));
      return rows.map((r) => r.id);
    },
  };

  profiles = {
    get: async (fitRequestId: string) => {
      const [row] = await this.db().select().from(recipientProfiles).where(eq(recipientProfiles.fitRequestId, fitRequestId)).limit(1);
      return row ? toProfile(row) : undefined;
    },
    upsert: async (p: RecipientProfileRecord) => {
      const values = {
        fitRequestId: p.fitRequestId,
        undertoneEstimate: p.undertoneEstimate,
        undertoneConfidence: p.undertoneConfidence,
        undertoneOverride: p.undertoneOverride,
        faceShape: p.faceShape,
        hasHandCapture: p.hasHandCapture,
        consentAt: p.consentAt,
        expiresAt: p.expiresAt,
      };
      const { fitRequestId: _key, ...update } = values;
      void _key;
      await this.db().insert(recipientProfiles).values(values).onConflictDoUpdate({ target: recipientProfiles.fitRequestId, set: update });
    },
    setOverride: async (fitRequestId: string, undertone: Undertone | null) => {
      const rows = await this.db()
        .update(recipientProfiles)
        .set({ undertoneOverride: undertone })
        .where(eq(recipientProfiles.fitRequestId, fitRequestId))
        .returning({ id: recipientProfiles.id });
      return rows.length > 0;
    },
  };

  tryons = {
    insert: async (row: NewTryOn): Promise<TryOnRecord> => {
      const values = {
        fitRequestId: row.fitRequestId,
        catalogId: row.catalogId,
        feature: row.feature,
        taskId: row.taskId,
        cacheKey: row.cacheKey,
        resultRef: row.resultRef,
        status: row.status,
        unitsCharged: row.unitsCharged,
        expiresAt: row.expiresAt,
      };
      const { fitRequestId: _r, cacheKey: _k, ...update } = values;
      void _r;
      void _k;
      const [r] = await this.db()
        .insert(tryons)
        .values({ ...(row.id ? { id: row.id } : {}), ...values })
        .onConflictDoUpdate({ target: [tryons.fitRequestId, tryons.cacheKey], set: update })
        .returning();
      return toTryOn(r);
    },
    get: async (id: string) => {
      const [r] = await this.db().select().from(tryons).where(eq(tryons.id, id)).limit(1);
      return r ? toTryOn(r) : undefined;
    },
    listForRequest: async (fitRequestId: string) => {
      const rows = await this.db().select().from(tryons).where(eq(tryons.fitRequestId, fitRequestId));
      return rows.map(toTryOn);
    },
  };

  hearts = {
    add: async (fitRequestId: string, heart: HeartInput) => {
      const h = toHeartRecord(fitRequestId, heart);
      await this.db().insert(hearts).values({ fitRequestId, catalogId: h.catalogId, variantId: h.variantId }).onConflictDoNothing();
    },
    set: async (fitRequestId: string, list: readonly HeartInput[]) => {
      const db = this.db();
      await db.delete(hearts).where(eq(hearts.fitRequestId, fitRequestId));
      const values = list.map((x) => toHeartRecord(fitRequestId, x)).map((h) => ({ fitRequestId, catalogId: h.catalogId, variantId: h.variantId }));
      if (values.length) await db.insert(hearts).values(values).onConflictDoNothing();
    },
    list: async (fitRequestId: string) => {
      const db = this.db();
      const rows = await db.select({ catalogId: hearts.catalogId, variantId: hearts.variantId }).from(hearts).where(eq(hearts.fitRequestId, fitRequestId));
      const wishes = await db.select({ catalogId: metalWishes.catalogId }).from(metalWishes).where(eq(metalWishes.fitRequestId, fitRequestId));
      return [...rows.map(heartRow), ...wishes.map((w) => `${WISH_ROW_PREFIX}${w.catalogId}`)];
    },
    entries: async (fitRequestId: string): Promise<HeartRecord[]> => {
      const rows = await this.db().select({ catalogId: hearts.catalogId, variantId: hearts.variantId }).from(hearts).where(eq(hearts.fitRequestId, fitRequestId));
      return rows.map((r) => ({ fitRequestId, catalogId: r.catalogId, variantId: r.variantId }));
    },
  };

  wishes = {
    add: async (fitRequestId: string, catalogId: string) => {
      await this.db().insert(metalWishes).values({ fitRequestId, catalogId }).onConflictDoNothing();
    },
    list: async (fitRequestId: string) => {
      const rows = await this.db().select({ catalogId: metalWishes.catalogId }).from(metalWishes).where(eq(metalWishes.fitRequestId, fitRequestId));
      return rows.map((r) => r.catalogId);
    },
  };

  reports = {
    get: async (fitRequestId: string): Promise<FitReportRecord | undefined> => {
      const [r] = await this.db().select().from(fitReports).where(eq(fitReports.fitRequestId, fitRequestId)).limit(1);
      return r ? { fitRequestId: r.fitRequestId, items: r.items, weights: r.weights, model: r.model } : undefined;
    },
    upsert: async (report: FitReportRecord) => {
      await this.db()
        .insert(fitReports)
        .values({ fitRequestId: report.fitRequestId, items: report.items, weights: report.weights, model: report.model ?? null })
        .onConflictDoUpdate({ target: fitReports.fitRequestId, set: { items: report.items, weights: report.weights, model: report.model ?? null } });
    },
  };

  async deleteRecipientData(fitRequestId: string): Promise<RequestRowCounts> {
    const db = this.db();
    const h = await db.delete(hearts).where(eq(hearts.fitRequestId, fitRequestId)).returning({ id: hearts.id });
    const w = await db.delete(metalWishes).where(eq(metalWishes.fitRequestId, fitRequestId)).returning({ id: metalWishes.id });
    const r = await db.delete(fitReports).where(eq(fitReports.fitRequestId, fitRequestId)).returning({ id: fitReports.id });
    const t = await db.delete(tryons).where(eq(tryons.fitRequestId, fitRequestId)).returning({ id: tryons.id });
    const p = await db.delete(recipientProfiles).where(eq(recipientProfiles.fitRequestId, fitRequestId)).returning({ id: recipientProfiles.id });
    return { recipient_profiles: p.length, tryons: t.length, hearts: h.length, metal_wishes: w.length, fit_reports: r.length };
  }

  async countForRequest(fitRequestId: string): Promise<RequestRowCounts> {
    const db = this.db();
    const one = async (q: Promise<Array<{ n: number }>>) => Number((await q)[0]?.n ?? 0);
    return {
      recipient_profiles: await one(db.select({ n: count() }).from(recipientProfiles).where(eq(recipientProfiles.fitRequestId, fitRequestId))),
      tryons: await one(db.select({ n: count() }).from(tryons).where(eq(tryons.fitRequestId, fitRequestId))),
      hearts: await one(db.select({ n: count() }).from(hearts).where(eq(hearts.fitRequestId, fitRequestId))),
      metal_wishes: await one(db.select({ n: count() }).from(metalWishes).where(eq(metalWishes.fitRequestId, fitRequestId))),
      fit_reports: await one(db.select({ n: count() }).from(fitReports).where(eq(fitReports.fitRequestId, fitRequestId))),
    };
  }
}

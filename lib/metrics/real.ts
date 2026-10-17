/**
 * Real Fit Requests from the single store (ADR-021: lib/privacy PrivacyRepos), turned into
 * RequestFacts (owner: A6). PrivacyRepos has no "list all" method, so this reads the memory repos'
 * public maps, the Firestore collections (STORE=firestore; demo requests excluded) or, with
 * DATABASE_URL, the same tables through Drizzle. Read-only.
 *
 * Only what the aggregates need is read: status, shortlist, hearts on shortlisted pieces, the
 * effective undertone and face shape (k-anonymous aggregates only), and the Fit Score of bought
 * pieces. No photos, hex, LAB, confidence or try-on rows.
 */
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import type { FaceShape, Undertone } from "@/lib/contracts/giftfit";
import { FACE_SHAPES } from "@/lib/contracts/giftfit";
import { getDb, schema } from "@/db/index";
import { FirestorePrivacyRepos } from "@/lib/privacy/repos/firestore";
import { MemoryPrivacyRepos } from "@/lib/privacy/repos/memory";
import type { FitRequestStatus, PrivacyRepos } from "@/lib/privacy/repos/types";
import type { PurchaseLog } from "./purchases";
import type { RequestFact } from "./types";

/** Statuses that prove the recipient opened the link. "deleted" = they opened it, then deleted everything. */
export const OPENED_STATUSES: readonly FitRequestStatus[] = ["opened", "consented", "tried_on", "completed", "deleted"];

const TONES = new Set<string>(["warm", "neutral", "cool"]);
const asTone = (v: unknown): Undertone | undefined => (typeof v === "string" && TONES.has(v) ? (v as Undertone) : undefined);
const asShape = (v: unknown): FaceShape | undefined =>
  typeof v === "string" && v !== "Unknown" && (FACE_SHAPES as readonly string[]).includes(v) ? (v as FaceShape) : undefined;

/** Scores per catalog id from a stored report (lib/fit saves `{ fingerprint, items: FitResult[] }`). */
export function reportScores(items: unknown): Map<string, number> {
  const out = new Map<string, number>();
  const list = (items as { items?: unknown } | undefined)?.items ?? items;
  if (!Array.isArray(list)) return out;
  for (const it of list) {
    const r = it as { skuId?: unknown; catalogId?: unknown; score?: unknown };
    const id = typeof r.skuId === "string" ? r.skuId : typeof r.catalogId === "string" ? r.catalogId : undefined;
    if (id && typeof r.score === "number" && Number.isFinite(r.score)) out.set(id, r.score);
  }
  return out;
}

export interface RawRequestRow {
  id: string;
  storeId: string | null;
  status: string;
  createdAt: Date;
  shortlistIds: string[];
  openedAt?: Date | null;
  completedAt?: Date | null;
  hearted: string[];
  toneEstimate?: unknown;
  toneOverride?: unknown;
  shape?: unknown;
  reportItems?: unknown;
}

export function toFact(row: RawRequestRow, purchases: PurchaseLog): RequestFact {
  const status = row.status as FitRequestStatus;
  const shortlist = new Set(row.shortlistIds);
  const completed = status === "completed" || Boolean(row.completedAt);
  const opened = completed || Boolean(row.openedAt) || OPENED_STATUSES.includes(status);
  const scores = reportScores(row.reportItems);
  const purchasedSkuIds = purchases
    .forRequest(row.id)
    .map((e) => e.skuId)
    .filter((id) => shortlist.has(id));
  return {
    source: "real",
    status,
    createdAt: row.createdAt,
    opened,
    completed,
    shortlistIds: [...row.shortlistIds],
    heartedShortlistIds: row.hearted.filter((id) => shortlist.has(id)),
    purchasedSkuIds,
    purchasedScores: purchasedSkuIds.map((id) => scores.get(id)).filter((s): s is number => typeof s === "number"),
    tone: asTone(row.toneOverride) ?? asTone(row.toneEstimate),
    shape: asShape(row.shape),
  };
}

/** Requests of `storeId`; requests without a store id belong to the default (Aurum) store. */
const inStore = (rowStore: string | null, storeId: string, isDefault: boolean) => rowStore === storeId || (isDefault && rowStore === null);

export async function readRealFacts(repos: PrivacyRepos, purchases: PurchaseLog, opts: { storeId: string; isDefaultStore: boolean }): Promise<RequestFact[]> {
  if (repos instanceof MemoryPrivacyRepos) {
    const rows: RawRequestRow[] = [...repos.requests.values()]
      .filter((r) => inStore(r.storeId, opts.storeId, opts.isDefaultStore))
      .map((r) => {
        const p = repos.profileRows.get(r.id);
        return {
          id: r.id,
          storeId: r.storeId,
          status: r.status,
          createdAt: r.createdAt,
          shortlistIds: r.shortlistIds,
          hearted: repos.heartRows.filter((h) => h.fitRequestId === r.id).map((h) => h.catalogId),
          toneEstimate: p?.undertoneEstimate,
          toneOverride: p?.undertoneOverride,
          shape: p?.faceShape,
          reportItems: repos.reportRows.get(r.id)?.items,
        };
      });
    return rows.map((r) => toFact(r, purchases));
  }
  if (repos instanceof FirestorePrivacyRepos) {
    const rows = await repos.listForMetrics();
    return rows
      .filter(({ request: r }) => inStore(r.storeId, opts.storeId, opts.isDefaultStore))
      .map(({ request: r, hearted, profile: p, reportItems }) =>
        toFact(
          {
            id: r.id,
            storeId: r.storeId,
            status: r.status,
            createdAt: r.createdAt,
            shortlistIds: r.shortlistIds,
            hearted,
            toneEstimate: p?.undertoneEstimate,
            toneOverride: p?.undertoneOverride,
            shape: p?.faceShape,
            reportItems,
          },
          purchases,
        ),
      );
  }
  if (repos.kind === "drizzle") return readDrizzleFacts(purchases, opts);
  return [];
}

async function readDrizzleFacts(purchases: PurchaseLog, opts: { storeId: string; isDefaultStore: boolean }): Promise<RequestFact[]> {
  const db = getDb();
  const fr = schema.fitRequests;
  const where = opts.isDefaultStore ? or(eq(fr.storeId, opts.storeId), isNull(fr.storeId)) : and(eq(fr.storeId, opts.storeId));
  const requests = await db
    .select({ id: fr.id, storeId: fr.storeId, status: fr.status, createdAt: fr.createdAt, shortlistIds: fr.shortlistIds, openedAt: fr.openedAt, completedAt: fr.completedAt })
    .from(fr)
    .where(where);
  if (!requests.length) return [];
  const ids = requests.map((r) => r.id);
  const [heartRows, profileRows, reportRows] = await Promise.all([
    db.select({ fitRequestId: schema.hearts.fitRequestId, catalogId: schema.hearts.catalogId }).from(schema.hearts).where(inArray(schema.hearts.fitRequestId, ids)),
    db
      .select({
        fitRequestId: schema.recipientProfiles.fitRequestId,
        est: schema.recipientProfiles.undertoneEstimate,
        ovr: schema.recipientProfiles.undertoneOverride,
        shape: schema.recipientProfiles.faceShape,
      })
      .from(schema.recipientProfiles)
      .where(inArray(schema.recipientProfiles.fitRequestId, ids)),
    db.select({ fitRequestId: schema.fitReports.fitRequestId, items: schema.fitReports.items }).from(schema.fitReports).where(inArray(schema.fitReports.fitRequestId, ids)),
  ]);
  return requests.map((r) => {
    const p = profileRows.find((x) => x.fitRequestId === r.id);
    return toFact(
      {
        ...r,
        shortlistIds: r.shortlistIds ?? [],
        hearted: heartRows.filter((h) => h.fitRequestId === r.id).map((h) => h.catalogId),
        toneEstimate: p?.est,
        toneOverride: p?.ovr,
        shape: p?.shape,
        reportItems: reportRows.find((x) => x.fitRequestId === r.id)?.items,
      },
      purchases,
    );
  });
}

/**
 * Firestore repositories for the recipient-side tables (owner: A11; semantics of MemoryPrivacyRepos,
 * which the shared contract suite in lib/privacy/__tests__/repos-contract.test.ts checks for both).
 *
 * One document per row, in fixed collections (lib/store/firestore-types.ts COLLECTIONS):
 *   fit_requests/{id}                       demo: boolean is always written (metrics filters on it)
 *   recipient_profiles/{fitRequestId}
 *   tryons/{id}                             upsert by (fitRequestId, cacheKey)
 *   hearts/{fitRequestId}_{hash(catalogId, variantId)}   unique like the SQL constraint
 *   metal_wishes/{fitRequestId}_{hash(catalogId)}
 *   fit_reports/{fitRequestId}              report body as JSON text (any JSON shape, nested arrays too)
 *
 * Every document carries `expiresAt` (a Firestore Timestamp; TTL policy backstop): fit_requests the
 * request expiry (72 h); profiles, hearts, wishes and reports the request's expiry; tryons their own.
 * Active deletion (Done, "Delete my photo now", purge cron) stays the primary mechanism.
 *
 * Queries are equality / single-field range / `in` only (auto-indexed; no composite index). Insertion
 * order of hearts and wishes is kept with a `seq` field and restored in code.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Undertone } from "@/lib/contracts/giftfit";
import { COLLECTIONS, MAX_BATCH_WRITES, chunks, defined, deleteRefs, isNotFound, toDate, toDateOrNull, type FsData, type FsDb, type FsDocRef, type FsDocSnap } from "@/lib/store/firestore-types";
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

const h = (...parts: Array<string | null>) =>
  createHash("sha256")
    .update(parts.map((p) => (p === null ? "\u0001null" : p)).join("\u0000"), "utf8")
    .digest("hex")
    .slice(0, 32);

/** Firestore document ids may not contain "/" and must not be "." or "..". */
function docId(id: string): string {
  if (!id || id.includes("/") || id === "." || id === ".." || id.length > 700) throw new Error("invalid document id");
  return id;
}

let seqCounter = 0;
/** Monotonic-enough insertion order across writes and cold starts. */
const nextSeq = () => Date.now() * 1000 + (seqCounter++ % 1000);

/** Fields read back for metrics (lib/metrics/real.ts readFirestoreFacts). */
export interface FirestoreMetricsRow {
  request: FitRequestRecord;
  hearted: string[];
  profile?: RecipientProfileRecord;
  reportItems?: unknown;
}

export class FirestorePrivacyRepos implements PrivacyRepos {
  readonly kind = "firestore";

  constructor(
    readonly db: FsDb,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private col(name: (typeof COLLECTIONS)[keyof typeof COLLECTIONS]) {
    return this.db.collection(name);
  }
  private reqRef(id: string) {
    return this.col(COLLECTIONS.fitRequests).doc(docId(id));
  }
  private byRequest(name: (typeof COLLECTIONS)[keyof typeof COLLECTIONS], fitRequestId: string) {
    return this.col(name).where("fitRequestId", "==", fitRequestId).get();
  }
  private ref(name: (typeof COLLECTIONS)[keyof typeof COLLECTIONS], snap: FsDocSnap): FsDocRef {
    return this.col(name).doc(snap.id);
  }

  /** The request's expiry (TTL for rows that do not carry their own), or now + 72 h if unknown. */
  private async requestExpiry(fitRequestId: string, snap?: FsDocSnap): Promise<Date> {
    const s = snap ?? (await this.reqRef(fitRequestId).get());
    const exp = s.exists ? s.data()?.expiresAt : undefined;
    return exp ? toDate(exp) : fitRequestExpiresAt(this.now());
  }

  fitRequests = {
    create: async (input: NewFitRequest): Promise<FitRequestRecord> => {
      const createdAt = input.createdAt ?? this.now();
      const rec: FitRequestRecord = {
        ...input,
        id: input.id ?? randomUUID(),
        status: input.status ?? "created",
        createdAt,
        expiresAt: input.expiresAt ?? fitRequestExpiresAt(createdAt),
        shortlistIds: [...input.shortlistIds],
        decoyIds: [...input.decoyIds],
        metalLock: input.metalLock && input.metalLock.length ? [...input.metalLock] : null,
        photoDeletedAt: input.photoDeletedAt ?? null,
      };
      await this.reqRef(rec.id).set(requestToDoc(rec));
      return { ...rec, shortlistIds: [...rec.shortlistIds], decoyIds: [...rec.decoyIds] };
    },
    findById: async (id: string) => {
      const s = await this.reqRef(id).get();
      return s.exists ? requestFromDoc(s.data()!) : undefined;
    },
    findByRecipientTokenHash: (hash: string) => this.findOne("recipientTokenHash", hash),
    findByGiverTokenHash: (hash: string) => this.findOne("giverTokenHash", hash),
    setStatus: async (id: string, status: FitRequestStatus) => {
      await this.updateIfExists(this.reqRef(id), { status });
    },
    setPhotoDeletedAt: async (id: string, at: Date | null) => {
      await this.updateIfExists(this.reqRef(id), { photoDeletedAt: at });
    },
    listExpired: async (now: Date) => {
      const snap = await this.col(COLLECTIONS.fitRequests).where("expiresAt", "<=", now).get();
      return snap.docs.map((d) => requestFromDoc(d.data()!)).filter((r) => !CLOSED_STATUSES.includes(r.status)).map((r) => r.id);
    },
  };

  private async findOne(field: "recipientTokenHash" | "giverTokenHash", hash: string): Promise<FitRequestRecord | undefined> {
    if (!hash) return undefined;
    const snap = await this.col(COLLECTIONS.fitRequests).where(field, "==", hash).limit(1).get();
    return snap.empty ? undefined : requestFromDoc(snap.docs[0].data()!);
  }

  /** update() that is a no-op on a missing document (memory semantics). */
  private async updateIfExists(ref: FsDocRef, data: FsData): Promise<void> {
    try {
      await ref.update(data);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  profiles = {
    get: async (fitRequestId: string) => {
      const s = await this.col(COLLECTIONS.profiles).doc(docId(fitRequestId)).get();
      return s.exists ? profileFromDoc(s.data()!) : undefined;
    },
    upsert: async (profile: RecipientProfileRecord) => {
      await this.col(COLLECTIONS.profiles).doc(docId(profile.fitRequestId)).set(profileToDoc(profile));
    },
    setOverride: async (fitRequestId: string, undertone: Undertone | null) => {
      const ref = this.col(COLLECTIONS.profiles).doc(docId(fitRequestId));
      return this.db.runTransaction(async (tx) => {
        const s = await tx.get(ref);
        if (!s.exists) return false;
        tx.update(ref, { undertoneOverride: undertone });
        return true;
      });
    },
  };

  tryons = {
    insert: async (row: NewTryOn): Promise<TryOnRecord> => {
      const existing = (await this.byRequest(COLLECTIONS.tryons, row.fitRequestId)).docs.find((d) => d.data()?.cacheKey === row.cacheKey);
      const rec: TryOnRecord = { ...row, id: existing?.id ?? row.id ?? randomUUID() };
      await this.col(COLLECTIONS.tryons).doc(docId(rec.id)).set(tryonToDoc(rec));
      return { ...rec };
    },
    get: async (id: string) => {
      if (!id || id.includes("/")) return undefined;
      const s = await this.col(COLLECTIONS.tryons).doc(id).get();
      return s.exists ? tryonFromDoc(s.id, s.data()!) : undefined;
    },
    listForRequest: async (fitRequestId: string) => (await this.byRequest(COLLECTIONS.tryons, fitRequestId)).docs.map((d) => tryonFromDoc(d.id, d.data()!)),
  };

  private heartId(rec: HeartRecord): string {
    return docId(`${rec.fitRequestId}_${h(rec.catalogId, rec.variantId)}`);
  }

  /** Adds a row unless the same (unique) row exists; keeps the first insertion's order. */
  private async addUnique(collection: typeof COLLECTIONS.hearts | typeof COLLECTIONS.wishes, id: string, fitRequestId: string, data: FsData): Promise<void> {
    const ref = this.col(collection).doc(id);
    const reqRef = this.reqRef(fitRequestId);
    await this.db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (s.exists) return;
      const expiresAt = await this.requestExpiry(fitRequestId, await tx.get(reqRef));
      tx.set(ref, { ...data, fitRequestId, seq: nextSeq(), expiresAt });
    });
  }

  private async heartEntries(fitRequestId: string): Promise<HeartRecord[]> {
    const snap = await this.byRequest(COLLECTIONS.hearts, fitRequestId);
    return bySeq(snap.docs).map((d) => ({ fitRequestId, catalogId: String(d.catalogId), variantId: (d.variantId as string | null) ?? null }));
  }

  private async wishIds(fitRequestId: string): Promise<string[]> {
    const snap = await this.byRequest(COLLECTIONS.wishes, fitRequestId);
    return bySeq(snap.docs).map((d) => String(d.catalogId));
  }

  hearts = {
    add: async (fitRequestId: string, heart: HeartInput) => {
      const rec = toHeartRecord(fitRequestId, heart);
      await this.addUnique(COLLECTIONS.hearts, this.heartId(rec), fitRequestId, { catalogId: rec.catalogId, variantId: rec.variantId });
    },
    set: async (fitRequestId: string, hearts: readonly HeartInput[]) => {
      const wanted = new Map<string, HeartRecord>();
      for (const x of hearts) {
        const rec = toHeartRecord(fitRequestId, x);
        const id = this.heartId(rec);
        if (!wanted.has(id)) wanted.set(id, rec);
      }
      const [existing, expiresAt] = await Promise.all([this.byRequest(COLLECTIONS.hearts, fitRequestId), this.requestExpiry(fitRequestId)]);
      const writes: Array<(b: ReturnType<FsDb["batch"]>) => void> = [];
      for (const d of existing.docs) if (!wanted.has(d.id)) writes.push((b) => b.delete(this.ref(COLLECTIONS.hearts, d)));
      for (const [id, rec] of wanted) {
        const seq = nextSeq();
        writes.push((b) => b.set(this.col(COLLECTIONS.hearts).doc(id), { fitRequestId, catalogId: rec.catalogId, variantId: rec.variantId, seq, expiresAt }));
      }
      for (const part of chunks(writes, MAX_BATCH_WRITES)) {
        const b = this.db.batch();
        for (const w of part) w(b);
        await b.commit();
      }
    },
    list: async (fitRequestId: string) => {
      const [hearts, wishes] = await Promise.all([this.heartEntries(fitRequestId), this.wishIds(fitRequestId)]);
      return [...hearts.map(heartRow), ...wishes.map((c) => `${WISH_ROW_PREFIX}${c}`)];
    },
    entries: (fitRequestId: string) => this.heartEntries(fitRequestId),
  };

  wishes = {
    add: async (fitRequestId: string, catalogId: string) => {
      await this.addUnique(COLLECTIONS.wishes, docId(`${fitRequestId}_${h(catalogId)}`), fitRequestId, { catalogId });
    },
    list: (fitRequestId: string) => this.wishIds(fitRequestId),
  };

  reports = {
    get: async (fitRequestId: string): Promise<FitReportRecord | undefined> => {
      const s = await this.col(COLLECTIONS.reports).doc(docId(fitRequestId)).get();
      return s.exists ? reportFromDoc(fitRequestId, s.data()!) : undefined;
    },
    upsert: async (report: FitReportRecord) => {
      const expiresAt = await this.requestExpiry(report.fitRequestId);
      const body = defined({ items: report.items, weights: report.weights, model: report.model });
      await this.col(COLLECTIONS.reports).doc(docId(report.fitRequestId)).set({ fitRequestId: report.fitRequestId, json: JSON.stringify(body), expiresAt });
    },
  };

  /** Every document that references one request, per collection. */
  private async rowsOf(fitRequestId: string) {
    const [profile, report, tryons, hearts, wishes] = await Promise.all([
      this.col(COLLECTIONS.profiles).doc(docId(fitRequestId)).get(),
      this.col(COLLECTIONS.reports).doc(docId(fitRequestId)).get(),
      this.byRequest(COLLECTIONS.tryons, fitRequestId),
      this.byRequest(COLLECTIONS.hearts, fitRequestId),
      this.byRequest(COLLECTIONS.wishes, fitRequestId),
    ]);
    const counts: RequestRowCounts = {
      recipient_profiles: profile.exists ? 1 : 0,
      tryons: tryons.size,
      hearts: hearts.size,
      metal_wishes: wishes.size,
      fit_reports: report.exists ? 1 : 0,
    };
    const refs: FsDocRef[] = [
      ...(profile.exists ? [this.ref(COLLECTIONS.profiles, profile)] : []),
      ...(report.exists ? [this.ref(COLLECTIONS.reports, report)] : []),
      ...tryons.docs.map((d) => this.ref(COLLECTIONS.tryons, d)),
      ...hearts.docs.map((d) => this.ref(COLLECTIONS.hearts, d)),
      ...wishes.docs.map((d) => this.ref(COLLECTIONS.wishes, d)),
    ];
    return { counts, refs };
  }

  async deleteRecipientData(fitRequestId: string): Promise<RequestRowCounts> {
    const { counts, refs } = await this.rowsOf(fitRequestId);
    await deleteRefs(this.db, refs);
    return counts;
  }

  async countForRequest(fitRequestId: string): Promise<RequestRowCounts> {
    return (await this.rowsOf(fitRequestId)).counts;
  }

  /**
   * Read-only listing for lib/metrics: every NON-demo request with its hearted design ids, profile and
   * report items. Demo requests never count (same as the memory repos' separate demo map).
   */
  async listForMetrics(): Promise<FirestoreMetricsRow[]> {
    const snap = await this.col(COLLECTIONS.fitRequests).where("demo", "==", false).get();
    const requests = snap.docs.map((d) => requestFromDoc(d.data()!));
    if (!requests.length) return [];
    const ids = requests.map((r) => r.id);
    const hearts = new Map<string, string[]>();
    const profiles = new Map<string, RecipientProfileRecord>();
    const reports = new Map<string, unknown>();
    // `in` takes at most 30 values per query.
    for (const part of chunks(ids, 30)) {
      const [hs, ps, rs] = await Promise.all([
        this.col(COLLECTIONS.hearts).where("fitRequestId", "in", part).get(),
        this.col(COLLECTIONS.profiles).where("fitRequestId", "in", part).get(),
        this.col(COLLECTIONS.reports).where("fitRequestId", "in", part).get(),
      ]);
      for (const d of bySeq(hs.docs)) {
        const id = String(d.fitRequestId);
        hearts.set(id, [...(hearts.get(id) ?? []), String(d.catalogId)]);
      }
      for (const d of ps.docs) profiles.set(d.id, profileFromDoc(d.data()!));
      for (const d of rs.docs) reports.set(d.id, reportFromDoc(d.id, d.data()!).items);
    }
    return requests.map((request) => ({ request, hearted: hearts.get(request.id) ?? [], profile: profiles.get(request.id), reportItems: reports.get(request.id) }));
  }
}

function bySeq(docs: readonly FsDocSnap[]): FsData[] {
  return docs.map((d) => d.data()!).sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0));
}

function requestToDoc(r: FitRequestRecord): FsData {
  return {
    id: r.id,
    storeId: r.storeId ?? null,
    giverTokenHash: r.giverTokenHash,
    recipientTokenHash: r.recipientTokenHash,
    occasion: r.occasion ?? null,
    budgetMin: r.budgetMin ?? null,
    budgetMax: r.budgetMax ?? null,
    currency: r.currency ?? null,
    shortlistIds: [...r.shortlistIds],
    decoyIds: [...r.decoyIds],
    status: r.status,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    metalLock: r.metalLock && r.metalLock.length ? [...r.metalLock] : null,
    photoDeletedAt: r.photoDeletedAt ?? null,
    demo: Boolean(r.demo),
  };
}

function requestFromDoc(d: FsData): FitRequestRecord {
  const rec: FitRequestRecord = {
    id: String(d.id),
    storeId: (d.storeId as string | null) ?? null,
    giverTokenHash: String(d.giverTokenHash),
    recipientTokenHash: String(d.recipientTokenHash),
    occasion: (d.occasion as string | null) ?? null,
    budgetMin: (d.budgetMin as number | null) ?? null,
    budgetMax: (d.budgetMax as number | null) ?? null,
    currency: (d.currency as string | null) ?? null,
    shortlistIds: [...((d.shortlistIds as string[] | undefined) ?? [])],
    decoyIds: [...((d.decoyIds as string[] | undefined) ?? [])],
    status: d.status as FitRequestStatus,
    createdAt: toDate(d.createdAt),
    expiresAt: toDate(d.expiresAt),
    metalLock: Array.isArray(d.metalLock) && d.metalLock.length ? ([...d.metalLock] as FitRequestRecord["metalLock"]) : null,
    photoDeletedAt: toDateOrNull(d.photoDeletedAt),
  };
  if (d.demo === true) rec.demo = true;
  return rec;
}

function profileToDoc(p: RecipientProfileRecord): FsData {
  return {
    fitRequestId: p.fitRequestId,
    undertoneEstimate: p.undertoneEstimate ?? null,
    undertoneConfidence: p.undertoneConfidence ?? null,
    undertoneOverride: p.undertoneOverride ?? null,
    faceShape: p.faceShape ?? null,
    hasHandCapture: Boolean(p.hasHandCapture),
    consentAt: p.consentAt ?? null,
    expiresAt: p.expiresAt,
  };
}

function profileFromDoc(d: FsData): RecipientProfileRecord {
  return {
    fitRequestId: String(d.fitRequestId),
    undertoneEstimate: (d.undertoneEstimate as Undertone | null) ?? null,
    undertoneConfidence: (d.undertoneConfidence as number | null) ?? null,
    undertoneOverride: (d.undertoneOverride as Undertone | null) ?? null,
    faceShape: (d.faceShape as RecipientProfileRecord["faceShape"]) ?? null,
    hasHandCapture: d.hasHandCapture === true,
    consentAt: toDateOrNull(d.consentAt),
    expiresAt: toDate(d.expiresAt),
  };
}

function tryonToDoc(t: TryOnRecord): FsData {
  return {
    id: t.id,
    fitRequestId: t.fitRequestId,
    catalogId: t.catalogId ?? null,
    feature: t.feature,
    taskId: t.taskId ?? null,
    cacheKey: t.cacheKey,
    resultRef: t.resultRef ?? null,
    status: t.status,
    unitsCharged: t.unitsCharged,
    expiresAt: t.expiresAt,
  };
}

function tryonFromDoc(id: string, d: FsData): TryOnRecord {
  return {
    id,
    fitRequestId: String(d.fitRequestId),
    catalogId: (d.catalogId as string | null) ?? null,
    feature: String(d.feature),
    taskId: (d.taskId as string | null) ?? null,
    cacheKey: String(d.cacheKey),
    resultRef: (d.resultRef as string | null) ?? null,
    status: String(d.status),
    unitsCharged: Number(d.unitsCharged ?? 0),
    expiresAt: toDate(d.expiresAt),
  };
}

function reportFromDoc(fitRequestId: string, d: FsData): FitReportRecord {
  const body = (typeof d.json === "string" ? JSON.parse(d.json) : {}) as { items?: unknown; weights?: unknown; model?: string | null };
  const rec: FitReportRecord = { fitRequestId, items: body.items };
  if ("weights" in body) rec.weights = body.weights;
  if ("model" in body) rec.model = body.model;
  return rec;
}

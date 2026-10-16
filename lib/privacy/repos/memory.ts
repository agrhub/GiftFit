import { randomUUID } from "node:crypto";
import type { Undertone } from "@/lib/contracts/giftfit";
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

/** In-memory repositories with the same semantics as the Drizzle ones (tests, local dev). */
export class MemoryPrivacyRepos implements PrivacyRepos {
  readonly kind = "memory";
  readonly requests = new Map<string, FitRequestRecord>();
  /**
   * Seeded judge-demo requests (demo: true), kept apart so aggregate readers that iterate
   * `requests` (lib/metrics real facts) never count them. Every lookup below sees both.
   */
  readonly demoRequests = new Map<string, FitRequestRecord>();

  private byId(id: string): FitRequestRecord | undefined {
    return this.requests.get(id) ?? this.demoRequests.get(id);
  }

  private all(): FitRequestRecord[] {
    return [...this.requests.values(), ...this.demoRequests.values()];
  }
  readonly profileRows = new Map<string, RecipientProfileRecord>();
  readonly tryonRows = new Map<string, TryOnRecord>();
  readonly heartRows: HeartRecord[] = [];
  readonly wishRows: Array<{ fitRequestId: string; catalogId: string }> = [];
  readonly reportRows = new Map<string, FitReportRecord>();

  constructor(private readonly now: () => Date = () => new Date()) {}

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
      (rec.demo ? this.demoRequests : this.requests).set(rec.id, rec);
      return { ...rec };
    },
    findById: async (id: string) => this.copy(this.byId(id)),
    findByRecipientTokenHash: async (hash: string) => this.copy(this.all().find((r) => r.recipientTokenHash === hash)),
    findByGiverTokenHash: async (hash: string) => this.copy(this.all().find((r) => r.giverTokenHash === hash)),
    setStatus: async (id: string, status: FitRequestStatus) => {
      const r = this.byId(id);
      if (r) r.status = status;
    },
    setPhotoDeletedAt: async (id: string, at: Date | null) => {
      const r = this.byId(id);
      if (r) r.photoDeletedAt = at;
    },
    listExpired: async (now: Date) =>
      this.all().filter((r) => r.expiresAt.getTime() <= now.getTime() && !CLOSED_STATUSES.includes(r.status)).map((r) => r.id),
  };

  profiles = {
    get: async (fitRequestId: string) => {
      const p = this.profileRows.get(fitRequestId);
      return p ? { ...p } : undefined;
    },
    upsert: async (profile: RecipientProfileRecord) => {
      this.profileRows.set(profile.fitRequestId, { ...profile });
    },
    setOverride: async (fitRequestId: string, undertone: Undertone | null) => {
      const p = this.profileRows.get(fitRequestId);
      if (!p) return false;
      p.undertoneOverride = undertone;
      return true;
    },
  };

  tryons = {
    insert: async (row: NewTryOn): Promise<TryOnRecord> => {
      const existing = [...this.tryonRows.values()].find((t) => t.fitRequestId === row.fitRequestId && t.cacheKey === row.cacheKey);
      const rec: TryOnRecord = { ...row, id: existing?.id ?? row.id ?? randomUUID() };
      this.tryonRows.set(rec.id, rec);
      return { ...rec };
    },
    get: async (id: string) => {
      const t = this.tryonRows.get(id);
      return t ? { ...t } : undefined;
    },
    listForRequest: async (fitRequestId: string) => [...this.tryonRows.values()].filter((t) => t.fitRequestId === fitRequestId).map((t) => ({ ...t })),
  };

  private addHeart(rec: HeartRecord) {
    // UNIQUE NULLS NOT DISTINCT (fit_request_id, catalog_id, variant_id), as in db/schema.ts.
    if (!this.heartRows.some((h) => h.fitRequestId === rec.fitRequestId && h.catalogId === rec.catalogId && h.variantId === rec.variantId)) this.heartRows.push(rec);
  }

  hearts = {
    add: async (fitRequestId: string, heart: HeartInput) => {
      this.addHeart(toHeartRecord(fitRequestId, heart));
    },
    set: async (fitRequestId: string, hearts: readonly HeartInput[]) => {
      for (let i = this.heartRows.length - 1; i >= 0; i--) if (this.heartRows[i].fitRequestId === fitRequestId) this.heartRows.splice(i, 1);
      for (const h of hearts) this.addHeart(toHeartRecord(fitRequestId, h));
    },
    list: async (fitRequestId: string) => [
      ...this.heartRows.filter((h) => h.fitRequestId === fitRequestId).map(heartRow),
      ...this.wishRows.filter((w) => w.fitRequestId === fitRequestId).map((w) => `${WISH_ROW_PREFIX}${w.catalogId}`),
    ],
    entries: async (fitRequestId: string) => this.heartRows.filter((h) => h.fitRequestId === fitRequestId).map((h) => ({ ...h })),
  };

  wishes = {
    add: async (fitRequestId: string, catalogId: string) => {
      if (!this.wishRows.some((w) => w.fitRequestId === fitRequestId && w.catalogId === catalogId)) this.wishRows.push({ fitRequestId, catalogId });
    },
    list: async (fitRequestId: string) => this.wishRows.filter((w) => w.fitRequestId === fitRequestId).map((w) => w.catalogId),
  };

  reports = {
    get: async (fitRequestId: string) => this.reportRows.get(fitRequestId),
    upsert: async (report: FitReportRecord) => {
      this.reportRows.set(report.fitRequestId, report);
    },
  };

  async deleteRecipientData(fitRequestId: string): Promise<RequestRowCounts> {
    const counts = await this.countForRequest(fitRequestId);
    this.profileRows.delete(fitRequestId);
    for (const [id, t] of this.tryonRows) if (t.fitRequestId === fitRequestId) this.tryonRows.delete(id);
    for (let i = this.heartRows.length - 1; i >= 0; i--) if (this.heartRows[i].fitRequestId === fitRequestId) this.heartRows.splice(i, 1);
    for (let i = this.wishRows.length - 1; i >= 0; i--) if (this.wishRows[i].fitRequestId === fitRequestId) this.wishRows.splice(i, 1);
    this.reportRows.delete(fitRequestId);
    return counts;
  }

  async countForRequest(fitRequestId: string): Promise<RequestRowCounts> {
    return {
      recipient_profiles: this.profileRows.has(fitRequestId) ? 1 : 0,
      tryons: [...this.tryonRows.values()].filter((t) => t.fitRequestId === fitRequestId).length,
      hearts: this.heartRows.filter((h) => h.fitRequestId === fitRequestId).length,
      metal_wishes: this.wishRows.filter((w) => w.fitRequestId === fitRequestId).length,
      fit_reports: this.reportRows.has(fitRequestId) ? 1 : 0,
    };
  }

  private copy(r: FitRequestRecord | undefined): FitRequestRecord | undefined {
    return r ? { ...r, shortlistIds: [...r.shortlistIds], decoyIds: [...r.decoyIds], metalLock: r.metalLock ? [...r.metalLock] : (r.metalLock ?? null) } : undefined;
  }
}

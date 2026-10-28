/**
 * Preview store persistence (owner: A10; ADR-055). STORE=firestore → Firestore collection
 * `preview_stores` (one document per key); otherwise process memory on globalThis.
 *
 *   preview_stores/{key} = {
 *     key, domain, storeUrl (origin only), state, reason, storeName, platform, currency,
 *     products: PreviewProduct[] (≤ 50), productCount, fetches,
 *     createdAt, updatedAt, expiresAt (= createdAt + 24 h, TTL policy field),
 *     ownerTokenHash (sha256 hex; the token itself is never stored), runner (instance id of the crawler),
 *     settings (Admin v0 placeholder),
 *     snapshot (A15: page-snapshot outcome — mode, reason, captured product pages; the pages themselves
 *               live in preview_page_snapshots, see lib/preview/page-snapshot-store.ts)
 *   }
 * Reads treat a record past `expiresAt` as gone (Firestore TTL deletion can lag by a day).
 */
import { isFirestoreStore, type Env } from "@/lib/store/config";
import { defined, isNotFound, toDate, type FsData, type FsDb } from "@/lib/store/firestore-types";
import { getFirestoreDb } from "@/lib/store/gcp-clients";
import type { PageSnapshotInfo } from "./page-snapshot";
import type { PreviewPlatform, PreviewProduct, PreviewReason, PreviewState } from "./types";

export const PREVIEW_COLLECTION = "preview_stores";
export const PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;

/** Admin v0 settings (A6 fills these in; defaults = GiftFit's own). */
export interface PreviewSettings {
  version: 0;
  character?: "mark-kun" | "mascot";
  languages?: string[];
  defaultLanguage?: string;
  accentColor?: string;
  greeting?: string;
  /** Product ids the owner removed from the preview. */
  removedProductIds?: string[];
}

export const DEFAULT_PREVIEW_SETTINGS: PreviewSettings = Object.freeze({ version: 0 }) as PreviewSettings;

export interface PreviewRecord {
  key: string;
  domain: string;
  /** https://<host> only: never a path or query string. */
  storeUrl: string;
  state: PreviewState;
  reason: PreviewReason | null;
  storeName: string | null;
  platform: PreviewPlatform | null;
  currency: string | null;
  products: PreviewProduct[];
  productCount: number;
  fetches: number | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  ownerTokenHash: string;
  /** Process instance that runs (or ran) the crawl; used to detect crawls lost to a restart. */
  runner: string | null;
  settings: PreviewSettings;
  /** Store-page snapshot outcome (A15); absent until a crawl finished with the snapshot step. */
  snapshot?: PageSnapshotInfo | null;
}

export type PreviewPatch = Partial<Omit<PreviewRecord, "key" | "createdAt" | "ownerTokenHash">>;

export interface PreviewRepo {
  readonly kind: string;
  create(rec: PreviewRecord): Promise<void>;
  /** The record, or null when missing or past expiresAt. */
  get(key: string, nowMs?: number): Promise<PreviewRecord | null>;
  update(key: string, patch: PreviewPatch): Promise<void>;
  delete(key: string): Promise<void>;
}

/** 128-bit base64url key (22 chars). */
export const PREVIEW_KEY_RE = /^[A-Za-z0-9_-]{22}$/;

const cloneRec = (r: PreviewRecord): PreviewRecord => structuredClone(r);

export class MemoryPreviewRepo implements PreviewRepo {
  readonly kind = "memory";
  readonly records = new Map<string, PreviewRecord>();

  async create(rec: PreviewRecord): Promise<void> {
    if (this.records.has(rec.key)) throw new Error("preview key collision");
    this.records.set(rec.key, cloneRec(rec));
    this.sweep(Date.now());
  }

  async get(key: string, nowMs: number = Date.now()): Promise<PreviewRecord | null> {
    const r = this.records.get(key);
    if (!r) return null;
    if (r.expiresAt.getTime() <= nowMs) {
      this.records.delete(key);
      return null;
    }
    return cloneRec(r);
  }

  async update(key: string, patch: PreviewPatch): Promise<void> {
    const r = this.records.get(key);
    if (!r) throw new Error("preview not found");
    this.records.set(key, cloneRec({ ...r, ...patch } as PreviewRecord));
  }

  async delete(key: string): Promise<void> {
    this.records.delete(key);
  }

  /** Memory-mode stand-in for the TTL policy. */
  private sweep(nowMs: number): void {
    for (const [k, r] of this.records) if (r.expiresAt.getTime() <= nowMs) this.records.delete(k);
  }
}

function toDoc(rec: PreviewRecord): FsData {
  return defined({ ...rec, products: rec.products.map((p) => defined({ ...p })), settings: defined({ ...rec.settings }), snapshot: rec.snapshot ? defined({ ...rec.snapshot }) : rec.snapshot } as unknown as FsData);
}

function snapshotFromDoc(v: unknown): PageSnapshotInfo | null {
  if (!v || typeof v !== "object") return null;
  const d = v as FsData;
  return {
    mode: d.mode === "snapshot" ? "snapshot" : "template",
    reason: (d.reason ?? null) as PageSnapshotInfo["reason"],
    capturedAt: d.capturedAt ? toDate(d.capturedAt) : new Date(0),
    productPages: Array.isArray(d.productPages) ? d.productPages.map(String) : [],
    bytes: Number(d.bytes ?? 0),
    fetches: Number(d.fetches ?? 0),
  };
}

function fromDoc(d: FsData): PreviewRecord {
  return {
    key: String(d.key),
    domain: String(d.domain ?? ""),
    storeUrl: String(d.storeUrl ?? ""),
    state: d.state as PreviewState,
    reason: (d.reason ?? null) as PreviewReason | null,
    storeName: (d.storeName ?? null) as string | null,
    platform: (d.platform ?? null) as PreviewPlatform | null,
    currency: (d.currency ?? null) as string | null,
    products: Array.isArray(d.products) ? (d.products as PreviewProduct[]) : [],
    productCount: Number(d.productCount ?? 0),
    fetches: d.fetches === undefined || d.fetches === null ? null : Number(d.fetches),
    createdAt: toDate(d.createdAt),
    updatedAt: toDate(d.updatedAt),
    expiresAt: toDate(d.expiresAt),
    ownerTokenHash: String(d.ownerTokenHash ?? ""),
    runner: (d.runner ?? null) as string | null,
    settings: (d.settings as PreviewSettings | undefined) ?? { ...DEFAULT_PREVIEW_SETTINGS },
    snapshot: snapshotFromDoc(d.snapshot),
  };
}

export class FirestorePreviewRepo implements PreviewRepo {
  readonly kind = "firestore";
  constructor(private readonly db: () => Promise<FsDb>) {}

  private async ref(key: string) {
    if (!PREVIEW_KEY_RE.test(key)) throw new Error("invalid preview key");
    return (await this.db()).collection(PREVIEW_COLLECTION).doc(key);
  }

  async create(rec: PreviewRecord): Promise<void> {
    const ref = await this.ref(rec.key);
    const db = await this.db();
    await db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (s.exists) throw new Error("preview key collision");
      tx.set(ref, toDoc(rec));
    });
  }

  async get(key: string, nowMs: number = Date.now()): Promise<PreviewRecord | null> {
    if (!PREVIEW_KEY_RE.test(key)) return null;
    const s = await (await this.ref(key)).get();
    if (!s.exists) return null;
    const rec = fromDoc(s.data() ?? {});
    return rec.expiresAt.getTime() <= nowMs ? null : rec;
  }

  async update(key: string, patch: PreviewPatch): Promise<void> {
    const data: FsData = { ...patch } as FsData;
    if (patch.products) data.products = patch.products.map((p) => defined({ ...p }));
    if (patch.settings) data.settings = defined({ ...patch.settings });
    if (patch.snapshot) data.snapshot = defined({ ...patch.snapshot });
    try {
      await (await this.ref(key)).update(defined(data));
    } catch (err) {
      if (isNotFound(err)) throw new Error("preview not found");
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await (await this.ref(key)).delete();
  }
}

const REPO_KEY = Symbol.for("giftfit.preview.repo.v1");

/** Process-wide repo: Firestore with STORE=firestore, else memory (shared by every route bundle). */
export function defaultPreviewRepo(env: Env = process.env): PreviewRepo {
  const g = globalThis as typeof globalThis & { [REPO_KEY]?: PreviewRepo };
  return (g[REPO_KEY] ??= isFirestoreStore(env) ? new FirestorePreviewRepo(() => getFirestoreDb(env)) : new MemoryPreviewRepo());
}

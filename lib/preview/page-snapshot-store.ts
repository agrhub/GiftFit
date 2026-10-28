/**
 * Storage for sanitized store-page snapshots (owner: A15). One document per page, keyed by preview key,
 * so a preview record never nears Firestore's 1 MiB document limit:
 *
 *   preview_page_snapshots/{key}_{page} = { key, page, productId, url, html (≤ 600 KB), bytes,
 *                                           createdAt, expiresAt }
 *     page = "home" | "p-<sha256(productId) first 32 hex>"
 *
 * `expiresAt` mirrors the preview's own `expiresAt` (written with it, moved with it when a gift link
 * extends the preview), so the same Firestore TTL policy deletes both; R0 enables TTL on
 * `preview_page_snapshots.expiresAt`. Reads treat a document past `expiresAt` as gone, and the routes only
 * serve a page while its preview record is live and ready. STORE=firestore → Firestore; else memory.
 */
import { createHash } from "node:crypto";
import { isFirestoreStore, type Env } from "@/lib/store/config";
import { deleteRefs, toDate, type FsData, type FsDb } from "@/lib/store/firestore-types";
import { getFirestoreDb } from "@/lib/store/gcp-clients";

export const PAGE_SNAPSHOT_COLLECTION = "preview_page_snapshots";

export interface StoredSnapshotPage {
  key: string;
  page: string;
  /** Store-side product id for a product page; null for the home page. */
  productId: string | null;
  /** The merchant page it was taken from (https, after redirects). */
  url: string;
  html: string;
  bytes: number;
  createdAt: Date;
  expiresAt: Date;
}

export interface PageSnapshotStore {
  readonly kind: string;
  put(page: StoredSnapshotPage): Promise<void>;
  get(key: string, page: string, nowMs?: number): Promise<StoredSnapshotPage | null>;
  /** Removes every page of a preview. */
  deleteFor(key: string): Promise<void>;
  /** Moves every page's expiresAt (the preview was extended). */
  extend(key: string, expiresAt: Date): Promise<void>;
}

export const HOME_PAGE_ID = "home";
export const productPageId = (productId: string): string => `p-${createHash("sha256").update(productId, "utf8").digest("hex").slice(0, 32)}`;

const docId = (key: string, page: string) => `${key}_${page}`;

export class MemoryPageSnapshotStore implements PageSnapshotStore {
  readonly kind = "memory";
  readonly pages = new Map<string, StoredSnapshotPage>();

  async put(p: StoredSnapshotPage): Promise<void> {
    this.pages.set(docId(p.key, p.page), { ...p });
    const now = Date.now();
    for (const [id, x] of this.pages) if (x.expiresAt.getTime() <= now) this.pages.delete(id);
  }

  async get(key: string, page: string, nowMs: number = Date.now()): Promise<StoredSnapshotPage | null> {
    const p = this.pages.get(docId(key, page));
    if (!p) return null;
    if (p.expiresAt.getTime() <= nowMs) {
      this.pages.delete(docId(key, page));
      return null;
    }
    return { ...p };
  }

  async deleteFor(key: string): Promise<void> {
    for (const [id, p] of this.pages) if (p.key === key) this.pages.delete(id);
  }

  async extend(key: string, expiresAt: Date): Promise<void> {
    for (const p of this.pages.values()) if (p.key === key) p.expiresAt = new Date(expiresAt.getTime());
  }
}

export class FirestorePageSnapshotStore implements PageSnapshotStore {
  readonly kind = "firestore";
  constructor(private readonly db: () => Promise<FsDb>) {}

  private async col() {
    return (await this.db()).collection(PAGE_SNAPSHOT_COLLECTION);
  }

  async put(p: StoredSnapshotPage): Promise<void> {
    await (await this.col()).doc(docId(p.key, p.page)).set({ ...p } as unknown as FsData);
  }

  async get(key: string, page: string, nowMs: number = Date.now()): Promise<StoredSnapshotPage | null> {
    const s = await (await this.col()).doc(docId(key, page)).get();
    if (!s.exists) return null;
    const d = s.data() ?? {};
    const out: StoredSnapshotPage = {
      key: String(d.key ?? ""),
      page: String(d.page ?? ""),
      productId: (d.productId ?? null) as string | null,
      url: String(d.url ?? ""),
      html: String(d.html ?? ""),
      bytes: Number(d.bytes ?? 0),
      createdAt: toDate(d.createdAt),
      expiresAt: toDate(d.expiresAt),
    };
    if (out.key !== key || out.expiresAt.getTime() <= nowMs) return null;
    return out;
  }

  async deleteFor(key: string): Promise<void> {
    const snap = await (await this.col()).where("key", "==", key).get();
    if (!snap.size) return;
    const col = await this.col();
    await deleteRefs(await this.db(), snap.docs.map((d) => col.doc(d.id)));
  }

  async extend(key: string, expiresAt: Date): Promise<void> {
    const col = await this.col();
    const snap = await col.where("key", "==", key).get();
    for (const d of snap.docs) await col.doc(d.id).update({ expiresAt });
  }
}

const STORE_KEY = Symbol.for("giftfit.preview.pageSnapshots.v1");

/** Process-wide store (tests may replace it with setPageSnapshotStoreForTests). */
export function defaultPageSnapshotStore(env: Env = process.env): PageSnapshotStore {
  const g = globalThis as typeof globalThis & { [STORE_KEY]?: PageSnapshotStore };
  return (g[STORE_KEY] ??= isFirestoreStore(env) ? new FirestorePageSnapshotStore(() => getFirestoreDb(env)) : new MemoryPageSnapshotStore());
}

export function setPageSnapshotStoreForTests(store: PageSnapshotStore | undefined): void {
  const g = globalThis as typeof globalThis & { [STORE_KEY]?: PageSnapshotStore };
  if (store) g[STORE_KEY] = store;
  else delete g[STORE_KEY];
}

/**
 * Widget contact records (owner: A6, ADR-046): the e-mail addresses a giver typed into the widget.
 * Server-only. These are PII, so:
 *
 *   - one record per purpose, bound to ONE Fit Request: `recipient_card` (the address a gift card was
 *     sent to) and `giver_notify` (where to send "your Fit Report is ready");
 *   - sealed at rest with AES-256-GCM (key derived from GIFTFIT_URL_SIGNING_SECRET with HKDF); the
 *     Firestore document holds no readable address;
 *   - `expiresAt` = the request's expiry (72 h): reads ignore and drop expired rows, Firestore's TTL
 *     policy on `widget_contacts.expiresAt` is the backstop, and deleteEverything() (Delete everything,
 *     72 h purge) removes them with the request;
 *   - `giver_notify` is deleted as soon as the notification is sent;
 *   - never returned by any route, never logged (only counts and the e-mail domain, via lib/email).
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import type { CardLang } from "@/lib/email/templates";
import { getSigningSecret } from "@/lib/privacy/signed-url";
import { isFirestoreStore } from "@/lib/store/config";
import { deleteRefs, toDate, type FsDb } from "@/lib/store/firestore-types";
import { getFirestoreDb } from "@/lib/store/gcp-clients";

export const CONTACTS_COLLECTION = "widget_contacts";
export const CONTACT_KINDS = ["recipient_card", "giver_notify"] as const;
export type ContactKind = (typeof CONTACT_KINDS)[number];

/** What a sealed record contains. `giverToken` only for giver_notify (the report link needs it). */
export interface ContactPayload {
  email: string;
  lang: CardLang;
  giverToken?: string;
  giverName?: string;
}

export interface ContactRecord {
  id: string;
  fitRequestId: string;
  kind: ContactKind;
  sealed: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface WidgetContactStore {
  readonly kind: "memory" | "firestore";
  put(rec: ContactRecord): Promise<void>;
  /** Unexpired records of a request (expired ones are deleted on the way). */
  list(fitRequestId: string, now: Date, kind?: ContactKind): Promise<ContactRecord[]>;
  delete(id: string): Promise<void>;
  /** Deletes every record of a request (expired or not); returns how many. */
  deleteForRequest(fitRequestId: string): Promise<number>;
}

// ---------------------------------------------------------------------------------------------
// Sealing
// ---------------------------------------------------------------------------------------------

const SEAL_VERSION = "v1";

function key(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, "giftfit-widget-contacts", "aes-256-gcm v1", 32));
}

export function sealContact(payload: ContactPayload, secret: string = getSigningSecret()): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(secret), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(payload), "utf8"), c.final()]);
  return [SEAL_VERSION, iv.toString("base64url"), ct.toString("base64url"), c.getAuthTag().toString("base64url")].join(".");
}

/** The payload, or null when the record was tampered with or sealed under another secret. */
export function openContact(sealed: string, secret: string = getSigningSecret()): ContactPayload | null {
  const [v, iv, ct, tag] = sealed.split(".");
  if (v !== SEAL_VERSION || !iv || !ct || !tag) return null;
  try {
    const d = createDecipheriv("aes-256-gcm", key(secret), Buffer.from(iv, "base64url"));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    const json = Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
    const p = JSON.parse(json) as ContactPayload;
    return typeof p.email === "string" ? p : null;
  } catch {
    return null;
  }
}

export function newContactRecord(input: { fitRequestId: string; kind: ContactKind; payload: ContactPayload; now: Date; expiresAt: Date; secret?: string }): ContactRecord {
  return {
    id: randomUUID(),
    fitRequestId: input.fitRequestId,
    kind: input.kind,
    sealed: sealContact(input.payload, input.secret),
    createdAt: input.now,
    expiresAt: input.expiresAt,
  };
}

// ---------------------------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------------------------

export class MemoryContactStore implements WidgetContactStore {
  readonly kind = "memory";
  private readonly rows = new Map<string, ContactRecord>();

  async put(rec: ContactRecord): Promise<void> {
    this.rows.set(rec.id, { ...rec });
  }

  async list(fitRequestId: string, now: Date, kind?: ContactKind): Promise<ContactRecord[]> {
    const out: ContactRecord[] = [];
    for (const [id, r] of this.rows) {
      if (r.expiresAt.getTime() <= now.getTime()) {
        this.rows.delete(id);
        continue;
      }
      if (r.fitRequestId === fitRequestId && (!kind || r.kind === kind)) out.push({ ...r });
    }
    return out.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async delete(id: string): Promise<void> {
    this.rows.delete(id);
  }

  async deleteForRequest(fitRequestId: string): Promise<number> {
    let n = 0;
    for (const [id, r] of this.rows) {
      if (r.fitRequestId === fitRequestId) {
        this.rows.delete(id);
        n++;
      }
    }
    return n;
  }

  /** Tests: every stored row (sealed). */
  all(): ContactRecord[] {
    return [...this.rows.values()];
  }
}

/** widget_contacts/{id} = { fitRequestId, kind, sealed, createdAt, expiresAt }. Equality queries only. */
export class FirestoreContactStore implements WidgetContactStore {
  readonly kind = "firestore";
  constructor(private readonly db: () => Promise<FsDb>) {}

  async put(rec: ContactRecord): Promise<void> {
    const db = await this.db();
    await db.collection(CONTACTS_COLLECTION).doc(rec.id).set({ fitRequestId: rec.fitRequestId, kind: rec.kind, sealed: rec.sealed, createdAt: rec.createdAt, expiresAt: rec.expiresAt });
  }

  async list(fitRequestId: string, now: Date, kind?: ContactKind): Promise<ContactRecord[]> {
    const db = await this.db();
    const snap = await db.collection(CONTACTS_COLLECTION).where("fitRequestId", "==", fitRequestId).get();
    const out: ContactRecord[] = [];
    const expired = [];
    for (const doc of snap.docs) {
      const d = doc.data() ?? {};
      const rec: ContactRecord = { id: doc.id, fitRequestId, kind: d.kind as ContactKind, sealed: String(d.sealed ?? ""), createdAt: toDate(d.createdAt), expiresAt: toDate(d.expiresAt) };
      if (rec.expiresAt.getTime() <= now.getTime()) expired.push(db.collection(CONTACTS_COLLECTION).doc(doc.id));
      else if (!kind || rec.kind === kind) out.push(rec);
    }
    if (expired.length) await deleteRefs(db, expired);
    return out.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async delete(id: string): Promise<void> {
    const db = await this.db();
    await db.collection(CONTACTS_COLLECTION).doc(id).delete();
  }

  async deleteForRequest(fitRequestId: string): Promise<number> {
    const db = await this.db();
    const snap = await db.collection(CONTACTS_COLLECTION).where("fitRequestId", "==", fitRequestId).get();
    await deleteRefs(
      db,
      snap.docs.map((d) => db.collection(CONTACTS_COLLECTION).doc(d.id)),
    );
    return snap.size;
  }
}

const KEY = Symbol.for("giftfit.widget.contacts.v1");
type G = typeof globalThis & { [KEY]?: WidgetContactStore };

/** Process-wide store: Firestore with STORE=firestore, else memory (shared across route bundles). */
export function getContactStore(): WidgetContactStore {
  const g = globalThis as G;
  return (g[KEY] ??= isFirestoreStore() ? new FirestoreContactStore(() => getFirestoreDb()) : new MemoryContactStore());
}

/** Tests: inject a store (undefined = back to the environment default). */
export function setContactStore(store: WidgetContactStore | undefined): void {
  const g = globalThis as G;
  if (store) g[KEY] = store;
  else delete g[KEY];
}

/**
 * Deletes a request's contact records; called by lib/privacy deleteEverything (Delete everything and
 * the 72 h purge). Never throws: a failure is logged without ids and the TTL policy still applies.
 */
export async function deleteContactsForRequest(fitRequestId: string): Promise<number> {
  try {
    return await getContactStore().deleteForRequest(fitRequestId);
  } catch (err) {
    console.error("[widget] contact deletion failed:", (err as Error).message);
    return 0;
  }
}

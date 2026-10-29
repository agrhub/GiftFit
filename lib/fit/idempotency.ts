/**
 * Idempotent POST /api/fit/requests (A25). A client that lost a response (the network path dropped it, the
 * browser re-sent the POST on a fresh connection, or the widget's 20 s timeout fired) retries with the same
 * `Idempotency-Key` header and gets the SAME CreateFitRequestResponse back instead of a second request.
 * The giver token is only ever returned at creation (and stored hashed), so the replay needs the original
 * response: it is kept here, in memory, for a short TTL.
 *
 * Scope and limits (documented on purpose):
 * - In-process only. The service runs one instance (Cloud Run maxScale=1), so one map sees every retry. A cold
 *   restart (or a second instance) between the two calls still creates a second request; that request is
 *   harmless: no units spent, never opened, it expires after 72 h.
 * - Bounded: entries live `ttlMs` (15 min) and at most `maxEntries` (oldest evicted first).
 * - Entries are keyed by SHA-256(key | salted client-IP hash | SHA-256(raw body)): another client (or the same
 *   key with a different body) never receives someone else's response. Neither the key nor the tokens are
 *   logged; the map holds only that digest and the response the caller would have received.
 * - Concurrency: the in-flight promise is stored, so two concurrent requests with one key create once.
 * - Only a 201 is kept after it settles; any other outcome (400, 422, 429, a throw) is shared with requests that
 *   joined while it was in flight, then forgotten, so a later retry runs again.
 */
import { createHash } from "node:crypto";
import { IDEMPOTENCY_KEY_HEADER } from "@/lib/contracts/api";

/** HTTP header the client sends (IETF draft "The Idempotency-Key HTTP Header Field"). */
export const IDEMPOTENCY_HEADER = IDEMPOTENCY_KEY_HEADER;
export const IDEMPOTENCY_TTL_MS = 15 * 60 * 1000;
export const IDEMPOTENCY_MAX_ENTRIES = 1000;

/** UUID-ish: 16–64 of [A-Za-z0-9_-]. Anything else is ignored (the request runs as if no key was sent). */
export function parseIdempotencyKey(raw: string | null | undefined): string | undefined {
  const key = raw?.trim();
  return key && /^[A-Za-z0-9_-]{16,64}$/.test(key) ? key : undefined;
}

/** The map key: a digest only, never the raw key. */
export function idempotencyDigest(key: string, clientHash: string, rawBody: string): string {
  const body = createHash("sha256").update(rawBody, "utf8").digest("hex");
  return createHash("sha256").update(`${key}|${clientHash}|${body}`, "utf8").digest("base64url");
}

/** What one create attempt answered (already giver-guarded once), replayed through the guard again. */
export interface StoredOutcome {
  status: number;
  payload: unknown;
  retryAfter?: string;
}

interface Entry<T> {
  expiresAt: number;
  promise: Promise<T>;
}

export interface IdempotencyStoreOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

export class IdempotencyStore<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(opts: IdempotencyStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? IDEMPOTENCY_TTL_MS;
    this.maxEntries = Math.max(1, opts.maxEntries ?? IDEMPOTENCY_MAX_ENTRIES);
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * Runs `fn` once per digest within the TTL. Later and concurrent callers get the first call's value
   * (`replayed: true`). `keep(value)` decides whether a settled value stays for replays.
   */
  async run(digest: string, fn: () => Promise<T>, keep: (value: T) => boolean): Promise<{ value: T; replayed: boolean }> {
    const now = this.now();
    this.sweep(now);
    const hit = this.entries.get(digest);
    if (hit) return { value: await hit.promise, replayed: true };

    const promise = fn();
    const entry: Entry<T> = { expiresAt: now + this.ttlMs, promise };
    this.entries.set(digest, entry);
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value as string);
    const forget = () => {
      if (this.entries.get(digest) === entry) this.entries.delete(digest);
    };
    try {
      const value = await promise;
      if (!keep(value)) forget();
      return { value, replayed: false };
    } catch (err) {
      forget();
      throw err;
    }
  }

  private sweep(now: number): void {
    // Insertion order = expiry order (one TTL for all), so stop at the first live entry.
    for (const [k, e] of this.entries) {
      if (e.expiresAt > now) break;
      this.entries.delete(k);
    }
  }
}

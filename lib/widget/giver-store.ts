/**
 * The giver's saved gifts in the widget frame (owner: A6). Browser-safe; storage is injected.
 *
 * The giver token is kept in the GiftFit IFRAME's localStorage (origin = GiftFit; browsers partition
 * third-party storage per top-level site, so it is also scoped to the store the gift was made on). The
 * host page can't read it, and it never crosses postMessage. Entries drop out at their 72 h expiry.
 *
 * Report polling is lazy: at most once per browser session (sessionStorage flag), at most once every
 * POLL_MIN_INTERVAL_MS across sessions, at most MAX_POLLS gifts per check, and never for a gift we
 * already announced or that has expired.
 */

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SavedGift {
  giverToken: string;
  createdAt: string;
  expiresAt: string;
  occasion?: string;
  /** The character already said this report is ready. */
  announced?: boolean;
}

export const GIFTS_KEY = "giftfit.widget.gifts.v1";
export const LAST_POLL_KEY = "giftfit.widget.lastPoll.v1";
export const SESSION_POLLED_KEY = "giftfit.widget.polled.v1";
export const MAX_SAVED_GIFTS = 5;
export const MAX_POLLS = 3;
export const POLL_MIN_INTERVAL_MS = 10 * 60 * 1000;

const TOKEN_RE = /^[A-Za-z0-9_-]{22,86}$/;

function read(store: KeyValueStore | null | undefined, key: string): string | null {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(store: KeyValueStore | null | undefined, key: string, value: string): void {
  try {
    store?.setItem(key, value);
  } catch {
    /* storage blocked or full: the widget still works, it just won't remember */
  }
}

/** Valid, unexpired saved gifts, newest first. */
export function loadGifts(local: KeyValueStore | null | undefined, now: number): SavedGift[] {
  const raw = read(local, GIFTS_KEY);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((g): g is SavedGift => {
      if (!g || typeof g !== "object") return false;
      const x = g as SavedGift;
      return typeof x.giverToken === "string" && TOKEN_RE.test(x.giverToken) && typeof x.expiresAt === "string" && Date.parse(x.expiresAt) > now;
    })
    .slice(0, MAX_SAVED_GIFTS);
}

function store(local: KeyValueStore | null | undefined, gifts: SavedGift[]): void {
  if (gifts.length) write(local, GIFTS_KEY, JSON.stringify(gifts.slice(0, MAX_SAVED_GIFTS)));
  else {
    try {
      local?.removeItem(GIFTS_KEY);
    } catch {
      /* ignore */
    }
  }
}

export function saveGift(local: KeyValueStore | null | undefined, gift: SavedGift, now: number): void {
  if (!TOKEN_RE.test(gift.giverToken)) return;
  const rest = loadGifts(local, now).filter((g) => g.giverToken !== gift.giverToken);
  store(local, [{ giverToken: gift.giverToken, createdAt: gift.createdAt, expiresAt: gift.expiresAt, ...(gift.occasion ? { occasion: gift.occasion } : {}) }, ...rest]);
}

export function markAnnounced(local: KeyValueStore | null | undefined, giverToken: string, now: number): void {
  store(
    local,
    loadGifts(local, now).map((g) => (g.giverToken === giverToken ? { ...g, announced: true } : g)),
  );
}

export interface PollGate {
  local: KeyValueStore | null | undefined;
  session: KeyValueStore | null | undefined;
  now: number;
}

/** Gifts worth asking about now ([] = don't poll). */
export function giftsToPoll({ local, session, now }: PollGate): SavedGift[] {
  if (read(session, SESSION_POLLED_KEY)) return [];
  const last = Number(read(local, LAST_POLL_KEY));
  if (Number.isFinite(last) && last > 0 && now - last < POLL_MIN_INTERVAL_MS) return [];
  return loadGifts(local, now)
    .filter((g) => !g.announced)
    .slice(0, MAX_POLLS);
}

export function markPolled({ local, session, now }: PollGate): void {
  write(session, SESSION_POLLED_KEY, "1");
  write(local, LAST_POLL_KEY, String(now));
}

export type ReportStatus = "waiting" | "in_progress" | "completed" | "expired";

/**
 * One lazy check: asks for each pending gift's status (POST /api/fit/report via `fetchStatus`) and
 * returns the first completed one. Marks the session as polled BEFORE the requests, so a reload or a
 * second tab in the same session never polls again. Errors count as "not ready".
 */
export async function checkReadyReport(gate: PollGate, fetchStatus: (giverToken: string) => Promise<ReportStatus | null>): Promise<SavedGift | null> {
  const pending = giftsToPoll(gate);
  if (!pending.length) return null;
  markPolled(gate);
  for (const g of pending) {
    let status: ReportStatus | null = null;
    try {
      status = await fetchStatus(g.giverToken);
    } catch {
      status = null;
    }
    if (status === "completed") return g;
  }
  return null;
}

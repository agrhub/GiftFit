import { describe, expect, it, vi } from "vitest";
import { checkReadyReport, GIFTS_KEY, giftsToPoll, loadGifts, markAnnounced, MAX_POLLS, MAX_SAVED_GIFTS, POLL_MIN_INTERVAL_MS, saveGift, type KeyValueStore } from "../giver-store";

class Mem implements KeyValueStore {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

const T0 = Date.parse("2026-10-26T10:00:00Z");
const H = 3600_000;
const tok = (i: number) => `tok${i}`.padEnd(43, "A");
const gift = (i: number, expiresInH = 72) => ({ giverToken: tok(i), createdAt: new Date(T0).toISOString(), expiresAt: new Date(T0 + expiresInH * H).toISOString() });

describe("saved gifts", () => {
  it("keeps valid unexpired gifts, newest first, capped", () => {
    const local = new Mem();
    for (let i = 0; i < 8; i++) saveGift(local, gift(i), T0);
    const gifts = loadGifts(local, T0);
    expect(gifts).toHaveLength(MAX_SAVED_GIFTS);
    expect(gifts[0].giverToken).toBe(tok(7));
    saveGift(local, { ...gift(9), giverToken: "bad token" }, T0);
    expect(loadGifts(local, T0)[0].giverToken).toBe(tok(7));
    expect(loadGifts(local, T0 + 73 * H)).toEqual([]);
  });

  it("survives broken or blocked storage", () => {
    const local = new Mem();
    local.setItem(GIFTS_KEY, "{not json");
    expect(loadGifts(local, T0)).toEqual([]);
    const throwing: KeyValueStore = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => undefined,
    };
    expect(() => saveGift(throwing, gift(1), T0)).not.toThrow();
    expect(loadGifts(throwing, T0)).toEqual([]);
    expect(loadGifts(null, T0)).toEqual([]);
  });
});

describe("report polling throttle", () => {
  it("polls at most once per session and once per interval, never announced or expired gifts", async () => {
    const local = new Mem();
    const session = new Mem();
    saveGift(local, gift(1, 1), T0);
    saveGift(local, gift(2), T0);
    const fetchStatus = vi.fn(async (t: string) => (t === tok(1) ? ("completed" as const) : ("waiting" as const)));

    const ready = await checkReadyReport({ local, session, now: T0 }, fetchStatus);
    expect(ready?.giverToken).toBe(tok(1));
    expect(fetchStatus).toHaveBeenCalledTimes(2);

    // Same session: never again.
    expect(await checkReadyReport({ local, session, now: T0 + 2 * POLL_MIN_INTERVAL_MS }, fetchStatus)).toBeNull();
    expect(fetchStatus).toHaveBeenCalledTimes(2);

    // New session but within the interval: no.
    expect(giftsToPoll({ local, session: new Mem(), now: T0 + POLL_MIN_INTERVAL_MS / 2 })).toEqual([]);

    // New session after the interval, gift 1 announced and gift 1 expired anyway: only gift 2.
    markAnnounced(local, tok(1), T0);
    expect(giftsToPoll({ local, session: new Mem(), now: T0 + 2 * H }).map((g) => g.giverToken)).toEqual([tok(2)]);
  });

  it("caps the number of status calls and treats errors as not ready", async () => {
    const local = new Mem();
    for (let i = 0; i < 5; i++) saveGift(local, gift(i), T0);
    const fetchStatus = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await checkReadyReport({ local, session: new Mem(), now: T0 }, fetchStatus)).toBeNull();
    expect(fetchStatus).toHaveBeenCalledTimes(MAX_POLLS);
  });

  it("does nothing without saved gifts", async () => {
    const fetchStatus = vi.fn();
    const session = new Mem();
    expect(await checkReadyReport({ local: new Mem(), session, now: T0 }, fetchStatus)).toBeNull();
    expect(fetchStatus).not.toHaveBeenCalled();
  });
});

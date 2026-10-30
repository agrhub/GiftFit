import { afterEach, describe, expect, it, vi } from "vitest";
import { FirestoreRateLimitStore } from "@/server/privacy/rate-limit-firestore";
import { RATE_LIMITS, rateKeysForTests, setRateLimitOverride, setRateLimitStore, takeRateFor } from "@/server/privacy/rate-limit";
import { resetPrivacyState } from "@/server/privacy/global-state";
import { FirestoreAuditSink, firestoreAuditDoc, AUDIT_RETENTION_MS } from "@/server/youcam/audit";
import { firestoreDatabaseId, gcsPhotoBucket, storeKind } from "../config";
import { FirestoreDailyCounterStore, MemoryDailyCounterStore, counterExpiresAt, dailyCounterKey, defaultDailyCounterStore, type DailyCounterStore } from "../daily-counter";
import { COLLECTIONS } from "../firestore-types";
import { FakeFirestore, FakeTimestamp } from "./fake-firestore";

describe("store selection (server/store/config.ts)", () => {
  it("STORE=firestore|memory, else Drizzle with DATABASE_URL, else memory", () => {
    expect(storeKind({ STORE: "firestore" })).toBe("firestore");
    expect(storeKind({ STORE: " Firestore ", DATABASE_URL: "postgres://x" })).toBe("firestore");
    expect(storeKind({ STORE: "memory", DATABASE_URL: "postgres://x" })).toBe("memory");
    expect(storeKind({ DATABASE_URL: "postgres://x" })).toBe("drizzle");
    expect(storeKind({})).toBe("memory");
    expect(() => storeKind({ STORE: "redis" })).toThrow(/STORE/);
  });

  it("only ever addresses a giftfit database and a giftfit bucket", () => {
    expect(firestoreDatabaseId({})).toBe("giftfit-db");
    expect(firestoreDatabaseId({ FIRESTORE_DATABASE_ID: "giftfit-db" })).toBe("giftfit-db");
    expect(() => firestoreDatabaseId({ FIRESTORE_DATABASE_ID: "(default)" })).toThrow(/giftfit/);
    expect(() => firestoreDatabaseId({ FIRESTORE_DATABASE_ID: "shine-db" })).toThrow(/giftfit/);
    expect(gcsPhotoBucket({ GCS_PHOTO_BUCKET: "gcp-project-405602-giftfit-photos" })).toBe("gcp-project-405602-giftfit-photos");
    expect(() => gcsPhotoBucket({})).toThrow(/GCS_PHOTO_BUCKET/);
    expect(() => gcsPhotoBucket({ GCS_PHOTO_BUCKET: "gcp-project-405602-shine-assets" })).toThrow(/giftfit/);
  });

  it("has no durable counter outside STORE=firestore", () => {
    expect(defaultDailyCounterStore({})).toBeUndefined();
    expect(defaultDailyCounterStore({ STORE: "memory" })).toBeUndefined();
    expect(defaultDailyCounterStore({ STORE: "firestore" })?.kind).toBe("firestore"); // lazy: no client is built here
  });
});

const DAY = Date.parse("2026-10-17T10:00:00Z");

describe.each([
  { name: "memory", make: () => ({ store: new MemoryDailyCounterStore() as DailyCounterStore, db: undefined as FakeFirestore | undefined }) },
  {
    name: "firestore (fake)",
    make: () => {
      const db = new FakeFirestore();
      return { store: new FirestoreDailyCounterStore(async () => db, () => DAY) as DailyCounterStore, db };
    },
  },
])("DailyCounterStore contract: $name", ({ make }) => {
  it("reserves up to the cap, refuses beyond it without counting, and refunds (never below 0)", async () => {
    const { store } = make();
    const key = dailyCounterKey("youcam", DAY);
    expect(key).toBe("youcam-2026-10-17");
    expect(await store.get(key)).toBe(0);
    expect(await store.tryReserve(key, 30, 50)).toEqual({ ok: true, used: 30, cap: 50 });
    expect(await store.tryReserve(key, 20, 50)).toEqual({ ok: true, used: 50, cap: 50 }); // exactly the cap
    expect(await store.tryReserve(key, 1, 50)).toEqual({ ok: false, used: 50, cap: 50 });
    expect(await store.get(key)).toBe(50);
    expect(await store.refund(key, 20)).toBe(30);
    expect(await store.refund(key, 100)).toBe(0);
    expect(await store.tryReserve(key, 999, 0)).toMatchObject({ ok: true }); // cap 0 = no cap
    expect(await store.get("anthropic-2026-10-17")).toBe(0); // keys are independent
  });

  it("never lets concurrent reservations pass the cap together", async () => {
    const { store } = make();
    const results = await Promise.all(Array.from({ length: 25 }, () => store.tryReserve("youcam-2026-10-17", 1, 10)));
    expect(results.filter((r) => r.ok)).toHaveLength(10);
    expect(await store.get("youcam-2026-10-17")).toBe(10);
  });

  it("validates keys and amounts", async () => {
    const { store } = make();
    await expect(store.tryReserve("bad/key", 1, 1)).rejects.toThrow(/key/);
    await expect(store.tryReserve("youcam-x", -1, 1)).rejects.toThrow(/amount/);
  });
});

describe("FirestoreDailyCounterStore", () => {
  it("keeps the count across a cold start and carries a TTL 3 days after the counted day", async () => {
    const db = new FakeFirestore();
    await new FirestoreDailyCounterStore(async () => db, () => DAY).tryReserve("youcam-2026-10-17", 40, 150);
    const fresh = new FirestoreDailyCounterStore(async () => db, () => DAY);
    expect(await fresh.get("youcam-2026-10-17")).toBe(40);
    expect(await fresh.tryReserve("youcam-2026-10-17", 111, 150)).toMatchObject({ ok: false, used: 40 });
    const [doc] = db.docs(COLLECTIONS.dailyCounters);
    expect(doc.id).toBe("youcam-2026-10-17");
    expect(doc.data.expiresAt).toBeInstanceOf(FakeTimestamp);
    expect((doc.data.expiresAt as FakeTimestamp).toDate().toISOString()).toBe("2026-10-21T00:00:00.000Z");
    expect(counterExpiresAt("no-date", DAY).getTime()).toBe(DAY + 3 * 86_400_000);
  });
});

describe("FirestoreRateLimitStore", () => {
  const H = 3600_000;
  const t0 = Date.parse("2026-10-17T10:00:00Z");

  it("applies the same limits in fixed windows, does not count refusals, and expires each window at its end", async () => {
    const db = new FakeFirestore();
    const store = new FirestoreRateLimitStore(async () => db);
    const rules = RATE_LIMITS.capture; // 2/h, 4/24h
    expect(await store.take("capture", "k", t0, rules)).toEqual({ ok: true, retryAfterSec: 0 });
    expect(await store.take("capture", "k", t0 + 1000, rules)).toEqual({ ok: true, retryAfterSec: 0 });
    const no = await store.take("capture", "k", t0 + 2000, rules);
    expect(no.ok).toBe(false);
    expect(no.retryAfterSec).toBe(Math.ceil((Date.parse("2026-10-17T11:00:00Z") - (t0 + 2000)) / 1000)); // end of the hourly window
    expect(await store.take("capture", "other", t0, rules)).toMatchObject({ ok: true }); // per key
    // Next hour window: room again in the hourly window; the daily window holds 2 + 2 = 4.
    expect(await store.take("capture", "k", t0 + H, rules)).toMatchObject({ ok: true });
    expect(await store.take("capture", "k", t0 + H + 1, rules)).toMatchObject({ ok: true });
    const daily = await store.take("capture", "k", t0 + 2 * H, rules);
    expect(daily.ok).toBe(false);
    expect(daily.retryAfterSec).toBe(Math.ceil((Date.parse("2026-10-18T00:00:00Z") - (t0 + 2 * H)) / 1000));
    const docs = db.docs(COLLECTIONS.rateLimits);
    const hourly = docs.find((d) => d.id === `capture_k_3600s_${Math.floor(t0 / H)}`)!;
    expect(hourly.data.count).toBe(2); // the refused third hit was not counted
    expect((hourly.data.expiresAt as FakeTimestamp).toMillis()).toBe((Math.floor(t0 / H) + 1) * H);
    for (const d of docs) expect(d.data.expiresAt).toBeInstanceOf(FakeTimestamp);
  });

  it("rejects keys that are not salted hashes", async () => {
    const store = new FirestoreRateLimitStore(async () => new FakeFirestore());
    await expect(store.take("capture", "203.0.113.5/x", t0, RATE_LIMITS.capture)).rejects.toThrow(/invalid/);
  });
});

describe("takeRateFor with a durable store", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    setRateLimitStore(undefined);
    setRateLimitOverride(undefined);
    resetPrivacyState();
  });
  const req = () => new Request("http://x/", { headers: { "x-forwarded-for": "203.0.113.50" } });

  it("uses Firestore when configured: limits survive a process restart (state reset)", async () => {
    // The salt must be stable across restarts (GIFTFIT_IP_HASH_SALT or the URL signing secret).
    vi.stubEnv("GIFTFIT_IP_HASH_SALT", "stable-salt-0123456789abcdef");
    const db = new FakeFirestore();
    setRateLimitOverride(true);
    setRateLimitStore(new FirestoreRateLimitStore(async () => db));
    const now = Date.parse("2026-10-17T10:00:00Z");
    for (let i = 0; i < 8; i++) expect((await takeRateFor(req(), "swatch", now + i)).ok).toBe(true);
    resetPrivacyState(); // cold start: in-memory windows gone
    setRateLimitOverride(true);
    setRateLimitStore(new FirestoreRateLimitStore(async () => db));
    expect(await takeRateFor(req(), "swatch", now + 100)).toMatchObject({ ok: false });
    expect(rateKeysForTests()).toEqual([]); // nothing in memory
    expect(JSON.stringify(db.docs(COLLECTIONS.rateLimits))).not.toMatch(/203\.0\.113\.50/);
  });

  it("falls back to the in-memory limiter when Firestore is unavailable (never unlimited)", async () => {
    const db = new FakeFirestore();
    db.failing = true;
    setRateLimitOverride(true);
    setRateLimitStore(new FirestoreRateLimitStore(async () => db));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const now = Date.parse("2026-10-17T10:00:00Z");
    expect((await takeRateFor(req(), "capture", now)).ok).toBe(true);
    expect((await takeRateFor(req(), "capture", now + 1)).ok).toBe(true);
    expect((await takeRateFor(req(), "capture", now + 2)).ok).toBe(false);
    expect(err).toHaveBeenCalled();
    expect(rateKeysForTests()).toHaveLength(1);
  });
});

describe("FirestoreAuditSink", () => {
  it("writes counts and decisions only (no cache key, primitive detail), kept 30 days", async () => {
    const db = new FakeFirestore();
    const sink = new FirestoreAuditSink(async () => db);
    const ts = "2026-10-17T10:00:00.000Z";
    await sink.write({ ts, event: "youcam.attempt", mode: "real", feature: "skin-tone-analysis", decision: "allowed", unitsExpected: 20, balanceBefore: 900, runUnits: 20, cacheKey: "a".repeat(64), detail: { message: "ok", nested: { x: 1 }, n: 3 } });
    await sink.write({ ts, event: "youcam.outcome", mode: "real", status: "success", unitsCharged: 20, taskId: "task-1" });
    const docs = db.docs(COLLECTIONS.audit);
    expect(docs).toHaveLength(2);
    const first = docs.find((d) => d.data.event === "youcam.attempt")!.data;
    expect(first).toMatchObject({ feature: "skin-tone-analysis", decision: "allowed", unitsExpected: 20, balanceBefore: 900, detail: { message: "ok", n: 3 } });
    expect(first).not.toHaveProperty("cacheKey");
    expect(first.detail).not.toHaveProperty("nested");
    expect((first.expiresAt as FakeTimestamp).toMillis() - Date.parse(ts)).toBe(AUDIT_RETENTION_MS);
    expect((first.ts as FakeTimestamp).toMillis()).toBe(Date.parse(ts));
    expect(firestoreAuditDoc({ ts: "bad", event: "youcam.purge", mode: "mock" }).ts).toBeInstanceOf(Date);
  });
});

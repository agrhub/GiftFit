/**
 * One contract suite for every PrivacyRepos adapter (A11): MemoryPrivacyRepos and FirestorePrivacyRepos
 * on the in-process Firestore fake must behave the same. Firestore-only checks (TTL field, cold start,
 * no composite index) follow.
 */
import { describe, expect, it } from "vitest";
import { FakeFirestore, FakeTimestamp } from "@/lib/store/__tests__/fake-firestore";
import { COLLECTIONS } from "@/lib/store/firestore-types";
import { FirestorePrivacyRepos } from "../repos/firestore";
import { MemoryPrivacyRepos } from "../repos/memory";
import type { NewFitRequest, PrivacyRepos } from "../repos/types";
import { FIT_REQUEST_TTL_MS, newFitRequestTokens } from "../tokens";

const T0 = new Date("2026-10-20T12:00:00.000Z");

type Factory = { name: string; make: () => { repos: PrivacyRepos; clock: { now: Date } } };

const factories: Factory[] = [
  {
    name: "MemoryPrivacyRepos",
    make: () => {
      const clock = { now: new Date(T0) };
      return { repos: new MemoryPrivacyRepos(() => new Date(clock.now)), clock };
    },
  },
  {
    name: "FirestorePrivacyRepos (fake)",
    make: () => {
      const clock = { now: new Date(T0) };
      return { repos: new FirestorePrivacyRepos(new FakeFirestore(), () => new Date(clock.now)), clock };
    },
  },
];

function input(over: Partial<NewFitRequest> = {}): NewFitRequest & { tokens: ReturnType<typeof newFitRequestTokens> } {
  const tokens = newFitRequestTokens();
  return {
    storeId: null,
    giverTokenHash: tokens.giverTokenHash,
    recipientTokenHash: tokens.recipientTokenHash,
    occasion: "birthday",
    budgetMin: 50,
    budgetMax: 300,
    currency: "USD",
    shortlistIds: ["a", "b"],
    decoyIds: ["c"],
    ...over,
    tokens,
  };
}

const create = async (repos: PrivacyRepos, over: Partial<NewFitRequest> = {}) => {
  const { tokens, ...i } = input(over);
  return { rec: await repos.fitRequests.create(i), tokens };
};

describe.each(factories)("PrivacyRepos contract: $name", ({ make }) => {
  it("creates requests with defaults and finds them by id and by either token hash", async () => {
    const { repos } = make();
    const { rec, tokens } = await create(repos, { metalLock: [] });
    expect(rec).toMatchObject({ status: "created", createdAt: T0, metalLock: null, photoDeletedAt: null });
    expect(rec.expiresAt.getTime() - T0.getTime()).toBe(FIT_REQUEST_TTL_MS);
    expect(await repos.fitRequests.findById(rec.id)).toEqual(rec);
    expect(await repos.fitRequests.findByRecipientTokenHash(tokens.recipientTokenHash)).toEqual(rec);
    expect(await repos.fitRequests.findByGiverTokenHash(tokens.giverTokenHash)).toEqual(rec);
    // A giver hash never opens the recipient side and vice versa.
    expect(await repos.fitRequests.findByRecipientTokenHash(tokens.giverTokenHash)).toBeUndefined();
    expect(await repos.fitRequests.findByGiverTokenHash(tokens.recipientTokenHash)).toBeUndefined();
    expect(await repos.fitRequests.findById("nope")).toBeUndefined();
  });

  it("keeps explicit id, status, dates, metal lock and the demo flag; returns copies", async () => {
    const { repos } = make();
    const exp = new Date(T0.getTime() + 5_000);
    const { rec } = await create(repos, { id: "req-explicit", status: "tried_on", expiresAt: exp, metalLock: ["gold", "silver"] as never, demo: true });
    expect(rec).toMatchObject({ id: "req-explicit", status: "tried_on", expiresAt: exp, metalLock: ["gold", "silver"], demo: true });
    const found = (await repos.fitRequests.findById("req-explicit"))!;
    expect(found.demo).toBe(true);
    found.shortlistIds.push("mutated");
    expect((await repos.fitRequests.findById("req-explicit"))!.shortlistIds).toEqual(["a", "b"]);
    const { rec: plain } = await create(repos);
    expect((await repos.fitRequests.findById(plain.id))!.demo).toBeFalsy();
  });

  it("sets status and photo_deleted_at; unknown ids are a no-op", async () => {
    const { repos } = make();
    const { rec } = await create(repos);
    await repos.fitRequests.setStatus(rec.id, "consented");
    const at = new Date(T0.getTime() + 1000);
    await repos.fitRequests.setPhotoDeletedAt(rec.id, at);
    expect(await repos.fitRequests.findById(rec.id)).toMatchObject({ status: "consented", photoDeletedAt: at });
    await repos.fitRequests.setPhotoDeletedAt(rec.id, null);
    expect((await repos.fitRequests.findById(rec.id))!.photoDeletedAt).toBeNull();
    await expect(repos.fitRequests.setStatus("missing", "deleted")).resolves.toBeUndefined();
    await expect(repos.fitRequests.setPhotoDeletedAt("missing", at)).resolves.toBeUndefined();
    expect(await repos.fitRequests.findById("missing")).toBeUndefined();
  });

  it("lists requests past expiry that are not closed (demo included)", async () => {
    const { repos } = make();
    const past = new Date(T0.getTime() - 1);
    const a = (await create(repos, { expiresAt: past })).rec;
    const b = (await create(repos, { expiresAt: past, demo: true })).rec;
    const c = (await create(repos, { expiresAt: past })).rec;
    await repos.fitRequests.setStatus(c.id, "deleted");
    const d = (await create(repos, { expiresAt: past, status: "expired" })).rec;
    await create(repos); // not expired
    const exactly = (await create(repos, { expiresAt: T0 })).rec;
    const ids = await repos.fitRequests.listExpired(T0);
    expect(ids.sort()).toEqual([a.id, b.id, exactly.id].sort());
    expect(ids).not.toContain(d.id);
  });

  it("upserts profiles and sets the undertone override only when a profile exists", async () => {
    const { repos } = make();
    const { rec } = await create(repos);
    expect(await repos.profiles.get(rec.id)).toBeUndefined();
    expect(await repos.profiles.setOverride(rec.id, "cool")).toBe(false);
    const profile = {
      fitRequestId: rec.id,
      undertoneEstimate: "warm" as const,
      undertoneConfidence: 0.7,
      undertoneOverride: null,
      faceShape: "Oval" as const,
      hasHandCapture: false,
      consentAt: T0,
      expiresAt: rec.expiresAt,
    };
    await repos.profiles.upsert(profile);
    expect(await repos.profiles.get(rec.id)).toEqual(profile);
    expect(await repos.profiles.setOverride(rec.id, "cool")).toBe(true);
    expect((await repos.profiles.get(rec.id))!.undertoneOverride).toBe("cool");
    await repos.profiles.upsert({ ...profile, hasHandCapture: true, consentAt: null });
    expect(await repos.profiles.get(rec.id)).toMatchObject({ hasHandCapture: true, consentAt: null, undertoneOverride: null });
  });

  it("upserts try-ons by (fitRequestId, cacheKey), keeping the first row id", async () => {
    const { repos } = make();
    const { rec } = await create(repos);
    const { rec: other } = await create(repos);
    const row = { fitRequestId: rec.id, catalogId: "a", feature: "2d-vto/earring", taskId: "t1", cacheKey: "k1", resultRef: "store:x", status: "success", unitsCharged: 1, expiresAt: new Date(T0.getTime() + 3600_000) };
    const first = await repos.tryons.insert(row);
    expect(first.id).toBeTruthy();
    const again = await repos.tryons.insert({ ...row, id: "ignored", taskId: "t2", status: "error" });
    expect(again.id).toBe(first.id);
    expect(await repos.tryons.get(first.id)).toEqual({ ...row, id: first.id, taskId: "t2", status: "error" });
    const analysis = await repos.tryons.insert({ ...row, id: "fixed-id", catalogId: null, feature: "skin-tone-analysis", cacheKey: "k2", resultRef: null });
    expect(analysis.id).toBe("fixed-id");
    await repos.tryons.insert({ ...row, fitRequestId: other.id }); // same cache key, other request: separate row
    expect((await repos.tryons.listForRequest(rec.id)).map((t) => t.id).sort()).toEqual([first.id, "fixed-id"].sort());
    expect(await repos.tryons.listForRequest(other.id)).toHaveLength(1);
    expect(await repos.tryons.get("nope")).toBeUndefined();
  });

  it("stores hearts uniquely (design or variant) and lists rows in lib/fit's convention with wishes", async () => {
    const { repos } = make();
    const { rec } = await create(repos);
    await repos.hearts.add(rec.id, "d1");
    await repos.hearts.add(rec.id, { catalogId: "d2", variantId: "d2:gold" });
    await repos.hearts.add(rec.id, "d1"); // duplicate
    await repos.hearts.add(rec.id, { catalogId: "d1", variantId: "d1:silver" }); // same design, other variant: new row
    await repos.hearts.add(rec.id, { catalogId: "d2", variantId: "d2:gold" }); // duplicate
    await repos.wishes.add(rec.id, "d3");
    await repos.wishes.add(rec.id, "d3");
    expect(await repos.hearts.entries(rec.id)).toEqual([
      { fitRequestId: rec.id, catalogId: "d1", variantId: null },
      { fitRequestId: rec.id, catalogId: "d2", variantId: "d2:gold" },
      { fitRequestId: rec.id, catalogId: "d1", variantId: "d1:silver" },
    ]);
    expect(await repos.hearts.list(rec.id)).toEqual(["d1", "d2:gold", "d1:silver", "wish:d3"]);
    expect(await repos.wishes.list(rec.id)).toEqual(["d3"]);

    await repos.hearts.set(rec.id, [{ catalogId: "d4", variantId: "d4:rose" }, "d1", "d1"]);
    expect(await repos.hearts.list(rec.id)).toEqual(["d4:rose", "d1", "wish:d3"]); // wishes untouched
    await repos.hearts.set(rec.id, []);
    expect(await repos.hearts.list(rec.id)).toEqual(["wish:d3"]);
    expect(await repos.hearts.list("other")).toEqual([]);
  });

  it("stores reports of any JSON shape", async () => {
    const { repos } = make();
    const { rec } = await create(repos);
    expect(await repos.reports.get(rec.id)).toBeUndefined();
    const report = { fitRequestId: rec.id, items: { fingerprint: "fp", items: [{ skuId: "a", score: 91, reasons: [["nested"]] }] }, weights: { tone: 0.5 }, model: null };
    await repos.reports.upsert(report);
    expect(await repos.reports.get(rec.id)).toEqual(report);
    await repos.reports.upsert({ fitRequestId: rec.id, items: [{ catalogId: "b", score: 80 }] });
    expect(await repos.reports.get(rec.id)).toEqual({ fitRequestId: rec.id, items: [{ catalogId: "b", score: 80 }] });
  });

  it("deletes every recipient row of one request, returns the counts, and leaves other requests alone", async () => {
    const { repos } = make();
    const { rec } = await create(repos);
    const { rec: other } = await create(repos);
    for (const id of [rec.id, other.id]) {
      await repos.profiles.upsert({ fitRequestId: id, undertoneEstimate: "cool", undertoneConfidence: 0.5, undertoneOverride: null, faceShape: "Round", hasHandCapture: false, consentAt: T0, expiresAt: rec.expiresAt });
      for (const k of ["k1", "k2", "k3"]) {
        await repos.tryons.insert({ fitRequestId: id, catalogId: "a", feature: "2d-vto/ring", taskId: null, cacheKey: k, resultRef: null, status: "success", unitsCharged: 0, expiresAt: rec.expiresAt });
      }
      await repos.hearts.add(id, "a");
      await repos.hearts.add(id, { catalogId: "b", variantId: "b:gold" });
      await repos.wishes.add(id, "c");
      await repos.reports.upsert({ fitRequestId: id, items: [] });
    }
    const full = { recipient_profiles: 1, tryons: 3, hearts: 2, metal_wishes: 1, fit_reports: 1 };
    const zero = { recipient_profiles: 0, tryons: 0, hearts: 0, metal_wishes: 0, fit_reports: 0 };
    expect(await repos.countForRequest(rec.id)).toEqual(full);
    expect(await repos.deleteRecipientData(rec.id)).toEqual(full);
    expect(await repos.countForRequest(rec.id)).toEqual(zero);
    expect(await repos.deleteRecipientData(rec.id)).toEqual(zero); // idempotent
    expect(await repos.countForRequest(other.id)).toEqual(full);
    expect(await repos.fitRequests.findById(rec.id)).toBeDefined(); // the giver's request itself stays
    expect(await repos.hearts.list(rec.id)).toEqual([]);
    expect(await repos.profiles.get(rec.id)).toBeUndefined();
    expect(await repos.reports.get(rec.id)).toBeUndefined();
  });
});

describe("FirestorePrivacyRepos specifics", () => {
  async function seeded() {
    const db = new FakeFirestore();
    const repos = new FirestorePrivacyRepos(db, () => new Date(T0));
    const { rec, tokens } = await create(repos, { metalLock: ["gold"] as never });
    await repos.profiles.upsert({ fitRequestId: rec.id, undertoneEstimate: "warm", undertoneConfidence: 0.6, undertoneOverride: null, faceShape: "Oval", hasHandCapture: true, consentAt: T0, expiresAt: rec.expiresAt });
    const tryonExp = new Date(T0.getTime() + 3600_000);
    await repos.tryons.insert({ fitRequestId: rec.id, catalogId: "a", feature: "2d-vto/earring", taskId: "t", cacheKey: "k", resultRef: "store:tryon/x", status: "success", unitsCharged: 1, expiresAt: tryonExp });
    await repos.hearts.add(rec.id, "a");
    await repos.wishes.add(rec.id, "b");
    await repos.reports.upsert({ fitRequestId: rec.id, items: [{ catalogId: "a", score: 90 }] });
    return { db, repos, rec, tokens, tryonExp };
  }

  it("writes expiresAt as a Timestamp on every document (request expiry, tryons their own)", async () => {
    const { db, rec, tryonExp } = await seeded();
    const collections = [COLLECTIONS.fitRequests, COLLECTIONS.profiles, COLLECTIONS.tryons, COLLECTIONS.hearts, COLLECTIONS.wishes, COLLECTIONS.reports];
    for (const c of collections) {
      const docs = db.docs(c);
      expect(docs.length, c).toBeGreaterThan(0);
      for (const d of docs) {
        expect(d.data.expiresAt, c).toBeInstanceOf(FakeTimestamp);
        const want = c === COLLECTIONS.tryons ? tryonExp : rec.expiresAt;
        expect((d.data.expiresAt as FakeTimestamp).toMillis(), c).toBe(want.getTime());
      }
    }
    expect(db.docs(COLLECTIONS.fitRequests)[0].data).toMatchObject({ demo: false, metalLock: ["gold"] });
  });

  it("survives a cold start: a new repos instance on the same database sees everything", async () => {
    const { db, rec, tokens } = await seeded();
    const fresh = new FirestorePrivacyRepos(db);
    expect(await fresh.fitRequests.findByRecipientTokenHash(tokens.recipientTokenHash)).toEqual(await new FirestorePrivacyRepos(db).fitRequests.findById(rec.id));
    expect(await fresh.hearts.list(rec.id)).toEqual(["a", "wish:b"]);
    expect(await fresh.countForRequest(rec.id)).toEqual({ recipient_profiles: 1, tryons: 1, hearts: 1, metal_wishes: 1, fit_reports: 1 });
  });

  it("uses only single-field queries (no composite index needed)", async () => {
    const db = new FakeFirestore();
    const repos = new FirestorePrivacyRepos(db, () => new Date(T0));
    const { rec, tokens } = await create(repos);
    await repos.fitRequests.findByRecipientTokenHash(tokens.recipientTokenHash);
    await repos.tryons.insert({ fitRequestId: rec.id, catalogId: null, feature: "skin-tone-analysis", taskId: null, cacheKey: "k", resultRef: null, status: "success", unitsCharged: 0, expiresAt: rec.expiresAt });
    await repos.hearts.set(rec.id, ["a"]);
    await repos.hearts.list(rec.id);
    await repos.fitRequests.listExpired(T0);
    await repos.deleteRecipientData(rec.id);
    await repos.listForMetrics();
    expect(db.queryLog.length).toBeGreaterThan(5);
    for (const q of db.queryLog) expect(new Set(q.fields).size, `${q.collection}: ${q.fields.join(",")}`).toBeLessThanOrEqual(1);
  });

  it("lists only non-demo requests for metrics, with hearts, profile and report", async () => {
    const { repos, rec } = await seeded();
    await create(repos, { demo: true });
    const rows = await repos.listForMetrics();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ request: { id: rec.id }, hearted: ["a"], profile: { undertoneEstimate: "warm" }, reportItems: [{ catalogId: "a", score: 90 }] });
  });

  it("rejects ids that would address another document path", async () => {
    const repos = new FirestorePrivacyRepos(new FakeFirestore());
    await expect(repos.fitRequests.findById("a/b")).rejects.toThrow(/invalid document id/);
    expect(await repos.tryons.get("../x")).toBeUndefined();
  });
});

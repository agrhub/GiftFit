import { describe, expect, it } from "vitest";
import type { CatalogSku, Metal, Undertone } from "@/server/contracts/giftfit";
import { portfolioReturnRisk } from "@/server/fit/returnRisk";
import { findGiverLeaks } from "@/server/privacy/giver-guard";
import { MemoryPrivacyRepos } from "@/server/privacy/repos/memory";
import { newFitRequestTokens } from "@/server/privacy/tokens";
import { DEFAULT_STORE, findStore, matchProduct } from "../catalog";
import { buildRetailerSnapshot, SYNTHETIC_LABEL } from "../console";
import { computeCoverage, recommendedMetals, skusToReach } from "../coverage";
import { cohortMix, computeFunnel, computeHeartedToBought, purchasedScores, toneMix } from "../funnel";
import { MemoryPurchaseLog } from "../purchases";
import { readRealFacts, reportScores } from "../real";
import { generateSyntheticFacts } from "../synthetic";
import type { RequestFact } from "../types";

const sku = (id: string, category: CatalogSku["category"], metal: Metal) => ({ id, category, attributes: { metal } });

const fact = (over: Partial<RequestFact> = {}): RequestFact => ({
  source: "real",
  status: "created",
  createdAt: new Date("2026-10-10T00:00:00Z"),
  opened: false,
  completed: false,
  shortlistIds: ["a", "b"],
  heartedShortlistIds: [],
  purchasedSkuIds: [],
  purchasedScores: [],
  ...over,
});

describe("Undertone Coverage", () => {
  it("counts SKUs whose metal is recommended per tone, with a gap callout", () => {
    const cov = computeCoverage([
      sku("1", "earring", "yellow_gold"),
      sku("2", "earring", "silver"),
      sku("3", "watch", "yellow_gold"),
      sku("4", "watch", "rose_gold"),
      sku("5", "watch", "mixed_two_tone"),
    ]);
    expect(cov.total).toBe(5);
    expect(cov.byTone.warm.count).toBe(3);
    expect(cov.byTone.cool.count).toBe(1);
    expect(cov.byTone.neutral.count).toBe(5); // every metal is recommended for neutral
    expect(cov.gap).toMatchObject({ tone: "cool", category: "watch", categoryCount: 0, categoryTotal: 3, toAdd: 3 });
    expect(cov.gap?.metals).toEqual(["white_gold", "silver", "platinum"]);
  });

  it("matches the Aurum catalog numbers reported in A6.md", () => {
    const cov = computeCoverage(DEFAULT_STORE.skus);
    expect(cov.total).toBe(161);
    expect([cov.byTone.warm.count, cov.byTone.neutral.count, cov.byTone.cool.count]).toEqual([77, 161, 60]);
    expect(cov.gap).toMatchObject({ tone: "cool", category: "watch", categoryCount: 7, categoryTotal: 24, toAdd: 10 });
  });

  it("skusToReach is the smallest n reaching the target", () => {
    expect(skusToReach(7, 24, 0.5)).toBe(10);
    expect((7 + 10) / (24 + 10)).toBeGreaterThanOrEqual(0.5);
    expect((7 + 9) / (24 + 9)).toBeLessThan(0.5);
    expect(skusToReach(5, 10, 0.5)).toBe(0);
    expect(recommendedMetals("warm")).toEqual(["yellow_gold", "rose_gold"]);
  });
});

describe("funnel and hearted→bought", () => {
  const facts = [
    fact(),
    fact({ status: "expired" }),
    fact({ status: "deleted", opened: true }),
    fact({ status: "opened", opened: true }),
    fact({ status: "completed", opened: true, completed: true, heartedShortlistIds: ["a"], purchasedSkuIds: ["a"], purchasedScores: [94] }),
    fact({ status: "completed", opened: true, completed: true, heartedShortlistIds: ["a"], purchasedSkuIds: ["b"], purchasedScores: [60] }),
    fact({ status: "completed", opened: true, completed: true, heartedShortlistIds: ["b"] }),
    fact({ status: "completed", opened: true, completed: true }),
  ];

  it("stages and rates", () => {
    const f = computeFunnel(facts);
    expect(f.stages.map((s) => s.count)).toEqual([8, 6, 4, 2]);
    expect(f.stages[2].stepRate?.value).toBeCloseTo(4 / 6);
    expect(f.stages[3].overallRate.value).toBeCloseTo(2 / 8);
    expect(f.closedUnknown).toBe(1);
  });

  it("purchase without completion does not count as purchased", () => {
    expect(computeFunnel([fact({ opened: true, purchasedSkuIds: ["a"] })]).stages[3].count).toBe(0);
  });

  it("hearted→bought", () => {
    const h = computeHeartedToBought(facts);
    expect(h.requestRate).toEqual({ numerator: 1, denominator: 3, value: 1 / 3 });
    expect(h.boughtWereHearted).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
    expect(purchasedScores(facts)).toEqual([94, 60]);
  });

  it("empty input gives null rates, not NaN", () => {
    const f = computeFunnel([]);
    expect(f.stages[1].stepRate?.value).toBeNull();
    expect(computeHeartedToBought([]).requestRate.value).toBeNull();
  });
});

describe("k-anonymous recipient mix", () => {
  const completed = (tone: Undertone) => fact({ status: "completed", opened: true, completed: true, tone });

  it("is suppressed below 5 completed requests", () => {
    const m = toneMix([completed("warm"), completed("cool"), completed("cool"), completed("warm")]);
    expect(m).toEqual({ cohort: 4, suppressed: true, cells: [] });
  });

  it("hides cells below 5, and a second cell when one hidden cell could be derived", () => {
    const facts = [...Array(9)].map(() => completed("warm")).concat([...Array(6)].map(() => completed("neutral")), [completed("cool")]);
    const m = toneMix(facts);
    expect(m.cohort).toBe(16);
    expect(m.cells.find((c) => c.key === "cool")?.count).toBeNull();
    expect(m.cells.find((c) => c.key === "neutral")?.count).toBeNull();
    expect(m.cells.find((c) => c.key === "warm")?.count).toBe(9);
  });

  it("only counts completed requests", () => {
    const m = cohortMix([...Array(6)].map(() => fact({ tone: "warm", opened: true })), ["warm"], (f) => f.tone);
    expect(m.suppressed).toBe(true);
  });
});

describe("synthetic demo data", () => {
  it("is deterministic and labelled", () => {
    const a = generateSyntheticFacts(DEFAULT_STORE.skus, { count: 50 });
    const b = generateSyntheticFacts(DEFAULT_STORE.skus, { count: 50 });
    expect(a).toEqual(b);
    expect(a.every((f) => f.source === "synthetic")).toBe(true);
    expect(generateSyntheticFacts(DEFAULT_STORE.skus, { count: 50, seed: "other" })).not.toEqual(a);
  });

  it("is internally consistent", () => {
    const facts = generateSyntheticFacts(DEFAULT_STORE.skus);
    for (const f of facts) {
      if (f.completed) expect(f.opened).toBe(true);
      if (f.purchasedSkuIds.length) expect(f.completed).toBe(true);
      for (const id of [...f.heartedShortlistIds, ...f.purchasedSkuIds]) expect(f.shortlistIds).toContain(id);
      expect(f.purchasedScores.length).toBe(f.purchasedSkuIds.length);
      for (const s of f.purchasedScores) expect(s).toBeGreaterThanOrEqual(0);
    }
    const stages = computeFunnel(facts).stages.map((s) => s.count);
    expect(stages).toEqual([240, 192, 135, 71]);
    const rr = portfolioReturnRisk(purchasedScores(facts));
    expect(rr.after.rate).toBeLessThan(rr.before.rate);
  });
});

describe("catalog lookup", () => {
  it("matches by SKU code, slug, id, URL path and exact name", () => {
    const store = findStore("aurum")!;
    const halo = matchProduct(store, { sku: "AUR-EAR-028" })!;
    expect(halo.title).toBe("Halo Drop Earrings");
    expect(matchProduct(store, { sku: "aur-ear-028" })?.id).toBe(halo.id);
    expect(matchProduct(store, { sku: halo.id })?.id).toBe(halo.id);
    expect(matchProduct(store, { url: "https://shop.example/products/halo-drop-earrings?x=1" })?.id).toBe(halo.id);
    expect(matchProduct(store, { name: "  halo drop  EARRINGS " })?.id).toBe(halo.id);
    expect(matchProduct(store, { sku: "NOPE-1", url: "/p/unknown", name: "Something else" })).toBeUndefined();
    expect(findStore(store.id)).toBe(store);
    expect(findStore("elsewhere")).toBeUndefined();
  });
});

describe("real requests from the single store", () => {
  it("reads statuses, hearts, purchases and report scores from MemoryPrivacyRepos", async () => {
    const repos = new MemoryPrivacyRepos(() => new Date("2026-10-20T00:00:00Z"));
    const t = newFitRequestTokens();
    const [a, b, c] = DEFAULT_STORE.skus.map((s) => s.id);
    const req = await repos.fitRequests.create({
      storeId: null,
      giverTokenHash: t.giverTokenHash,
      recipientTokenHash: t.recipientTokenHash,
      occasion: "anniversary",
      budgetMin: 100,
      budgetMax: 300,
      currency: "USD",
      shortlistIds: [a, b],
      decoyIds: [c],
    });
    await repos.fitRequests.setStatus(req.id, "completed");
    await repos.hearts.set(req.id, [a, c]);
    await repos.profiles.upsert({
      fitRequestId: req.id,
      undertoneEstimate: "warm",
      undertoneConfidence: 0.8,
      undertoneOverride: "cool",
      faceShape: "Oval",
      hasHandCapture: false,
      consentAt: new Date(),
      expiresAt: req.expiresAt,
    });
    await repos.reports.upsert({ fitRequestId: req.id, items: { fingerprint: "x", items: [{ skuId: a, score: 92 }, { skuId: b, score: 55 }] } });
    const log = new MemoryPurchaseLog();
    log.record(req.id, [a, c]); // c is a decoy: ignored by the facts
    const other = await repos.fitRequests.create({ ...req, id: undefined, storeId: "elsewhere", giverTokenHash: "g2", recipientTokenHash: "r2" });

    const facts = await readRealFacts(repos, log, { storeId: DEFAULT_STORE.id, isDefaultStore: true });
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ source: "real", completed: true, opened: true, heartedShortlistIds: [a], purchasedSkuIds: [a], purchasedScores: [92], tone: "cool", shape: "Oval" });
    expect(other.storeId).toBe("elsewhere");
  });

  it("reportScores accepts both stored shapes", () => {
    expect([...reportScores({ fingerprint: "f", items: [{ skuId: "x", score: 70 }] })]).toEqual([["x", 70]]);
    expect([...reportScores([{ catalogId: "y", score: 94 }])]).toEqual([["y", 94]]);
    expect(reportScores(null).size).toBe(0);
  });
});

describe("console snapshot", () => {
  it("labels synthetic data, keeps real numbers separate and passes the leak scanner", async () => {
    const repos = new MemoryPrivacyRepos();
    const t = newFitRequestTokens();
    const req = await repos.fitRequests.create({
      storeId: DEFAULT_STORE.id,
      giverTokenHash: t.giverTokenHash,
      recipientTokenHash: t.recipientTokenHash,
      occasion: "birthday",
      budgetMin: 0,
      budgetMax: 150,
      currency: "USD",
      shortlistIds: [DEFAULT_STORE.skus[0].id],
      decoyIds: [],
    });
    const snap = await buildRetailerSnapshot({ repos, purchases: new MemoryPurchaseLog(), now: () => new Date("2026-10-20T00:00:00Z") });
    expect(snap.syntheticLabel).toBe(SYNTHETIC_LABEL);
    expect(snap.includesSynthetic).toBe(true);
    expect(snap.sources).toEqual({ real: 1, synthetic: 240 });
    expect(snap.real.funnel.stages[0].count).toBe(1);
    expect(snap.combined.funnel.stages[0].count).toBe(241);
    // One real request is below the cohort minimum: no breakdown.
    expect(snap.real.mix.tone.suppressed).toBe(true);
    expect(findGiverLeaks(snap)).toEqual([]);
    const text = JSON.stringify(snap);
    expect(text).not.toContain(req.id);
    expect(text).not.toContain(t.giverTokenHash);
    expect(text).not.toMatch(/#[0-9a-f]{6}/i);

    const realOnly = await buildRetailerSnapshot({ repos, purchases: new MemoryPurchaseLog() }, { view: "real" });
    expect(realOnly.includesSynthetic).toBe(false);
    expect(realOnly.sources.synthetic).toBe(0);
    expect(realOnly.combined.funnel.stages[0].count).toBe(1);
  });
});

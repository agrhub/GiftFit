/**
 * "Help me choose" curation (ADR-045): coverage/diversity, determinism per seed, budget and metal-lock
 * eligibility, categories, style-hint bias, gender presentation, size rule, and no decoys.
 */
import { describe, expect, it } from "vitest";
import type { CatalogSku, JewelryCategory, Metal } from "@/server/contracts/giftfit";
import aurum from "@/fixtures/aurum/catalog.json";
import { type CurateBuckets, type CurateOptions, bucketsOf, coverageValue, curate, eligiblePool, inferGender, inferSide, silhouetteOf, styleFamilyOf } from "../curate";
import { genderOf } from "../decoys";
import { eligibleVariants } from "../variants";
import { fakeRules, makeCatalog, sku, withVariants } from "./fixtures";

const CATALOG = withVariants(makeCatalog(240, "curate"), 0.3, "curate-v");
const AURUM = aurum as unknown as CatalogSku[];
const base = (over: Partial<CurateOptions> = {}): CurateOptions => ({ seed: "seed-1", occasion: "birthday", request: { budgetMax: 400, currency: "USD" }, rules: fakeRules, ...over });
const bucketsOfPicks = (cat: readonly CatalogSku[], ids: readonly string[], opts: CurateOptions): CurateBuckets[] => {
  const pool = new Map(eligiblePool(cat, opts.request, opts.categories).map((p) => [p.sku.id, p]));
  return ids.map((id) => bucketsOf(pool.get(id)!.sku, pool.get(id)!.variant));
};

/** Independent plain greedy on the same weighted coverage objective (lexicographic tie-break). */
function plainGreedy(cat: readonly CatalogSku[], opts: CurateOptions, k: number): CurateBuckets[] {
  const pool = eligiblePool(cat, opts.request, opts.categories).map((p) => bucketsOf(p.sku, p.variant));
  const out: CurateBuckets[] = [];
  const named = Boolean(opts.categories?.length);
  while (out.length < k && pool.length) {
    let bi = 0;
    let bv = -1;
    pool.forEach((b, i) => {
      const v = coverageValue([...out, b], named);
      if (v > bv) [bi, bv] = [i, v];
    });
    out.push(pool.splice(bi, 1)[0]);
  }
  return out;
}

function combinations<T>(xs: readonly T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (xs.length < k) return [];
  const [h, ...t] = xs;
  return [...combinations(t, k - 1).map((c) => [h, ...c]), ...combinations(t, k)];
}

describe("buckets", () => {
  it("style family is the first STYLE_FAMILIES word; silhouettes are small per-category buckets", () => {
    expect(styleFamilyOf(sku("a", { attributes: { style: "minimal classic" } }))).toBe("minimal");
    expect(styleFamilyOf(sku("a", { attributes: { style: "Statement" } }))).toBe("statement");
    expect(styleFamilyOf(sku("a", { attributes: { style: "edgy" } }))).toBe("other");
    expect(silhouetteOf(sku("e", { attributes: { earring_shape: "hoop_oval_curved" } }))).toBe("hoop");
    expect(silhouetteOf(sku("e", { attributes: { earring_shape: "chandelier_short" } }))).toBe("chandelier");
    expect(silhouetteOf(sku("n", { category: "necklace", attributes: { category: "necklace", necklace_style: "collar_bib_horizontal" } }))).toBe("choker");
    expect(silhouetteOf(sku("n", { category: "necklace", attributes: { category: "necklace", necklace_style: "pendant_v_y", necklace_length_in: 30 } }))).toBe("long");
    expect(silhouetteOf(sku("r", { category: "ring", title: "Heritage Oval Signet Ring", attributes: { category: "ring", stone: "none" } }))).toBe("signet");
    expect(silhouetteOf(sku("r", { category: "ring", title: "Comfort Polished Band", attributes: { category: "ring", stone: "none" } }))).toBe("band");
    expect(silhouetteOf(sku("b", { category: "bracelet", title: "Atlas Open Cuff", attributes: { category: "bracelet" } }))).toBe("bangle");
    expect(silhouetteOf(sku("w", { category: "watch", attributes: { category: "watch", strap: "mesh" } }))).toBe("metal");
  });

  it("every Aurum design maps to a labelled silhouette", async () => {
    const { SILHOUETTE_LABEL } = await import("../curate");
    for (const s of AURUM) expect(SILHOUETTE_LABEL[`${s.category}/${silhouetteOf(s)}`], s.title).toBeTruthy();
  });
});

describe("coverage and diversity", () => {
  it("matches the brute-force optimum on a small fixture", () => {
    const cats: JewelryCategory[] = ["earring", "earring", "earring", "necklace", "necklace", "ring", "bracelet", "watch", "earring", "necklace", "ring", "earring"];
    const styles = ["minimal", "minimal", "classic", "classic", "boho", "minimal", "modern", "sport", "statement", "vintage", "classic", "minimal"];
    const metals: Metal[] = ["yellow_gold", "yellow_gold", "silver", "rose_gold", "yellow_gold", "white_gold", "silver", "silver", "yellow_gold", "rose_gold", "yellow_gold", "platinum"];
    const small = cats.map((c, i) => sku(`s${i}`, { category: c, price: 100 + i, attributes: { category: c, style: styles[i], metal: metals[i] } }));
    const opts = base({ target: 6, max: 6 });
    const got = coverageValue(bucketsOfPicks(small, curate(small, opts).ids, opts));
    const all = eligiblePool(small, opts.request).map((p) => bucketsOf(p.sku, p.variant));
    const best = Math.max(...combinations(all, 6).map((c) => coverageValue(c)));
    expect(got).toBe(best);
  });

  it.each(["seed-1", "seed-2", "seed-3", "seed-4"])("covers at least as much as an independent greedy (%s), on synthetic and Aurum catalogs", (seed) => {
    for (const cat of [CATALOG, AURUM]) {
      for (const over of [{}, { request: { budgetMax: 250, currency: "USD" } }, { categories: ["earring", "necklace"] as JewelryCategory[] }]) {
        const opts = base({ seed, ...over });
        const ours = coverageValue(bucketsOfPicks(cat, curate(cat, opts).ids, opts), Boolean(opts.categories));
        expect(ours).toBeGreaterThanOrEqual(coverageValue(plainGreedy(cat, opts, 6), Boolean(opts.categories)));
      }
    }
  });

  it("a 6-piece Aurum set spans ≥ 5 style families, ≥ 4 categories and ≥ 4 metals when nothing is restricted", () => {
    const opts = base({ request: { budgetMax: 400, currency: "USD" } });
    const b = bucketsOfPicks(AURUM, curate(AURUM, opts).ids, opts);
    expect(new Set(b.map((x) => x.style)).size).toBeGreaterThanOrEqual(5);
    expect(new Set(b.map((x) => x.category)).size).toBeGreaterThanOrEqual(4);
    expect(new Set(b.map((x) => x.metal)).size).toBeGreaterThanOrEqual(4);
    expect(new Set(b.map((x) => x.silhouette)).size).toBe(6);
  });

  it("every pick says why it was chosen (machine-readable buckets)", () => {
    const cur = curate(AURUM, base());
    expect(cur.picks[0].why).toEqual(expect.arrayContaining([expect.stringMatching(/^style:/), expect.stringMatching(/^category:/), expect.stringMatching(/^silhouette:/), expect.stringMatching(/^metal:/)]));
    for (const p of cur.picks) {
      expect(p.why.length).toBeGreaterThan(0);
      for (const w of p.why) expect(w).toMatch(/^(style|category|silhouette|metal|hint):[a-z_/]+$|^fill$|^extended$/);
    }
  });
});

describe("determinism", () => {
  it("the same seed gives the same set; different seeds explore different sets", () => {
    const a = curate(AURUM, base({ seed: "req-A" })).ids;
    expect(curate(AURUM, base({ seed: "req-A" })).ids).toEqual(a);
    expect(curate([...AURUM].reverse(), base({ seed: "req-A" })).ids).toEqual(a); // catalog order carries no signal
    const sets = new Set(Array.from({ length: 12 }, (_, i) => curate(AURUM, base({ seed: `req-${i}` })).ids.join(",")));
    expect(sets.size).toBeGreaterThan(3);
  });
});

describe("eligibility: budget cap and metal lock (ADR-032)", () => {
  it.each([
    [150, undefined],
    [300, ["yellow_gold", "rose_gold"] as Metal[]],
    [600, ["white_gold", "silver", "platinum"] as Metal[]],
  ])("cap %s, lock %j: every pick has an eligible variant and the offered variant obeys both", (cap, lock) => {
    for (const cat of [CATALOG, AURUM]) {
      const request = { budgetMax: cap, currency: "USD", ...(lock ? { metalLock: lock } : {}) };
      const cur = curate(cat, base({ request }));
      expect(cur.ids.length).toBeGreaterThanOrEqual(4);
      for (const p of cur.picks) {
        const s = cat.find((x) => x.id === p.catalogId)!;
        expect(eligibleVariants(s, request).length).toBeGreaterThan(0);
        expect(p.price).toBeLessThanOrEqual(cap);
        if (lock) expect(lock).toContain(p.metal);
      }
    }
  });

  it("never picks a design that is not try-on ready, or in another currency", () => {
    const cat = [...CATALOG.slice(0, 40), sku("eur", { currency: "EUR", price: 50 }), sku("novto", { price: 50, attributes: { vto_spec_ok: false } })];
    for (let i = 0; i < 10; i++) {
      const ids = curate(cat, base({ seed: `x${i}` })).ids;
      expect(ids).not.toContain("eur");
      expect(ids).not.toContain("novto");
    }
  });

  it("refuses (ok=false) when fewer than 4 designs are eligible", () => {
    const cur = curate(AURUM, base({ request: { budgetMax: 20, currency: "USD" } }));
    expect(cur.ok).toBe(false);
    expect(cur.reasons).toContain("INSUFFICIENT_CATALOG");
  });
});

describe("categories, style hints and size", () => {
  it("draws only from the named categories and represents each of them", () => {
    const cur = curate(AURUM, base({ categories: ["earring", "necklace", "watch"] }));
    const cats = cur.picks.map((p) => p.buckets.category);
    expect(new Set(cats)).toEqual(new Set(["earring", "necklace", "watch"]));
  });

  it("style hints bias the set (about half) but never exclude other families", () => {
    for (let i = 0; i < 8; i++) {
      const plain = curate(AURUM, base({ seed: `h${i}`, categories: ["earring", "necklace"] }));
      const hinted = curate(AURUM, base({ seed: `h${i}`, categories: ["earring", "necklace"], styleHints: ["minimal"] }));
      const count = (c: typeof plain) => c.picks.filter((p) => p.buckets.style === "minimal").length;
      expect(count(hinted)).toBeGreaterThanOrEqual(Math.max(2, count(plain)));
      expect(hinted.picks.some((p) => p.buckets.style !== "minimal")).toBe(true);
      expect(hinted.picks.some((p) => p.why.includes("hint:minimal"))).toBe(true);
    }
  });

  it("targets 6 and extends (≤ max) only to bring in a named category or hinted style still absent", () => {
    const plain = curate(AURUM, base());
    expect(plain.ids).toHaveLength(6);
    expect(plain.reasons).not.toContain("EXTENDED_FOR_COVERAGE");
    // Target 2 with 3 named categories: one extension brings in the third category.
    const ext = curate(AURUM, base({ target: 2, max: 4, categories: ["earring", "ring", "watch"] }));
    expect(ext.ids).toHaveLength(3);
    expect(ext.reasons).toContain("EXTENDED_FOR_COVERAGE");
    expect(ext.picks[2].why).toContain("extended");
    expect(new Set(ext.picks.map((p) => p.buckets.category)).size).toBe(3);
    // Never more than max, whatever is asked.
    const all = curate(AURUM, base({ categories: ["earring", "necklace", "ring", "bracelet", "watch"], styleHints: ["sport", "vintage", "boho"] }));
    expect(all.ids.length).toBeGreaterThanOrEqual(6);
    expect(all.ids.length).toBeLessThanOrEqual(8);
  });
});

describe("gender presentation (decoy parity rule)", () => {
  it("masculine → masculine or unisex only, exact matches favoured; feminine → never masculine", () => {
    for (let i = 0; i < 8; i++) {
      const m = curate(AURUM, base({ seed: `g${i}`, request: { budgetMax: 600, currency: "USD" }, genderPresentation: "masculine" }));
      const gs = m.ids.map((id) => genderOf(AURUM.find((s) => s.id === id)!));
      expect(gs).not.toContain("feminine");
      expect(gs.filter((g) => g === "masculine").length).toBeGreaterThanOrEqual(3);
      const f = curate(AURUM, base({ seed: `g${i}`, genderPresentation: "feminine" }));
      expect(f.ids.map((id) => genderOf(AURUM.find((s) => s.id === id)!))).not.toContain("masculine");
    }
  });

  it("relaxes only when the compatible pool cannot fill the set (GENDER_RELAXED)", () => {
    const tiny = [
      sku("m1", { attributes: { gender_presentation: "masculine", style: "minimal" } }),
      sku("m2", { category: "watch", attributes: { category: "watch", gender_presentation: "masculine", style: "sport" } }),
      ...Array.from({ length: 8 }, (_, i) => sku(`f${i}`, { attributes: { gender_presentation: "feminine", style: ["boho", "classic", "vintage", "modern"][i % 4] } })),
    ];
    const cur = curate(tiny, base({ genderPresentation: "masculine" }));
    expect(cur.reasons).toContain("GENDER_RELAXED");
    expect(cur.ids.slice(0, 2).sort()).toEqual(["m1", "m2"]); // compatible designs first
  });

  it('"any" presentation keeps one side plus unisex, never a mix (PRESENTATION_INFERRED)', () => {
    for (let i = 0; i < 12; i++) {
      const cur = curate(AURUM, base({ seed: `any${i}`, request: { budgetMax: 600, currency: "USD" } }));
      const gs = new Set(cur.ids.map((id) => genderOf(AURUM.find((s) => s.id === id)!)));
      expect(gs.has("feminine") && gs.has("masculine"), `seed any${i}`).toBe(false);
      expect(cur.reasons).toContain("PRESENTATION_INFERRED");
    }
    // A pool with more masculine designs picks the masculine side.
    const menHeavy = [
      ...Array.from({ length: 7 }, (_, i) => sku(`m${i}`, { attributes: { gender_presentation: "masculine", style: ["minimal", "sport", "classic", "modern"][i % 4] } })),
      ...Array.from({ length: 3 }, (_, i) => sku(`f${i}`, { attributes: { gender_presentation: "feminine", style: "boho" } })),
    ];
    expect(curate(menHeavy, base()).ids.every((id) => id.startsWith("m"))).toBe(true);
  });

  it("inferSide: majority side, seeded tie-break, undefined when all unisex", () => {
    expect(inferSide(["feminine", "feminine", "masculine", "unisex"], "s")).toBe("feminine");
    expect(inferSide(["masculine", "unisex"], "s")).toBe("masculine");
    expect(inferSide(["unisex", "unisex"], "s")).toBeUndefined();
    const tie = inferSide(["feminine", "masculine"], "s");
    expect(inferSide(["feminine", "masculine"], "s")).toBe(tie);
  });

  it("inferGender reads a set's presentation", () => {
    expect(inferGender([sku("a", { attributes: { gender_presentation: "masculine" } }), sku("b")])).toBe("masculine");
    expect(inferGender([sku("a", { attributes: { gender_presentation: "feminine" } }), sku("b", { attributes: { gender_presentation: "masculine" } })])).toBeUndefined();
  });
});

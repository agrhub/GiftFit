import { describe, expect, it } from "vitest";
import type { CatalogSku, MetalVariant } from "@/server/contracts/giftfit";
import {
  type CarouselItem,
  DECOY_DEFAULTS,
  HARD_DECOY_REASONS,
  buildCarousel,
  carouselOrder,
  selectDecoys,
  toCarouselItem,
} from "../decoys";
import { ATTACKERS, estimateGuessProbability, fixedCarouselLeaks } from "../guess";
import { seededRandom } from "../rng";
import { SWATCH_LABEL, eligibleVariants } from "../variants";
import { makeCatalog, sku, withVariants } from "./fixtures";

const SWATCH_LABELS = Object.values(SWATCH_LABEL);

const CATALOG = makeCatalog(200, "aurum-sim");
const READY = CATALOG.filter((s) => s.attributes.vto_spec_ok);

/** A dense catalog where every constraint can be met at tier 0. */
function denseCatalog(): CatalogSku[] {
  const out: CatalogSku[] = [];
  const ADJ = ["Halo", "Luna", "Iris", "Nova", "Sage", "Vega"];
  let n = 0;
  for (const metal of ["yellow_gold", "white_gold"] as const) {
    for (let price = 120; price <= 400; price += 5) {
      for (const category of ["earring", "necklace"] as const) {
        n++;
        out.push(
          sku(`d-${String(n).padStart(3, "0")}`, {
            title: `${ADJ[n % ADJ.length]} ${category === "earring" ? "Drop Earrings" : "Pendant Necklace"}`,
            category,
            price,
            attributes: {
              category,
              metal,
              metal_tone: metal === "yellow_gold" ? "warm" : "cool",
              style: n % 2 ? "minimal classic" : "classic",
            },
          }),
        );
      }
    }
  }
  return out;
}
const DENSE = denseCatalog();
/** Shortlist candidates away from the catalog's price edges (so both price sides have candidates). */
const DENSE_INTERIOR = DENSE.filter((s) => s.price >= 180 && s.price <= 320);

function randomShortlist(pool: CatalogSku[], size: number, seed: string): CatalogSku[] {
  const r = seededRandom(seed);
  const first = pool[Math.floor(r() * pool.length)];
  const near = pool.filter((s) => s.id !== first.id && Math.abs(s.price / first.price - 1) <= 0.5);
  const out = [first];
  while (out.length < size && near.length) out.push(near.splice(Math.floor(r() * near.length), 1)[0]);
  return out;
}

describe("selectDecoys: constraints", () => {
  it.each([1, 2, 3, 4])("fills a 6-item carousel with ≥ 2 decoys for a shortlist of %i", (size) => {
    for (let t = 0; t < 50; t++) {
      const shortlist = randomShortlist(READY, size, `c${size}-${t}`);
      const sel = selectDecoys(shortlist, CATALOG, { seed: `seed-${t}` });
      expect(sel.ok).toBe(true);
      expect(sel.decoyIds.length).toBeGreaterThanOrEqual(2);
      expect(sel.decoyIds.length).toBe(Math.max(2, 6 - size));
      expect(sel.carouselIds).toHaveLength(size + sel.decoyIds.length);
    }
  });

  it("never returns a shortlist item or a duplicate, and only try-on-ready SKUs", () => {
    for (let t = 0; t < 200; t++) {
      const shortlist = randomShortlist(READY, 1 + (t % 4), `n${t}`);
      const sel = selectDecoys(shortlist, CATALOG, { seed: `s${t}` });
      const ids = new Set(shortlist.map((s) => s.id));
      expect(sel.decoyIds.some((id) => ids.has(id))).toBe(false);
      expect(new Set(sel.decoyIds).size).toBe(sel.decoyIds.length);
      for (const id of sel.decoyIds) {
        const d = CATALOG.find((c) => c.id === id)!;
        expect(d.attributes.vto_spec_ok).toBe(true);
        expect(d.currency).toBe(shortlist[0].currency);
      }
    }
  });

  it("keeps same category and price within ±20% of the shadowed item at tiers 0–2", () => {
    let strict = 0;
    let all = 0;
    for (let t = 0; t < 300; t++) {
      const shortlist = randomShortlist(READY, 1 + (t % 4), `p${t}`);
      const sel = selectDecoys(shortlist, CATALOG, { seed: `q${t}` });
      for (const p of sel.picks) {
        all++;
        const s = shortlist.find((x) => x.id === p.shadowOf)!;
        const d = CATALOG.find((x) => x.id === p.decoyId)!;
        if (p.tier <= 2) {
          strict++;
          expect(d.category).toBe(s.category);
          expect(Math.abs(d.price / s.price - 1)).toBeLessThanOrEqual(DECOY_DEFAULTS.priceBand + 1e-9);
        } else {
          expect(sel.reasons).toContain(p.tier === 3 ? "PRICE_BAND_WIDENED" : "CATEGORY_RELAXED");
        }
      }
    }
    // On a sparse 200-SKU catalog, at least 90% of decoys still meet same-category ±20%.
    expect(strict / all).toBeGreaterThan(0.9);
  });

  it("meets tier 0 (same category, metal tone, similar style, ±20%) on a dense catalog with no hard relaxation", () => {
    for (let t = 0; t < 100; t++) {
      const shortlist = randomShortlist(DENSE_INTERIOR, 1 + (t % 4), `d${t}`);
      const sel = selectDecoys(shortlist, DENSE, { seed: `e${t}` });
      expect(sel.ok).toBe(true);
      expect(sel.reasons.filter((r) => HARD_DECOY_REASONS.has(r))).toEqual([]);
      for (const p of sel.picks) {
        const s = DENSE.find((x) => x.id === p.shadowOf)!;
        const d = DENSE.find((x) => x.id === p.decoyId)!;
        expect(p.tier).toBe(0);
        expect(d.attributes.metal_tone).toBe(s.attributes.metal_tone);
        expect(d.category).toBe(s.category);
      }
    }
  });

  it("is deterministic given a seed and varies across seeds", () => {
    const shortlist = randomShortlist(READY, 2, "det");
    const a = selectDecoys(shortlist, CATALOG, { seed: "same" });
    const b = selectDecoys(shortlist, CATALOG, { seed: "same" });
    expect(a).toEqual(b);
    const variants = new Set(Array.from({ length: 20 }, (_, i) => selectDecoys(shortlist, CATALOG, { seed: `v${i}` }).carouselIds.join(",")));
    expect(variants.size).toBeGreaterThan(10);
  });

  it("relaxes in documented tiers and reports why", () => {
    const s = sku("s", { price: 200, attributes: { style: "minimal", metal: "yellow_gold", metal_tone: "warm" } });
    const otherStyle = sku("o1", { price: 210, attributes: { style: "boho", earring_shape: "hoop_round_large" } });
    const otherMetal = sku("o2", { price: 190, attributes: { metal: "silver", metal_tone: "cool", style: "boho", earring_shape: "chandelier" } });
    const wider = sku("o3", { price: 260, attributes: { style: "boho", earring_shape: "chandelier" } });
    const necklace = sku("o4", { category: "necklace", price: 200, attributes: { category: "necklace" } });
    const sel = selectDecoys([s], [s, otherStyle, otherMetal, wider, necklace], { seed: "tiers" });
    expect(sel.picks.map((p) => [p.decoyId, p.tier]).sort()).toEqual([
      ["o1", 1],
      ["o2", 2],
      ["o3", 3],
      ["o4", 4],
    ]);
    expect(sel.reasons).toEqual(expect.arrayContaining(["STYLE_RELAXED", "METAL_RELAXED", "PRICE_BAND_WIDENED", "CATEGORY_RELAXED", "INSUFFICIENT_CATALOG"]));
    expect(sel.ok).toBe(false);
  });

  it("never silently returns fewer than 2 decoys", () => {
    const s = sku("s");
    for (const catalog of [[s], [s, sku("x", { price: 1000 })], [s, sku("y", { attributes: { vto_spec_ok: false } })], [s, sku("z", { currency: "EUR" })]]) {
      const sel = selectDecoys([s], catalog, { seed: "few" });
      expect(sel.decoyIds.length).toBe(0);
      expect(sel.ok).toBe(false);
      expect(sel.reasons).toContain("INSUFFICIENT_CATALOG");
    }
    const one = selectDecoys([s], [s, sku("ok", { price: 210 })], { seed: "one" });
    expect(one.decoyIds).toEqual(["ok"]);
    expect(one.ok).toBe(false);
    expect(one.reasons).toContain("INSUFFICIENT_CATALOG");
  });

  it("reports EMPTY_SHORTLIST", () => {
    const sel = selectDecoys([], CATALOG, { seed: "x" });
    expect(sel).toMatchObject({ ok: false, decoyIds: [], reasons: ["EMPTY_SHORTLIST"] });
  });
});

describe("decoys are indistinguishable from the shortlist (recipient view)", () => {
  const VISIBLE_KEYS: (keyof CarouselItem)[] = ["id", "title", "category", "price", "currency", "metal", "metalTone", "image", "hasImage", "vtoSpecOk", "badges", "swatches", "genderPresentation", "styleFamily"];
  const titlePattern = (t: string) => t.replace(/[A-Z][a-z]+/g, "W");

  it("every recipient-visible field has the same kind of value for shortlist items and decoys", () => {
    for (let t = 0; t < 150; t++) {
      const shortlist = randomShortlist(DENSE_INTERIOR, 1 + (t % 4), `i${t}`);
      const sel = selectDecoys(shortlist, DENSE, { seed: `j${t}` });
      const items = buildCarousel(sel, DENSE);
      const isShort = new Set(shortlist.map((s) => s.id));
      const S = items.filter((i) => isShort.has(i.id));
      const D = items.filter((i) => !isShort.has(i.id));
      expect(items).toHaveLength(6);
      for (const it of items) expect(Object.keys(it).sort()).toEqual([...VISIBLE_KEYS].sort());
      // title pattern, image presence/spec flag, badges, currency: identical across both groups
      expect(new Set(D.map((i) => titlePattern(i.title)))).toEqual(new Set(S.map((i) => titlePattern(i.title))));
      for (const it of items) {
        expect(it.badges).toEqual([]);
        expect(it.hasImage).toBe(true);
        expect(it.vtoSpecOk).toBe(true);
        expect(it.image).toMatch(/^catalog\/[\w-]+\.png$/);
        expect(it.currency).toBe("USD");
      }
      // category: decoys only use shortlist categories; metal: each decoy matches its shadow's tone
      for (const d of D) expect(S.map((s) => s.category)).toContain(d.category);
      for (const p of sel.picks) {
        const s = items.find((i) => i.id === p.shadowOf)!;
        const d = items.find((i) => i.id === p.decoyId)!;
        expect(d.metalTone).toBe(s.metalTone);
        // price band
        expect(Math.abs(d.price / s.price - 1)).toBeLessThanOrEqual(0.2 + 1e-9);
      }
    }
  }, 180_000);

  it("carousel order is a seeded shuffle: reproducible, independent of input order, uniform over positions", () => {
    const ids = ["s1", "s2", "s3", "d1", "d2", "d3"];
    expect(carouselOrder(ids, "k")).toEqual(carouselOrder([...ids].reverse(), "k"));
    expect([...carouselOrder(ids, "k")].sort()).toEqual([...ids].sort());
    const N = 6000;
    const counts = Array.from({ length: 6 }, () => 0);
    let shortlistInFirstHalf = 0;
    for (let i = 0; i < N; i++) {
      const order = carouselOrder(ids, `seed-${i}`);
      counts[order.indexOf("s1")]++;
      shortlistInFirstHalf += order.slice(0, 3).filter((id) => id.startsWith("s")).length;
    }
    const expected = N / 6;
    const chi2 = counts.reduce((sum, c) => sum + (c - expected) ** 2 / expected, 0);
    expect(chi2).toBeLessThan(20.5); // df = 5, p ≈ 0.001
    expect(shortlistInFirstHalf / N).toBeGreaterThan(1.4);
    expect(shortlistInFirstHalf / N).toBeLessThan(1.6); // expected 1.5
  });

  it("toCarouselItem exposes no shortlist/decoy marker", () => {
    const item = toCarouselItem(sku("a"));
    expect(JSON.stringify(item)).not.toMatch(/shortlist|decoy|shadow|tier|giver/i);
  });

  it("guess probability ≈ 1/6: no visible-attribute attacker beats a blind guess by more than noise", () => {
    const r = estimateGuessProbability(CATALOG, { trials: 4000, seed: "test" });
    expect(r.carouselSize).toBe(6);
    expect(r.baseline).toBeCloseTo(1 / 6);
    expect(Object.keys(r.byAttacker).sort()).toEqual(Object.keys(ATTACKERS).sort());
    // Headline: best of 11 attackers within 3 standard errors (+0.005 for best-of selection) of 1/6.
    expect(r.guessProbability).toBeLessThanOrEqual(r.baseline + 3 * r.standardError + 0.005);
    // The demo configuration (3 shortlisted + 3 decoys) is the cleanest.
    expect(r.bySize[3].guessProbability).toBeLessThanOrEqual(r.baseline + 3 * r.bySize[3].standardError + 0.005);
    // Position and badges carry nothing.
    expect(Math.abs(r.byAttacker.firstPosition - r.baseline)).toBeLessThan(3 * r.standardError);
    expect(r.byAttacker.hasBadge).toBeCloseTo(r.byAttacker.firstPosition, 10);
  }, 180_000);

  it("has power: without the shuffle (shortlist first) the first-position attacker wins", () => {
    let hits = 0;
    const N = 400;
    for (let t = 0; t < N; t++) {
      const shortlist = randomShortlist(READY, 1 + (t % 4), `pw${t}`);
      const sel = selectDecoys(shortlist, CATALOG, { seed: `pw${t}` });
      const naive = [...shortlist.map((s) => s.id), ...sel.decoyIds];
      if (shortlist.some((s) => s.id === naive[ATTACKERS.firstPosition([])])) hits += 1 / shortlist.length;
    }
    expect(hits / N).toBeGreaterThan(0.45); // ≈ (1 + 1/2 + 1/3 + 1/4) / 4 = 0.52
  });
});

describe("metal swatches are indistinguishable too (ADR-032)", () => {
  const VCAT = withVariants(makeCatalog(200, "aurum-sim"), 0.2, "swatch-test");
  const VREADY = VCAT.filter((s) => s.attributes.vto_spec_ok);
  const MULTI = VREADY.filter((s) => (s.variants?.length ?? 1) > 1);
  const GOLD = ["Yellow gold", "Rose gold"];

  it("decoys respect the cap and the metal lock: every decoy shows ≥ 1 swatch, all inside the lock", () => {
    for (let t = 0; t < 120; t++) {
      const first = MULTI[t % MULTI.length];
      const lock = t % 3 === 0 ? (["yellow_gold", "rose_gold"] as const) : undefined;
      const request = { budgetMax: Math.ceil((first.price * 1.25) / 10) * 10, currency: "USD", metalLock: lock ? [...lock] : undefined };
      if (eligibleVariants(first, request).length === 0) continue;
      const sel = selectDecoys([first], VCAT, { seed: `lock${t}`, request });
      const items = buildCarousel(sel, VCAT, request);
      for (const it of items) {
        expect(it.swatches.length).toBeGreaterThanOrEqual(1);
        if (lock) for (const label of it.swatches) expect(GOLD).toContain(label);
        expect(SWATCH_LABELS).toEqual(expect.arrayContaining(it.swatches));
      }
      for (const id of sel.decoyIds) {
        const d = VCAT.find((c) => c.id === id)!;
        expect(eligibleVariants(d, request).length).toBeGreaterThan(0);
      }
    }
  });

  it("swatch counts: designs showing the most swatches are never more likely to be shortlisted (leveling rule)", () => {
    for (let t = 0; t < 200; t++) {
      const size = 1 + (t % 4);
      const shortlist = randomShortlist(t % 2 ? MULTI : VREADY, size, `sw${t}`);
      const request = { budgetMax: Math.ceil((shortlist[0].price * 1.4) / 10) * 10, currency: "USD" };
      if (shortlist.some((s) => eligibleVariants(s, request).length === 0)) continue;
      const sel = selectDecoys(shortlist, VCAT, { seed: `sw${t}`, request });
      const items = buildCarousel(sel, VCAT, request);
      const isShort = new Set(shortlist.map((s) => s.id));
      const S = items.filter((i) => isShort.has(i.id));
      const D = items.filter((i) => !isShort.has(i.id));
      const top = Math.max(...items.map((i) => i.swatches.length));
      const sTop = S.filter((i) => i.swatches.length === top).length;
      const dTop = D.filter((i) => i.swatches.length === top).length;
      expect(sTop * D.length).toBeLessThanOrEqual(dTop * S.length);
      // The default swatch is always one of the shown metals.
      for (const it of items) expect(it.swatches).toContain(SWATCH_LABEL[it.metal as keyof typeof SWATCH_LABEL]);
    }
  });

  it("parity mode: a multi-metal pick with one decoy gets a same-swatch-count decoy whenever one exists in its category and ±20% band", () => {
    let available = 0;
    const request = { budgetMax: 100000, currency: "USD" };
    for (let t = 0; t < 150; t++) {
      const first = MULTI[t % MULTI.length];
      const n = eligibleVariants(first, request).length;
      // Two single-metal companions → 3 decoys, one per shortlist item (k = 1 each).
      const companions = VREADY.filter((c) => c.id !== first.id && (c.variants?.length ?? 1) === 1).slice(t % 50, (t % 50) + 2);
      const shortlist = [first, ...companions];
      const exists = VREADY.some(
        (c) => !shortlist.includes(c) && c.category === first.category && Math.abs(c.price / first.price - 1) <= 0.2 && eligibleVariants(c, request).length === n,
      );
      if (!exists) continue;
      available++;
      const sel = selectDecoys(shortlist, VCAT, { seed: `par${t}`, request });
      const shadow = sel.picks.filter((p) => p.shadowOf === first.id);
      expect(shadow.length).toBe(1);
      expect(eligibleVariants(VCAT.find((c) => c.id === shadow[0].decoyId)!, request)).toHaveLength(n);
    }
    expect(available).toBeGreaterThan(20);
  });

  it("without full parity (one pick, five decoys) the default metal ranks first", () => {
    const request = { budgetMax: 100000, currency: "USD" };
    let sameMetal = 0;
    let runs = 0;
    for (let t = 0; t < 120; t++) {
      const first = MULTI[t % MULTI.length];
      const sel = selectDecoys([first], VCAT, { seed: `metal${t}`, request });
      const items = buildCarousel(sel, VCAT, request);
      const pick = items.find((i) => i.id === first.id)!;
      const supply = VREADY.some(
        (c) => c.id !== first.id && c.category === first.category && Math.abs(c.price / first.price - 1) <= 0.2 && c.attributes.metal === pick.metal,
      );
      if (!supply) continue;
      runs++;
      if (items.some((i) => i.id !== first.id && i.metal === pick.metal)) sameMetal++;
    }
    expect(runs).toBeGreaterThan(20);
    expect(sameMetal).toBe(runs);
  });

  it("guess probability with swatches stays ≈ 1/6, including when the giver picks multi-metal designs", () => {
    const all = estimateGuessProbability(VCAT, { trials: 3000, seed: "vtest" });
    expect(all.byAttacker.mostSwatches).toBeLessThanOrEqual(all.baseline + 3 * all.standardError + 0.005);
    expect(all.guessProbability).toBeLessThanOrEqual(all.baseline + 3 * all.standardError + 0.01);
    const multiFirst = estimateGuessProbability(VCAT, { trials: 2000, seed: "vtest-multi", firstIds: MULTI.map((s) => s.id) });
    for (const k of ["mostSwatches", "fewestSwatches", "rarestSwatchSet"]) {
      expect(multiFirst.byAttacker[k]).toBeLessThanOrEqual(multiFirst.baseline + 3 * multiFirst.standardError + 0.005);
    }
  }, 120_000);
});

describe("demo shortlist replica (Halo Drop + Reverie Pear Pendant + Chime Bell, $300 cap, no lock)", () => {
  const mv = (id: string, metal: MetalVariant["metal"], price: number): MetalVariant => ({
    variantId: `${id}:${metal}`,
    metal,
    metal_tone: metal === "white_gold" || metal === "silver" ? "cool" : "warm",
    price,
    images: [`/v/${id}-${metal}.jpg`],
    vto_image: `/v/${id}-${metal}.jpg`,
    vto_spec_ok: true,
  });
  const design = (id: string, title: string, category: "earring" | "necklace", vs: MetalVariant[]): CatalogSku => ({
    ...sku(id, { title, category, price: vs[0].price, attributes: { category, metal: vs[0].metal, metal_tone: vs[0].metal_tone } }),
    variants: vs,
  });
  // Prices and listing order as in A2's batch 2 (fixtures/aurum/catalog.json, ADR-035).
  const build = (chimeFirst: MetalVariant["metal"]) => {
    const chime = [mv("chime", "rose_gold", 259), mv("chime", "yellow_gold", 259), mv("chime", "white_gold", 275)];
    chime.sort((a, b) => Number(b.metal === chimeFirst) - Number(a.metal === chimeFirst));
    return [
      design("halo", "Halo Drop Earrings", "earring", [mv("halo", "yellow_gold", 245), mv("halo", "white_gold", 265), mv("halo", "rose_gold", 249)]),
      design("reverie", "Reverie Pear Pendant", "necklace", [mv("reverie", "white_gold", 215), mv("reverie", "yellow_gold", 199), mv("reverie", "rose_gold", 199)]),
      design("chime", "Chime Bell Drop Earrings", "earring", chime),
      design("cove", "Cove Fringe Earrings", "earring", [mv("cove", "yellow_gold", 259), mv("cove", "white_gold", 275), mv("cove", "rose_gold", 259)]),
      design("jubilee", "Jubilee Pearl Chandeliers", "earring", [mv("jubilee", "white_gold", 245), mv("jubilee", "yellow_gold", 229), mv("jubilee", "rose_gold", 229)]),
      design("starlit", "Starlit Bib Collar", "necklace", [mv("starlit", "yellow_gold", 245), mv("starlit", "white_gold", 265), mv("starlit", "rose_gold", 245)]),
      design("regal", "Regal Pave Choker", "necklace", [mv("regal", "yellow_gold", 289), mv("regal", "white_gold", 309), mv("regal", "rose_gold", 289)]),
      ...makeCatalog(120, "demo-singles").filter((s) => s.price < 150 || s.price > 400),
    ];
  };
  const req = { budgetMax: 300, currency: "USD" };
  const DEMO = ["halo", "reverie", "chime"];

  it("Halo Drop shows all 3 metals: three-metal decoys let leveling keep cap 3", () => {
    const cat = build("rose_gold");
    for (let t = 0; t < 50; t++) {
      const sel = selectDecoys(cat.filter((s) => DEMO.includes(s.id)), cat, { seed: `demo${t}`, request: req });
      expect(sel.decoyIds.sort()).toEqual(["cove", "jubilee", "starlit"]);
      const items = buildCarousel(sel, cat, req);
      for (const it of items) expect(it.swatches).toHaveLength(3);
      expect(items.find((i) => i.id === "halo")!.swatches).toEqual(["Yellow gold", "White gold", "Rose gold"]);
    }
  });

  it("as listed today, Chime Bell's rose-gold default is the one shortlist-only metal; listing its yellow gold first removes it", () => {
    const leaksFor = (first: MetalVariant["metal"]) => {
      const cat = build(first);
      const sel = selectDecoys(cat.filter((s) => DEMO.includes(s.id)), cat, { seed: "demo", request: req });
      return fixedCarouselLeaks(buildCarousel(sel, cat, req), DEMO);
    };
    expect(leaksFor("rose_gold")).toEqual([{ attribute: "defaultMetal", shortlistOnly: ["rose_gold"], decoyOnly: [] }]);
    expect(leaksFor("yellow_gold")).toEqual([]);
  });
});

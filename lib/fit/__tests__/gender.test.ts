/**
 * Gender-presentation parity for decoys (A3 fix, branch p5-demo-polish): a men's carousel must not
 * get feminine pendants as decoys (found in lib/privacy MEN_DEMO), and the new attackers see it.
 */
import { describe, expect, it } from "vitest";
import type { CatalogSku } from "@/lib/contracts/giftfit";
import { buildCarousel, compatibleGenders, genderOf, selectDecoys } from "../decoys";
import { ATTACKERS, fixedCarouselLeaks } from "../guess";
import { sku } from "./fixtures";

type G = "feminine" | "masculine" | "unisex" | undefined;
const item = (id: string, category: CatalogSku["category"], price: number, g: G, metal: CatalogSku["attributes"]["metal"] = "yellow_gold", style = "classic") =>
  sku(id, {
    category,
    price,
    title: `${id} piece`,
    attributes: {
      category,
      metal,
      metal_tone: metal === "silver" || metal === "white_gold" || metal === "platinum" ? "cool" : metal === "mixed_two_tone" ? "neutral" : "warm",
      style,
      gender_presentation: g,
      earring_shape: category === "earring" ? "drop_teardrop" : undefined,
      necklace_style: category === "necklace" ? "thin_chain" : undefined,
    },
  });

// A men's shortlist (watch + two chains) in a catalog where feminine pendants are the closest by price.
const MEN_PICKS = [item("watch-m", "watch", 525, "masculine", "mixed_two_tone"), item("chain-u", "necklace", 159, "unisex", "rose_gold"), item("chain-m", "necklace", 59, "masculine")];
const CATALOG: CatalogSku[] = [
  ...MEN_PICKS,
  item("pendant-f1", "necklace", 160, "feminine", "rose_gold"),
  item("pendant-f2", "necklace", 60, "feminine"),
  item("pendant-f3", "necklace", 150, "feminine", "rose_gold"),
  item("watch-f", "watch", 520, "feminine", "mixed_two_tone"),
  item("watch-m2", "watch", 495, "masculine"),
  item("watch-u", "watch", 540, "unisex", "mixed_two_tone"),
  item("chain-u2", "necklace", 65, "unisex", "silver"),
  item("chain-u3", "necklace", 170, "unisex", "rose_gold"),
  item("chain-x", "necklace", 150, undefined, "rose_gold"), // missing value → unisex
  item("chain-m2", "necklace", 62, "masculine", "silver"),
  item("chain-m3", "necklace", 152, "masculine", "rose_gold"),
  item("ear-f", "earring", 160, "feminine", "rose_gold"),
];
const REQ = { budgetMax: 600, currency: "USD" };

describe("compatibleGenders / genderOf", () => {
  it("masculine → masculine or unisex; feminine → feminine or unisex; unisex → unisex + the picks' gendered presentations", () => {
    expect([...compatibleGenders(MEN_PICKS[0], MEN_PICKS)].sort()).toEqual(["masculine", "unisex"]);
    expect([...compatibleGenders(item("e", "earring", 100, "feminine"), [])].sort()).toEqual(["feminine", "unisex"]);
    expect([...compatibleGenders(MEN_PICKS[1], MEN_PICKS)].sort()).toEqual(["masculine", "unisex"]);
    expect([...compatibleGenders(item("u", "ring", 100, "unisex"), [item("u", "ring", 100, "unisex")])]).toEqual(["unisex"]);
    expect(genderOf(item("x", "ring", 100, undefined))).toBe("unisex");
  });
});

describe("selectDecoys: gender-presentation parity", () => {
  it("a men's shortlist never gets feminine decoys, and exact masculine beats unisex when available", () => {
    for (let t = 0; t < 40; t++) {
      const sel = selectDecoys(MEN_PICKS, CATALOG, { seed: `men${t}`, request: REQ });
      expect(sel.decoyIds).toHaveLength(3);
      for (const id of sel.decoyIds) expect(genderOf(CATALOG.find((c) => c.id === id)!)).not.toBe("feminine");
      const watchShadow = sel.picks.find((p) => p.shadowOf === "watch-m")!;
      expect(watchShadow.decoyId).toBe("watch-m2"); // masculine preferred over the unisex watch
      expect(sel.reasons).not.toContain("GENDER_RELAXED");
    }
  });

  it("a women's shortlist never gets masculine decoys", () => {
    const picks = [item("ear-a", "earring", 200, "feminine"), item("nec-a", "necklace", 220, "feminine")];
    const cat = [...picks, item("ear-m", "earring", 205, "masculine"), item("ear-f2", "earring", 210, "feminine"), item("ear-u", "earring", 190, "unisex"), item("nec-f2", "necklace", 215, "feminine"), item("nec-m", "necklace", 221, "masculine"), item("nec-u", "necklace", 230, "unisex"), item("nec-f3", "necklace", 200, "feminine")];
    for (let t = 0; t < 30; t++) {
      const sel = selectDecoys(picks, cat, { seed: `fem${t}`, request: { budgetMax: 500, currency: "USD" } });
      for (const id of sel.decoyIds) expect(genderOf(cat.find((c) => c.id === id)!)).not.toBe("masculine");
    }
  });

  it("mixed shortlists keep the mix per shadowed pick", () => {
    const picks = [item("ear-f", "earring", 200, "feminine"), item("wch-m", "watch", 300, "masculine")];
    const cat = [...picks, item("ear-f2", "earring", 205, "feminine"), item("ear-f3", "earring", 195, "feminine"), item("ear-m", "earring", 200, "masculine"), item("wch-f", "watch", 300, "feminine"), item("wch-m2", "watch", 290, "masculine"), item("wch-m3", "watch", 310, "masculine")];
    const sel = selectDecoys(picks, cat, { seed: "mix", request: { budgetMax: 500, currency: "USD" } });
    for (const p of sel.picks) {
      const g = genderOf(cat.find((c) => c.id === p.decoyId)!);
      expect(g).toBe(p.shadowOf === "ear-f" ? "feminine" : "masculine");
    }
  });

  it("relaxes only when the compatible pool cannot fill the slots, with GENDER_RELAXED", () => {
    const picks = [item("wch-m", "watch", 300, "masculine")];
    const cat = [...picks, item("wch-f1", "watch", 300, "feminine"), item("wch-f2", "watch", 305, "feminine"), item("wch-u", "watch", 295, "unisex")];
    const sel = selectDecoys(picks, cat, { seed: "thin", request: { budgetMax: 500, currency: "USD" } });
    expect(sel.decoyIds).toContain("wch-u");
    expect(sel.reasons).toContain("GENDER_RELAXED");
  });
});

describe("attackers see gender presentation and style family", () => {
  it("ATTACKERS include gender and style attackers", () => {
    for (const k of ["oddGenderOut", "gender:feminine", "gender:masculine", "gender:unisex", "oddStyleOut"]) expect(ATTACKERS[k]).toBeTypeOf("function");
  });

  it("fixedCarouselLeaks flags the original bug (feminine decoys for men's picks) and passes the fixed carousel", () => {
    const pickIds = MEN_PICKS.map((p) => p.id);
    const buggy = buildCarousel({ decoyIds: ["pendant-f1", "pendant-f2", "watch-f"], picks: [], reasons: [], ok: true, requested: 3, carouselIds: [...pickIds, "pendant-f1", "pendant-f2", "watch-f"] }, CATALOG, REQ);
    expect(fixedCarouselLeaks(buggy, pickIds).map((l) => l.attribute)).toContain("genderPresentation");
    const sel = selectDecoys(MEN_PICKS, CATALOG, { seed: "men-fixed", request: REQ });
    expect(fixedCarouselLeaks(buildCarousel(sel, CATALOG, REQ), pickIds)).toEqual([]);
  });
});

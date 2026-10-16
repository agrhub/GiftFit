import { describe, expect, it } from "vitest";
import {
  EARRING_SHAPES,
  FACE_SHAPES,
  METALS,
  NECKLACE_STYLES,
  type GiftFitAttributes,
  type Undertone,
} from "@/lib/contracts/giftfit";
import {
  EARRING_FACE,
  METAL_TONE,
  METAL_UNDERTONE,
  NECKLACE_FACE,
  RULE_WEIGHTS,
  combineScores,
  jewelryRules,
  necklaceLengthBins,
  styleFit,
  type RuleRow,
} from "@/lib/verticals/jewelry";

const UNDERTONES: Undertone[] = ["warm", "neutral", "cool"];
const SOURCE_IDS = new Set([
  ...["R1", "R2", "R3", "R4"],
  ...["E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8"],
  ...["N1", "N2", "N3", "N4", "N5"],
]);

const base: GiftFitAttributes = {
  category: "earring",
  metal: "yellow_gold",
  metal_tone: "warm",
  style: "classic",
  occasions: ["birthday"],
  vto_spec_ok: true,
  vto_image: "/catalog/x.png",
};
const earring = (earring_shape: GiftFitAttributes["earring_shape"]): GiftFitAttributes => ({ ...base, earring_shape });
const necklace = (necklace_style: GiftFitAttributes["necklace_style"], necklace_length_in?: number): GiftFitAttributes => ({
  ...base,
  category: "necklace",
  necklace_style,
  necklace_length_in,
});

const allRows = (): [string, RuleRow][] => [
  ...Object.values(METAL_UNDERTONE).flatMap((t) => Object.entries(t)),
  ...Object.values(EARRING_FACE).flatMap((t) => Object.entries(t) as [string, RuleRow][]),
  ...Object.values(NECKLACE_FACE).flatMap((t) => Object.entries(t) as [string, RuleRow][]),
];

describe("rule tables", () => {
  it("cover every metal × undertone and every face shape", () => {
    for (const m of METALS) for (const u of UNDERTONES) expect(METAL_UNDERTONE[m][u]).toBeDefined();
    for (const f of FACE_SHAPES) {
      expect(EARRING_FACE[f]).toBeDefined();
      expect(NECKLACE_FACE[f]).toBeDefined();
    }
  });

  it("cite only sources from jewelry_rules.md and flag single-source rows", () => {
    for (const [, r] of allRows()) {
      expect(r.sources.length).toBeGreaterThan(0);
      for (const s of r.sources) expect(SOURCE_IDS.has(s)).toBe(true);
      if (r.sources.length < 2) expect(r.single_source).toBe(true);
    }
  });

  it("use only contract tokens and the documented length bins", () => {
    const bins = ["len_le_16", "len_16_to_19", "len_le_18", "len_ge_20", "len_ge_22", "pendant_v_y_long", "*"];
    for (const t of Object.values(EARRING_FACE)) for (const k of Object.keys(t)) expect([...EARRING_SHAPES, "*"]).toContain(k);
    for (const t of Object.values(NECKLACE_FACE)) for (const k of Object.keys(t)) expect([...NECKLACE_STYLES, ...bins]).toContain(k);
  });

  it("maps each metal to the catalog metal_tone (rose gold stays warm)", () => {
    expect(METAL_TONE).toEqual({
      yellow_gold: "warm",
      rose_gold: "warm",
      white_gold: "cool",
      silver: "cool",
      platinum: "cool",
      mixed_two_tone: "neutral",
    });
  });
});

describe("metalFit", () => {
  it("never returns avoid, and never weighs below 0.4", () => {
    for (const m of METALS)
      for (const u of UNDERTONES) {
        const s = jewelryRules.metalFit(m, u);
        expect(s.strength).not.toBe("avoid");
        expect(s.weight).toBeGreaterThanOrEqual(0.4);
      }
  });

  it("recommends every metal for a neutral undertone except two-tone, which is also recommended", () => {
    for (const m of METALS) expect(jewelryRules.metalFit(m, "neutral").strength).toBe("recommended");
  });

  it("recommends gold for warm and white metals for cool; opposites are acceptable", () => {
    expect(jewelryRules.metalFit("yellow_gold", "warm")).toEqual({ strength: "recommended", weight: 1, sources: ["R1", "R2", "R3", "R4"], singleSource: false });
    expect(jewelryRules.metalFit("platinum", "cool").strength).toBe("recommended");
    expect(jewelryRules.metalFit("silver", "warm")).toMatchObject({ strength: "acceptable", weight: 0.4, singleSource: true });
    expect(jewelryRules.metalFit("rose_gold", "cool")).toMatchObject({ strength: "acceptable", weight: 0.4 });
  });
});

describe("styleFit: earrings", () => {
  it("Round: long drops recommended, large round hoops avoided (≥ 2 sources)", () => {
    expect(styleFit(earring("drop_long_narrow"), "Round")).toMatchObject({ strength: "recommended", weight: 1 });
    expect(styleFit(earring("hoop_round_large"), "Round")).toMatchObject({ strength: "avoid", weight: -1, singleSource: false });
    expect(styleFit(earring("hoop_small_medium"), "Round").strength).toBe("none"); // contested → no rule
  });

  it("Oval: wildcard recommended, except long narrow drops", () => {
    expect(styleFit(earring("stud_small"), "Oval")).toMatchObject({ strength: "recommended", weight: 1 });
    expect(styleFit(earring("drop_long_narrow"), "Oval").strength).toBe("avoid");
  });

  it("halves single-source rows", () => {
    expect(styleFit(earring("hoop_small_medium"), "Heart")).toMatchObject({ strength: "acceptable", weight: RULE_WEIGHTS.acceptable / 2, singleSource: true });
  });

  it("degrades a single-source avoid to none (ADR-013) but keeps its source", () => {
    expect(styleFit(earring("drop_long_narrow"), "Diamond")).toEqual({ strength: "none", weight: 0, sources: ["E6"], singleSource: true });
  });

  it("InvTriangle uses the Heart rows plus the E7 extras", () => {
    for (const shape of EARRING_SHAPES) {
      const heart = styleFit(earring(shape), "Heart");
      const inv = styleFit(earring(shape), "InvTriangle");
      if (shape === "stud_small" || shape === "hoop_oval_curved") {
        expect(heart.strength).toBe("none");
        expect(inv).toMatchObject({ strength: "acceptable", sources: ["E7"], singleSource: true });
      } else expect(inv).toEqual(heart);
    }
  });

  it("flags every Triangle row single-source, so its avoid row is not applied", () => {
    for (const r of Object.values(EARRING_FACE.Triangle)) expect(r?.single_source).toBe(true);
    for (const r of Object.values(NECKLACE_FACE.Triangle)) expect(r?.single_source).toBe(true);
    expect(styleFit(earring("drop_wide_bottom"), "Triangle")).toMatchObject({ strength: "none", weight: 0 });
    expect(styleFit(earring("drop_long_narrow"), "Triangle")).toMatchObject({ strength: "acceptable", weight: 0.2 });
  });

  it("Unknown face shape and missing shape tokens give none", () => {
    for (const shape of EARRING_SHAPES) expect(styleFit(earring(shape), "Unknown").strength).toBe("none");
    expect(styleFit(earring(undefined), "Round").strength).toBe("none");
  });
});

describe("styleFit: necklaces", () => {
  it("derives length bins from necklace_length_in", () => {
    expect(necklaceLengthBins(14)).toEqual(["len_le_16", "len_le_18"]);
    expect(necklaceLengthBins(16)).toEqual(["len_le_16", "len_16_to_19", "len_le_18"]);
    expect(necklaceLengthBins(18)).toEqual(["len_16_to_19", "len_le_18"]);
    expect(necklaceLengthBins(20)).toEqual(["len_ge_20"]);
    expect(necklaceLengthBins(24)).toEqual(["len_ge_20", "len_ge_22"]);
    expect(necklaceLengthBins(undefined)).toEqual([]);
    expect(necklaceLengthBins(-1)).toEqual([]);
  });

  it("Round: long V pendant is recommended (combined, clamped to 1); short choker avoided", () => {
    expect(styleFit(necklace("pendant_v_y", 24), "Round")).toMatchObject({ strength: "recommended", weight: 1, singleSource: false });
    expect(styleFit(necklace("choker", 15), "Round")).toMatchObject({ strength: "avoid", weight: -1 });
  });

  it("Heart: princess length recommended; long V pendant (single-source avoid) is not applied", () => {
    expect(styleFit(necklace("pendant_curved", 18), "Heart")).toMatchObject({ strength: "recommended", weight: 1 });
    const longV = styleFit(necklace("pendant_v_y", 22), "Heart");
    expect(longV.strength).toBe("none");
    expect(longV.sources).toEqual(["N5"]);
    expect(styleFit(necklace("pendant_v_y", 22), "InvTriangle")).toEqual(longV);
  });

  it("Oblong: short collar recommended; long vertical avoided", () => {
    expect(styleFit(necklace("collar_bib_horizontal", 17), "Oblong").strength).toBe("recommended");
    expect(styleFit(necklace("long_vertical", 30), "Oblong").strength).toBe("avoid");
  });

  it("Square: curved pendants recommended, angular pendants avoided; Oval wildcard and choker", () => {
    expect(styleFit(necklace("pendant_curved", 20), "Square").strength).toBe("recommended");
    expect(styleFit(necklace("geometric_angular", 18), "Square").strength).toBe("avoid");
    expect(styleFit(necklace("thin_chain", 18), "Oval").strength).toBe("recommended");
    expect(styleFit(necklace("choker", 15), "Oval")).toMatchObject({ strength: "acceptable", weight: 0.2 });
  });

  it("combines rows: weights summed and clamped, sources unioned", () => {
    const c = combineScores([
      { strength: "recommended", weight: 1, sources: ["N2"], singleSource: false },
      { strength: "avoid", weight: -1, sources: ["N1"], singleSource: false },
    ]);
    expect(c).toEqual({ strength: "none", weight: 0, sources: ["N1", "N2"], singleSource: false });
    expect(combineScores([])).toMatchObject({ strength: "none", weight: 0 });
  });
});

describe("styleFit: other categories", () => {
  it("has no sourced shape rule for ring, bracelet or watch", () => {
    for (const category of ["ring", "bracelet", "watch"] as const)
      for (const f of FACE_SHAPES) expect(styleFit({ ...base, category }, f).strength).toBe("none");
  });
});

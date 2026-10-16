import { describe, expect, it } from "vitest";
import { type GiftPiece, type GiverDraft, MAX_SHORTLIST, eligibleVariants, lockMetals, presetForPrice, resolveCap, suggestPieces, toRequestBody, validateDraft } from "../giverDraft";

const piece = (id: string, price: number, extra: Partial<GiftPiece> = {}): GiftPiece => ({ id, slug: id, title: `Piece ${id}`, price, currency: "USD", image: `/x/${id}.png`, category: "earring", metal: "yellow_gold", ...extra });
// Halo Drop as in the catalog: yellow $245, white $265, rose $249.
const halo = piece("halo", 245, {
  title: "Halo Drop Earrings",
  variants: [
    { metal: "yellow_gold", price: 245 },
    { metal: "white_gold", price: 265 },
    { metal: "rose_gold", price: 249 },
  ],
});
const draft = (patch: Partial<GiverDraft> = {}): GiverDraft => ({ occasion: "anniversary", budgetPreset: "300", customMax: "", metalLock: "any", shortlist: [halo], ...patch });

describe("Giver Panel: cap and metal lock (ADR-032)", () => {
  it("accepts the demo draft: anniversary, up to $300, 1–4 designs", () => {
    for (let n = 1; n <= MAX_SHORTLIST; n++) {
      const check = validateDraft(draft({ shortlist: Array.from({ length: n }, (_, i) => piece(`p${i}`, 200)) }));
      expect(check.ok).toBe(true);
      expect(check.cap).toBe(300);
    }
  });

  it("requires an occasion, a cap and at least one design", () => {
    const check = validateDraft(draft({ occasion: null, budgetPreset: null, shortlist: [] }));
    expect(Object.keys(check.errors).sort()).toEqual(["budget", "occasion", "shortlist"]);
  });

  it("rejects more than 4 designs and duplicates", () => {
    expect(validateDraft(draft({ shortlist: ["a", "b", "c", "d", "e"].map((id) => piece(id, 200)) })).errors.shortlist).toMatch(/up to 4/);
    expect(validateDraft(draft({ shortlist: [piece("a", 200), piece("a", 200)] })).errors.shortlist).toMatch(/once/);
  });

  it("validates a custom cap", () => {
    expect(resolveCap({ budgetPreset: "custom", customMax: "275" })).toBe(275);
    for (const max of ["", "0", "-5", "999999", "abc"]) expect(validateDraft(draft({ budgetPreset: "custom", customMax: max })).errors.budget).toBeDefined();
  });

  it("counts the metals within the cap and the lock", () => {
    expect(eligibleVariants(halo, 300).map((v) => v.metal)).toEqual(["yellow_gold", "white_gold", "rose_gold"]);
    expect(eligibleVariants(halo, 250).map((v) => v.metal)).toEqual(["yellow_gold", "rose_gold"]);
    expect(eligibleVariants(halo, 300, "gold").map((v) => v.metal)).toEqual(["yellow_gold", "rose_gold"]);
    expect(eligibleVariants(halo, 300, "white").map((v) => v.metal)).toEqual(["white_gold"]);
    expect(eligibleVariants(halo, 300, "silver")).toEqual([]);
    expect(eligibleVariants(halo, null).length).toBe(3);
  });

  it("blocks a design with no eligible variant (the API would answer 422)", () => {
    const check = validateDraft(draft({ budgetPreset: "150" }));
    expect(check.ok).toBe(false);
    expect(check.ineligible.map((p) => p.id)).toEqual(["halo"]);
    expect(check.errors.shortlist).toMatch(/Halo Drop Earrings has no metal within your budget and metal choice/);
    expect(validateDraft(draft({ metalLock: "silver" })).ok).toBe(false);
  });

  it("builds the contract body: budgetMax, optional metalLock, no budgetMin", () => {
    expect(toRequestBody(draft(), "store-1")).toEqual({ storeId: "store-1", occasion: "anniversary", budgetMax: 300, currency: "USD", shortlistIds: ["halo"] });
    expect(toRequestBody(draft({ metalLock: "gold" })).metalLock).toEqual(["yellow_gold", "rose_gold"]);
    expect(toRequestBody(draft({ metalLock: "white_gold" })).metalLock).toEqual(["white_gold"]);
    expect(lockMetals("any")).toBeUndefined();
    expect(() => toRequestBody(draft({ occasion: null }))).toThrow();
  });

  it("pre-selects the smallest cap covering a price", () => {
    expect(presetForPrice(245)).toBe("300");
    expect(presetForPrice(99)).toBe("150");
    expect(presetForPrice(4000)).toBe("2500");
  });

  it("suggests only designs with a metal inside the cap and lock", () => {
    const catalog = [
      halo,
      piece("in-occ", 220, { occasions: ["anniversary"] }),
      piece("plain", 210),
      piece("too-dear", 900, { occasions: ["anniversary"] }),
      piece("silver-only", 120, { metal: "silver" }),
      piece("necklace", 230, { category: "necklace", occasions: ["anniversary"] }),
    ];
    const got = suggestPieces(catalog, draft()).map((p) => p.id);
    expect(got).not.toContain("halo");
    expect(got).not.toContain("too-dear");
    expect(got[0]).toBe("in-occ");
    expect(suggestPieces(catalog, draft({ metalLock: "white" })).map((p) => p.id)).toEqual(["silver-only"]);
    expect(suggestPieces(catalog, draft(), "necklace").map((p) => p.id)).toEqual(["necklace"]);
  });
});

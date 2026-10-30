import { describe, expect, it } from "vitest";
import { type GiftPiece, type GiverDraft, MAX_SHORTLIST, draftFromBrief, eligibleVariants, lockIdFor, lockMetals, presetForPrice, resolveCap, suggestPieces, toRequestBody, toggle, validateDraft } from "../giverDraft";

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

describe("Help me choose drafts (ADR-045)", () => {
  const help = (over: Partial<GiverDraft> = {}): GiverDraft => ({ mode: "help_me_choose", occasion: "birthday", budgetPreset: "300", customMax: "", metalLock: "any", shortlist: [], categories: [], styleHints: [], presentation: "any", ...over });

  it("needs no shortlist and sends the brief fields only when set", () => {
    expect(validateDraft(help()).ok).toBe(true);
    expect(toRequestBody(help(), "store-1")).toEqual({ storeId: "store-1", mode: "help_me_choose", occasion: "birthday", budgetMax: 300, currency: "USD", shortlistIds: [] });
    expect(toRequestBody(help({ categories: ["ring"], styleHints: ["boho"], presentation: "masculine", metalLock: "silver" }))).toMatchObject({ categories: ["ring"], styleHints: ["boho"], genderPresentation: "masculine", metalLock: ["silver"] });
    expect(validateDraft(help({ occasion: null })).errors.occasion).toBeTruthy();
  });

  it("lockIdFor maps a brief's metals to the exact preset, else the narrowest covering one", () => {
    expect(lockIdFor(undefined)).toBe("any");
    expect(lockIdFor(["rose_gold", "yellow_gold"])).toBe("gold");
    expect(lockIdFor(["silver"])).toBe("silver");
    expect(lockIdFor(["platinum"])).toBe("white");
    expect(lockIdFor(["mixed_two_tone"])).toBe("any");
  });

  it("draftFromBrief fills mode, budget (preset or custom), lock, categories, hints and presentation", () => {
    const d = draftFromBrief({ mode: "help_me_choose", occasion: "wedding", budgetMax: 600, currency: "USD", categories: ["necklace"], styleHints: ["classic"], genderPresentation: "feminine", metalLock: ["white_gold"] }, help());
    expect(d).toMatchObject({ mode: "help_me_choose", occasion: "wedding", budgetPreset: "600", metalLock: "white_gold", categories: ["necklace"], styleHints: ["classic"], presentation: "feminine" });
    expect(draftFromBrief({ mode: "help_me_choose", occasion: "birthday", budgetMax: 275, currency: "USD" }, help())).toMatchObject({ budgetPreset: "custom", customMax: "275", presentation: "any", categories: ["earring", "necklace"] });
    const a = { id: "a", slug: "a", title: "A", price: 100, currency: "USD", image: "/a.png", category: "ring" as const };
    const ideas = draftFromBrief({ mode: "i_have_ideas", occasion: "birthday", budgetMax: 300, currency: "USD", shortlistIds: ["a", "missing"] }, help(), [a]);
    expect(ideas.mode).toBe("i_have_ideas");
    expect(ideas.shortlist.map((p) => p.id)).toEqual(["a"]);
  });

  it("toggle adds and removes chip values", () => {
    expect(toggle(undefined, "a")).toEqual(["a"]);
    expect(toggle(["a", "b"], "a")).toEqual(["b"]);
  });
});

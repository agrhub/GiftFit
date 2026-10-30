import { describe, expect, it } from "vitest";
import {
  canonicalMetal,
  coverage,
  inferCategory,
  inferEarringShape,
  inferNecklaceStyle,
  normaliseProduct,
  parseAmount,
  parseLengthInches,
  parsePrice,
  toCatalogSku,
} from "@/server/ingest/normalise";
import { EMPTY_PRODUCT, type RawProduct } from "@/server/ingest/types";

const raw = (p: Partial<RawProduct>): RawProduct => ({ ...EMPTY_PRODUCT, sourceUrl: "https://s.test/p/x", externalId: "x", tier: 3, tags: [], ...p });

describe("canonical vocabulary", () => {
  it.each([
    ["14k Yellow Gold", "yellow_gold"],
    ["18ct gold vermeil", "yellow_gold"],
    ["Rose Gold Vermeil", "rose_gold"],
    ["14K WHITE GOLD", "white_gold"],
    ["925 Sterling Silver", "silver"],
    ["Platinum", "platinum"],
    ["Two-tone 14k yellow and white gold", "mixed_two_tone"],
    ["yellow & white gold", "mixed_two_tone"],
    ["white_gold", "white_gold"],
    ["Stainless steel", null],
    ["Gold-tone brass", null],
    [null, null],
  ])("metal %j → %j", (text, metal) => expect(canonicalMetal(text)).toBe(metal));

  it("infers categories with word boundaries (earring is not ring)", () => {
    expect(inferCategory("Pearl Drop Earrings")).toBe("earring");
    expect(inferCategory("Halo Solitaire Ring")).toBe("ring");
    expect(inferCategory("Arden Opera Chain")).toBe("necklace");
    expect(inferCategory("Orbit Automatic Watch")).toBe("watch");
    expect(inferCategory("Ember Cuff Bracelet")).toBe("bracelet");
    expect(inferCategory("Gift Card")).toBeNull();
  });

  it("infers earring shape tokens", () => {
    expect(inferEarringShape("Noor Large Hoops")).toBe("hoop_round_large");
    expect(inferEarringShape("Talia Two-Tone Huggies")).toBe("hoop_small_medium");
    expect(inferEarringShape("Kira Geometric Studs")).toBe("geometric_angular");
    expect(inferEarringShape("Celeste Sapphire Cluster Studs")).toBe("stud_statement");
    expect(inferEarringShape("Ivy Linear Drop Earrings")).toBe("drop_long_narrow");
    expect(inferEarringShape("Short wide chandelier earrings")).toBe("chandelier_short");
    expect(inferEarringShape("Plain earrings")).toBeNull();
  });

  it("infers necklace style tokens, with long length as a last resort", () => {
    expect(inferNecklaceStyle(18, "Elara V Pendant Necklace")).toBe("pendant_v_y");
    expect(inferNecklaceStyle(15, "Mira Choker")).toBe("choker");
    expect(inferNecklaceStyle(20, "Odette Locket Necklace")).toBe("pendant_curved");
    expect(inferNecklaceStyle(30, "Plain necklace")).toBe("long_vertical");
    expect(inferNecklaceStyle(18, "Plain necklace")).toBeNull();
  });
});

describe("numbers", () => {
  it.each([
    ["1,250.00", 1250],
    ["1.250,00", 1250],
    ["1.250.000", 1_250_000],
    ["12,50", 12.5],
    ["65", 65],
    ["1 250", 1250],
  ])("amount %s → %d", (s, n) => expect(parseAmount(s)).toBe(n));

  it("parses prices only with an explicit currency marker", () => {
    expect(parsePrice("$1,250.00")).toEqual({ price: 1250, currency: "USD" });
    expect(parsePrice("65.00 USD")).toEqual({ price: 65, currency: "USD" });
    expect(parsePrice("€310")).toEqual({ price: 310, currency: "EUR" });
    expect(parsePrice("1.250.000 ₫")).toEqual({ price: 1_250_000, currency: "VND" });
    expect(parsePrice("Price on request")).toBeNull();
    expect(parsePrice("15 mm across")).toBeNull();
  });

  it("parses lengths in inches, cm and mm", () => {
    expect(parseLengthInches('18"')).toBe(18);
    expect(parseLengthInches("16 inches")).toBe(16);
    expect(parseLengthInches("45 cm")).toBe(17.7);
    expect(parseLengthInches("An 81 cm opera-length chain")).toBe(31.9);
    expect(parseLengthInches("no length")).toBeNull();
  });
});

describe("normaliseProduct", () => {
  it("builds contract attributes and flags what is missing instead of guessing", () => {
    const s = normaliseProduct(raw({ title: "Vela Emerald Statement Pendant", price: 520, currency: "USD", images: ["https://s.test/1.jpg"], length: "18 in", stone: "Emerald" }));
    expect(s.complete).toBe(false);
    expect(s.missing).toEqual(["metal"]);
    expect(s.attributes).toMatchObject({ category: "necklace", stone: "emerald", necklace_length_in: 18, necklace_style: "large_stone", vto_spec_ok: false, occasions: [] });
    expect(s.attributes.metal).toBeUndefined();
    expect(toCatalogSku(s, "store", "id")).toBeNull();
  });

  it("produces a valid CatalogSku when complete", () => {
    const s = normaliseProduct(raw({ title: "Luna Small Hoops", price: 65, currency: "usd", images: ["https://s.test/1.jpg"], metal: "Sterling Silver" }));
    expect(toCatalogSku(s, "store-1", "sku-1")).toMatchObject({
      id: "sku-1",
      storeId: "store-1",
      category: "earring",
      price: 65,
      currency: "USD",
      attributes: { metal: "silver", metal_tone: "cool", earring_shape: "hoop_small_medium", vto_image: "https://s.test/1.jpg" },
    });
  });

  it("reports coverage of metal, price and images", () => {
    const a = normaliseProduct(raw({ title: "A Ring", price: 1, currency: "USD", images: ["i"], metal: "Platinum" }));
    const b = normaliseProduct(raw({ title: "B Ring", price: null, images: ["i"], metal: "Platinum" }));
    expect(coverage([a, b])).toEqual({ total: 2, withMetal: 2, withPrice: 1, withImages: 2, withAll3: 1, ratio: 0.5 });
  });
});

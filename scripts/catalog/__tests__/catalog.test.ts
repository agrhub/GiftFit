import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { EARRING_SHAPES, METALS, NECKLACE_STYLES, OCCASIONS, type CatalogSku, type MetalVariant } from "@/lib/contracts/giftfit";
import { buildCatalog, STORE } from "../build";
import { PRICE_BANDS, priceBand } from "../materials";
import { CATEGORIES, expectedTone, validateCatalog } from "../validate";

const ROOT = path.resolve(__dirname, "../../..");
const skus = JSON.parse(readFileSync(path.join(ROOT, "data/aurum/catalog.json"), "utf8")) as CatalogSku[];
const store = JSON.parse(readFileSync(path.join(ROOT, "data/aurum/store.json"), "utf8"));
const byCat = (c: string) => skus.filter((s) => s.category === c);
const vectorOf = (s: CatalogSku) => `/catalog/aurum/${String(s.attributes.sku).toLowerCase()}.png`;

describe("Aurum catalog: schema and vocabulary", () => {
  it("validates every SKU against lib/contracts/giftfit.ts", () => {
    expect(validateCatalog(skus)).toEqual([]);
  });

  it("has 120-200 SKUs with earrings and necklaces as the largest groups", () => {
    expect(skus.length).toBeGreaterThanOrEqual(120);
    expect(skus.length).toBeLessThanOrEqual(200);
    const n = Object.fromEntries(CATEGORIES.map((c) => [c, byCat(c).length]));
    for (const c of ["ring", "bracelet", "watch"]) {
      expect(n.earring).toBeGreaterThan(n[c]);
      expect(n.necklace).toBeGreaterThan(n[c]);
    }
  });

  it("belongs to the Aurum Jewelry store with deterministic ids", () => {
    expect(store.name).toBe("Aurum Jewelry");
    for (const s of skus) expect(s.storeId).toBe(store.id);
    const rebuilt = buildCatalog().map((b) => b.sku);
    expect(rebuilt.map((s) => [s.id, s.title, s.price, s.attributes.metal])).toEqual(skus.map((s) => [s.id, s.title, s.price, s.attributes.metal]));
    expect(STORE.id).toBe(store.id);
  });

  it("keeps metal_tone consistent with metal", () => {
    for (const s of skus) expect(s.attributes.metal_tone, String(s.attributes.sku)).toBe(expectedTone(s.attributes.metal));
  });

  it("uses every metal, every earring shape and every necklace style", () => {
    expect(new Set(skus.map((s) => s.attributes.metal))).toEqual(new Set(METALS));
    // >= 3 per token (AUR-EAR-042 moved from chandelier_short to chandelier to match its photo, ADR-018)
    for (const t of EARRING_SHAPES) expect(byCat("earring").filter((s) => s.attributes.earring_shape === t).length, t).toBeGreaterThanOrEqual(3);
    for (const t of NECKLACE_STYLES) expect(byCat("necklace").filter((s) => s.attributes.necklace_style === t).length, t).toBeGreaterThanOrEqual(4);
  });

  it("covers necklace length classes used by the face-shape rules", () => {
    const lens = byCat("necklace").map((s) => s.attributes.necklace_length_in as number);
    expect(lens.filter((l) => l <= 16).length).toBeGreaterThanOrEqual(5); // Round avoid / Heart, Oblong recommended
    expect(lens.filter((l) => l >= 16 && l <= 19).length).toBeGreaterThanOrEqual(5); // Heart recommended
    expect(lens.filter((l) => l >= 20).length).toBeGreaterThanOrEqual(5); // Round recommended
    expect(lens.filter((l) => l >= 22).length).toBeGreaterThanOrEqual(5); // Triangle acceptable
  });

  it("has recommended and avoid earring candidates for every face shape (jewelry_rules.md Table 2a)", () => {
    const has = (t: string) => byCat("earring").some((s) => s.attributes.earring_shape === t);
    const rules: Record<string, { rec: string[]; avoid: string[] }> = {
      Round: { rec: ["drop_long_narrow", "drop_teardrop"], avoid: ["hoop_round_large", "stud_statement"] },
      Oval: { rec: ["stud_small", "hoop_small_medium"], avoid: ["drop_long_narrow"] },
      Square: { rec: ["hoop_round_large", "hoop_oval_curved", "drop_teardrop"], avoid: ["geometric_angular"] },
      Heart: { rec: ["drop_teardrop", "drop_wide_bottom", "chandelier"], avoid: ["stud_statement"] },
      InvTriangle: { rec: ["drop_teardrop", "drop_wide_bottom"], avoid: ["stud_statement"] },
      Oblong: { rec: ["hoop_round_large", "stud_statement"], avoid: ["drop_long_narrow"] },
      Diamond: { rec: ["stud_small", "hoop_small_medium", "drop_teardrop"], avoid: ["geometric_angular"] },
      Triangle: { rec: ["drop_long_narrow", "stud_statement"], avoid: ["drop_wide_bottom"] },
    };
    for (const [shape, r] of Object.entries(rules)) {
      for (const t of [...r.rec, ...r.avoid]) expect(has(t), `${shape}: ${t}`).toBe(true);
    }
  });
});

describe("Aurum catalog: price bands, undertones, occasions", () => {
  it("has at least 3 SKUs per category per price band (A3 decoys)", () => {
    for (const c of CATEGORIES)
      for (const b of PRICE_BANDS) {
        const n = byCat(c).filter((s) => priceBand(s.price) === b.id).length;
        expect(n, `${c} ${b.id}`).toBeGreaterThanOrEqual(3);
      }
    for (const s of skus) expect(s.attributes.price_band).toBe(priceBand(s.price));
  });

  it("offers warm, cool and neutral metals in every category, and warm and cool in every band", () => {
    for (const c of CATEGORIES) {
      const tones = new Set(byCat(c).map((s) => s.attributes.metal_tone));
      expect(tones, c).toEqual(new Set(["warm", "cool", "neutral"]));
      for (const b of PRICE_BANDS) {
        const t = new Set(byCat(c).filter((s) => priceBand(s.price) === b.id).map((s) => s.attributes.metal_tone));
        expect(t.has("warm") && t.has("cool"), `${c} ${b.id}`).toBe(true);
      }
    }
  });

  it("covers every occasion in every category", () => {
    for (const c of CATEGORIES) for (const o of OCCASIONS) expect(byCat(c).filter((s) => s.attributes.occasions.includes(o)).length, `${c} ${o}`).toBeGreaterThanOrEqual(3);
  });

  it("includes men's watches and unisex pieces", () => {
    expect(byCat("watch").filter((s) => s.attributes.gender_presentation === "masculine").length).toBeGreaterThanOrEqual(8);
    for (const c of CATEGORIES) expect(byCat(c).some((s) => s.attributes.gender_presentation === "unisex"), c).toBe(true);
  });

  it("uses invented names only (no real jewelry or watch brands)", () => {
    const banned = /tiffany|cartier|bulgari|bvlgari|pandora|swarovski|rolex|omega|cartier|chopard|van cleef|harry winston|david yurman|mejuri|monica vinader|seiko|casio|tissot|longines|patek|audemars|submariner|datejust|daytona|speedmaster|seamaster|santos|alhambra|serpenti|juste un clou|royal oak|nautilus|reverso|kay jewel|zales|blue nile|giva|motek/i;
    for (const s of skus) {
      expect(s.title).not.toMatch(banned);
      expect(String(s.attributes.description)).not.toMatch(banned);
    }
  });
});

describe("Aurum catalog: images", () => {
  it("has one 1024 px vector PNG per SKU and every listed image on disk, under the repo size budget", async () => {
    let total = 0;
    const files = new Set<string>();
    for (const s of skus) {
      for (const img of [...s.images, s.attributes.vto_image, vectorOf(s)]) files.add(img);
      expect(s.images, String(s.attributes.sku)).toContain(vectorOf(s));
    }
    for (const img of files) {
      const file = path.join(ROOT, "public", img);
      expect(existsSync(file), file).toBe(true);
      total += statSync(file).size;
    }
    expect(total).toBeLessThan(15 * 1024 * 1024);
    for (const s of skus.filter((_, i) => i % 20 === 0)) {
      const meta = await sharp(path.join(ROOT, "public", vectorOf(s))).metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(["png", 1024, 1024]);
    }
  });

  it("records spec status and anchor points per image", () => {
    const key = { earring: "earring_anchor_point", necklace: "necklace_anchor_point", ring: "ring_anchor_point", bracelet: "bracelet_anchor_point", watch: "watch_anchor_point" } as const;
    for (const s of skus) {
      const a = s.attributes;
      expect(typeof a.vto_spec_ok).toBe("boolean");
      // anchors belong to the vector render: on vto_params when the vector is the try-on image, else on the fallback
      const params = (a.vto_image === vectorOf(s) ? a.vto_params : a.vto_params_fallback) as Record<string, unknown> | undefined;
      expect(params?.[key[s.category]], String(a.sku)).toBeDefined();
      if (!a.vto_spec_ok) expect(a.vto_spec_issues).toBeDefined();
    }
    expect(skus.filter((s) => s.attributes.vto_spec_ok).length / skus.length).toBeGreaterThan(0.9);
  });
});

describe("Aurum catalog: photo-real images (ADR-018)", () => {
  const photoSkus = skus.filter((s) => s.attributes.photo_image);
  const PHOTO_SKUS = ["AUR-EAR-028", "AUR-EAR-038", "AUR-EAR-034", "AUR-EAR-042", "AUR-EAR-002", "AUR-NEC-037", "AUR-NEC-021", "AUR-NEC-009", "AUR-NEC-017", "AUR-RNG-005", "AUR-BRC-003", "AUR-WCH-002"];

  it("wires exactly the 12 demo-critical SKUs, photo first, vector kept as fallback", () => {
    expect(photoSkus.map((s) => s.attributes.sku).sort()).toEqual([...PHOTO_SKUS].sort());
    for (const s of photoSkus) {
      const a = s.attributes;
      // Chime Bell's default photo is its yellow gold edit (default switched from rose, A3 demo-leak fix)
      const expected = a.sku === "AUR-EAR-034" ? "/catalog/aurum/photo/variants/aur-ear-034-yellow_gold.jpg" : `/catalog/aurum/photo/${String(a.sku).toLowerCase()}.jpg`;
      expect(a.photo_image).toBe(expected);
      expect(s.images[0]).toBe(a.photo_image);
      expect(s.images).toContain(vectorOf(s));
      expect(typeof a.photo_vto_spec_ok).toBe("boolean");
      expect(a.image_source).toBe("ai_photo");
      if (a.photo_vto_spec_ok) {
        expect(a.vto_image).toBe(a.photo_image);
        expect(a.vto_image_fallback).toBe(vectorOf(s));
        expect(a.vto_spec_ok).toBe(true);
      } else {
        expect(a.vto_image).toBe(vectorOf(s));
        expect(a.photo_vto_spec_issues).toBeDefined();
      }
    }
  });

  it("uses all 12 photos for try-on; replaced photos keep v1 archived", () => {
    const get = (code: string) => photoSkus.find((x) => x.attributes.sku === code)!;
    expect(photoSkus.filter((s) => s.attributes.photo_vto_spec_ok).length).toBe(12);
    for (const [code, version] of [
      ["AUR-NEC-009", "v2"],
      ["AUR-BRC-003", "v2"],
      ["AUR-NEC-017", "v3"],
    ]) {
      const s = get(code);
      expect(s.attributes.vto_image, code).toBe(s.attributes.photo_image);
      expect(s.attributes.photo_recheck).toBeUndefined();
      expect(s.attributes.photo_version).toBe(version);
      expect(existsSync(path.join(ROOT, "public", String(s.attributes.photo_v1_image)))).toBe(true);
    }
    // rigid collar: anchors are the two open tips measured on the photo; the vector's anchors stay as fallback
    const choker = get("AUR-NEC-017").attributes;
    expect(choker.vto_params).toEqual({ necklace_anchor_point: [[304, 178], [718, 178]] });
    expect((choker.vto_params_fallback as Record<string, unknown>).necklace_anchor_point).toBeDefined();
    expect(get("AUR-EAR-028").attributes.vto_image).toBe("/catalog/aurum/photo/aur-ear-028.jpg");
  });

  it("stores 1024 px JPEG photos", async () => {
    for (const s of photoSkus) {
      const meta = await sharp(path.join(ROOT, "public", String(s.attributes.photo_image))).metadata();
      expect([meta.format, meta.width, meta.height], String(s.attributes.sku)).toEqual(["jpeg", 1024, 1024]);
    }
  });
});

describe("Aurum catalog: metal variants (ADR-032/034)", () => {
  // ADR-034 + ADR-035: 9 three-metal designs (default metal first)
  const SETS: Record<string, string[]> = {
    "AUR-EAR-028": ["yellow_gold", "white_gold", "rose_gold"],
    "AUR-EAR-038": ["white_gold", "yellow_gold", "rose_gold"],
    "AUR-EAR-034": ["yellow_gold", "rose_gold", "white_gold"],
    "AUR-EAR-042": ["yellow_gold", "white_gold", "rose_gold"],
    "AUR-EAR-002": ["silver", "yellow_gold", "rose_gold"],
    "AUR-NEC-037": ["white_gold", "yellow_gold", "rose_gold"],
    "AUR-NEC-009": ["rose_gold", "yellow_gold", "silver"],
    "AUR-NEC-021": ["yellow_gold", "white_gold", "rose_gold"],
    "AUR-NEC-017": ["yellow_gold", "white_gold", "rose_gold"],
  };
  const vs = (s: CatalogSku) => s.variants ?? [];

  it("gives every SKU variants, with variants[0] mirroring the default listing", () => {
    for (const s of skus) {
      expect(vs(s).length, String(s.attributes.sku)).toBeGreaterThanOrEqual(1);
      const v0 = vs(s)[0];
      expect([v0.metal, v0.price, v0.vto_image, v0.images]).toEqual([s.attributes.metal, s.price, s.attributes.vto_image, s.images]);
    }
  });

  it("uses unique, stable variantIds (<skuId>:<metal>)", () => {
    const ids = skus.flatMap((s) => vs(s).map((v) => v.variantId));
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of skus) for (const v of vs(s)) expect(v.variantId).toBe(`${s.id}:${v.metal}`);
  });

  it("carries NEC-017's open-tip anchors to its metal variants (same v3 geometry)", () => {
    const s = skus.find((x) => x.attributes.sku === "AUR-NEC-017")!;
    for (const v of vs(s)) expect((v as MetalVariant & { vto_params?: unknown }).vto_params, v.variantId).toEqual({ necklace_anchor_point: [[304, 178], [718, 178]] });
  });

  it("keeps metal_tone consistent with metal and every variant image on disk", () => {
    for (const s of skus)
      for (const v of vs(s)) {
        expect(v.metal_tone, v.variantId).toBe(expectedTone(v.metal));
        for (const img of new Set([...v.images, v.vto_image])) expect(existsSync(path.join(ROOT, "public", img)), img).toBe(true);
      }
  });

  it("has exactly the specified metal sets for the 6 designs and one variant elsewhere", () => {
    for (const s of skus) {
      const want = SETS[String(s.attributes.sku)];
      expect(vs(s).map((v) => v.metal), String(s.attributes.sku)).toEqual(want ?? [s.attributes.metal]);
    }
    for (const code of Object.keys(SETS)) {
      const s = skus.find((x) => x.attributes.sku === code)!;
      for (const v of vs(s).slice(1)) {
        const own = code === "AUR-EAR-034" && v.metal === "rose_gold" ? "/catalog/aurum/photo/aur-ear-034.jpg" : `/catalog/aurum/photo/variants/${code.toLowerCase()}-${v.metal}.jpg`;
        expect(v.vto_image).toBe(own);
        expect(v.vto_spec_ok, v.variantId).toBe(true);
      }
    }
  });

  it("keeps one karat per design and prices metals consistently (white >= yellow, rose ~ yellow)", () => {
    const karat = (m: unknown) => /^(\d+k)(?=\s)/.exec(String(m))?.[1];
    for (const code of Object.keys(SETS)) {
      const s = skus.find((x) => x.attributes.sku === code)!;
      const golds = vs(s).filter((v) => v.metal.endsWith("_gold")) as (MetalVariant & { material: string })[];
      const karats = new Set(golds.map((v) => karat(v.material)));
      expect(karats.size, `${code} karats ${[...karats].join(",")}`).toBe(1);
      expect([...karats][0]).toBeDefined();
      const price = (m: string) => golds.find((v) => v.metal === m)?.price;
      const y = price("yellow_gold");
      const w = price("white_gold");
      const r = price("rose_gold");
      if (y && w) {
        expect(w, code).toBeGreaterThanOrEqual(y);
        expect(w / y, code).toBeLessThanOrEqual(1.1);
      }
      if (y && r) expect(Math.abs(r / y - 1), code).toBeLessThanOrEqual(0.05);
    }
  });

  it("prices silver below gold within a design, keeps defaults unchanged and spans the $300 cap", () => {
    for (const s of skus) {
      const silver = vs(s).filter((v) => v.metal === "silver");
      const gold = vs(s).filter((v) => v.metal.endsWith("_gold"));
      for (const sv of silver) for (const g of gold) expect(sv.price, s.title).toBeLessThan(g.price * 0.6);
    }
    const halo = skus.find((x) => x.attributes.sku === "AUR-EAR-028")!;
    expect(halo.price).toBe(245);
    expect(vs(halo).every((v) => v.price <= 300)).toBe(true);
    // demo shortlist (Halo + Reverie + Chime): Chime's default is yellow gold so no single rose default stands out
    const chime = skus.find((x) => x.attributes.sku === "AUR-EAR-034")!;
    expect([chime.attributes.metal, chime.attributes.metal_tone, chime.price, vs(chime)[0].metal]).toEqual(["yellow_gold", "warm", 259, "yellow_gold"]);
    expect(chime.attributes.vto_image).toBe("/catalog/aurum/photo/variants/aur-ear-034-yellow_gold.jpg");
    const designs = Object.keys(SETS).map((code) => skus.find((x) => x.attributes.sku === code)!);
    expect(designs.filter((d) => vs(d).every((v) => v.price <= 300)).length).toBeGreaterThanOrEqual(5);
    expect(designs.filter((d) => vs(d).some((v) => v.price <= 300) && vs(d).some((v) => v.price > 300)).length).toBeGreaterThanOrEqual(2);
    const extra = Object.keys(SETS).flatMap((code) => vs(skus.find((x) => x.attributes.sku === code)!).slice(1));
    expect(extra.some((v) => v.price > 300)).toBe(true);
    expect(extra.some((v) => v.price < 300)).toBe(true);
  });
});

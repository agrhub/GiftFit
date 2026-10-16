/**
 * Metal variants (ADR-032 / ADR-034 / ADR-035). Every SKU gets `variants` (length >= 1); variants[0] is the existing default
 * listing and mirrors the top-level price / attributes.metal / images / vto_image. Six demo designs gain extra
 * metals whose photos are Flow edit-mode copies of the team's own photo ("change only the metal"), stored in
 * public/catalog/aurum/photo/variants/<sku>-<metal>.jpg (provenance: data/aurum/photo-inbox/variants/PROVENANCE.md).
 *
 * Pricing (USD; reasoning in docs/reports/A2.md "Metal variants" and "Variant batch 2"): see EXTRA_METALS.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { CatalogSku, Metal, MetalVariant } from "@/lib/contracts/giftfit";
import { priceBand, toneOf, type PriceBandId } from "./materials";
import { checkVtoSpec } from "./spec-check";

/** Contract MetalVariant plus catalog extras (requested as optional contract fields in A2.md). */
export type AurumVariant = MetalVariant & {
  material: string;
  price_band: PriceBandId;
  image_source: "ai_photo" | "vector" | "ai_photo_edit";
  vto_image_fallback?: string;
  /** YouCam anchor points for this variant's vto_image, when known (1024 px image space). */
  vto_params?: Record<string, number[] | number[][]>;
};

export interface ExtraMetal {
  metal: Metal;
  price: number;
  material: string;
  /** Photo path when it is not the standard variants/<sku>-<metal>.jpg. */
  photo?: string;
}

/**
 * Exactly the ADR-034 + ADR-035 sets (the default metal is the SKU's current metal): 9 three-metal designs.
 * Price rule (ADR-035, one karat per design): every gold variant uses the default's karat (10k here; AUR-EAR-002,
 * whose default is sterling, offers its golds in 14k); white gold = yellow + ~6-8% (rhodium plating),
 * rose gold = yellow (within ~2%), sterling silver = 35-55% of the gold price of the same design.
 */
export const EXTRA_METALS: Record<string, ExtraMetal[]> = {
  // 10k, all three <= $300 (demo hero: "Halo Drop in white gold, $265")
  "AUR-EAR-028": [
    { metal: "white_gold", price: 265, material: "10k white gold" },
    { metal: "rose_gold", price: 249, material: "10k rose gold" },
  ],
  // 10k, default white gold $245 -> yellow/rose $229
  "AUR-EAR-038": [
    { metal: "yellow_gold", price: 229, material: "10k yellow gold" },
    { metal: "rose_gold", price: 229, material: "10k rose gold" },
  ],
  // 10k, default yellow gold $259 (was rose; A3 demo-leak fix). Rose keeps the original ADR-018 photo.
  "AUR-EAR-034": [
    { metal: "rose_gold", price: 259, material: "10k rose gold", photo: "/catalog/aurum/photo/aur-ear-034.jpg" },
    { metal: "white_gold", price: 275, material: "10k white gold" },
  ],
  // 10k, default yellow gold $259
  "AUR-EAR-042": [
    { metal: "white_gold", price: 275, material: "10k white gold" },
    { metal: "rose_gold", price: 259, material: "10k rose gold" },
  ],
  // default sterling silver $198; golds in 14k, silver = 47% of gold; golds are above a $300 cap
  "AUR-EAR-002": [
    { metal: "yellow_gold", price: 425, material: "14k yellow gold" },
    { metal: "rose_gold", price: 425, material: "14k rose gold" },
  ],
  // 10k, default white gold $215 -> yellow/rose $199 (was 14k $335 in batch 1: karat aligned, ADR-035)
  "AUR-NEC-037": [
    { metal: "yellow_gold", price: 199, material: "10k yellow gold" },
    { metal: "rose_gold", price: 199, material: "10k rose gold" },
  ],
  // 10k, default rose gold $259; silver = 42% of gold
  "AUR-NEC-009": [
    { metal: "yellow_gold", price: 259, material: "10k yellow gold" },
    { metal: "silver", price: 109, material: "sterling silver" },
  ],
  // 10k, default yellow gold $245
  "AUR-NEC-021": [
    { metal: "white_gold", price: 265, material: "10k white gold" },
    { metal: "rose_gold", price: 245, material: "10k rose gold" },
  ],
  // 10k, default yellow gold $289; white gold crosses a $300 cap
  "AUR-NEC-017": [
    { metal: "white_gold", price: 309, material: "10k white gold" },
    { metal: "rose_gold", price: 289, material: "10k rose gold" },
  ],
};

/** Variants whose photo keeps the default photo's geometry, so its anchor points carry over (v3 open-U collar). */
const SHARED_ANCHORS = new Set(["AUR-NEC-017"]);

export const variantId = (skuId: string, metal: Metal) => `${skuId}:${metal}`;
export const variantPhoto = (sku: string, metal: Metal) => `/catalog/aurum/photo/variants/${sku.toLowerCase()}-${metal}.jpg`;

/** Adds `variants` to every SKU. Returns the per-photo spec outcomes of the extra variants. */
export async function applyVariants(skus: CatalogSku[], root = process.cwd()): Promise<{ id: string; ok: boolean; issues: string[] }[]> {
  const outcomes: { id: string; ok: boolean; issues: string[] }[] = [];
  for (const sku of skus) {
    const a = sku.attributes;
    const base: AurumVariant = {
      variantId: variantId(sku.id, a.metal),
      metal: a.metal,
      metal_tone: a.metal_tone,
      price: sku.price,
      images: [...sku.images],
      vto_image: a.vto_image,
      vto_spec_ok: a.vto_spec_ok,
      material: String(a.material),
      price_band: priceBand(sku.price),
      image_source: a.photo_image ? "ai_photo" : "vector",
      ...(a.vto_image_fallback ? { vto_image_fallback: String(a.vto_image_fallback) } : {}),
      ...(a.vto_params ? { vto_params: a.vto_params as AurumVariant["vto_params"] } : {}),
    };
    const variants: AurumVariant[] = [base];
    for (const x of EXTRA_METALS[String(a.sku)] ?? []) {
      if (x.metal === a.metal) throw new Error(`${a.sku}: extra metal ${x.metal} duplicates the default`);
      const rel = x.photo ?? variantPhoto(String(a.sku), x.metal);
      const file = path.join(root, "public", rel);
      if (!existsSync(file)) throw new Error(`missing variant photo ${file}`);
      const check = await checkVtoSpec(readFileSync(file), sku.category, { photo: true });
      // all 10 edit-mode photos were reviewed by eye (A2, 2026-10-15): same design, stones, framing and spec pose
      // as the default photo, metal changed only, so the pixel check decides vto_spec_ok
      const v: AurumVariant = {
        variantId: variantId(sku.id, x.metal),
        metal: x.metal,
        metal_tone: toneOf(x.metal),
        price: x.price,
        images: [rel],
        vto_image: rel,
        vto_spec_ok: check.ok,
        material: x.material,
        price_band: priceBand(x.price),
        image_source: "ai_photo_edit",
        // Flow edit mode kept size and position, so the default photo's anchors apply (checked by eye: same tips)
        ...(SHARED_ANCHORS.has(String(a.sku)) && base.vto_params ? { vto_params: base.vto_params } : {}),
      };
      variants.push(v);
      outcomes.push({ id: v.variantId, ok: check.ok, issues: check.reasons });
    }
    sku.variants = variants;
  }
  return outcomes;
}

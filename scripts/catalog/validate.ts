/**
 * Validates catalog rows against the binding vocabulary in server/contracts/giftfit.ts.
 * Used by server/db/seed.ts (before any write) and by the catalog tests.
 */
import { z } from "zod";
import { EARRING_SHAPES, METALS, NECKLACE_STYLES, OCCASIONS, type CatalogSku, type Metal, type MetalTone } from "@/server/contracts/giftfit";

export const CATEGORIES = ["earring", "necklace", "ring", "bracelet", "watch"] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const anchor = z.union([z.array(z.number().int()).length(2), z.array(z.array(z.number().int()).length(2)).min(2).max(4)]);

const attributes = z
  .object({
    category: z.enum(CATEGORIES),
    metal: z.enum(METALS),
    metal_tone: z.enum(["warm", "neutral", "cool"]),
    style: z.string().min(1),
    stone: z.string().min(1),
    earring_shape: z.enum(EARRING_SHAPES).optional(),
    necklace_style: z.enum(NECKLACE_STYLES).optional(),
    necklace_length_in: z.number().min(12).max(40).optional(),
    gender_presentation: z.enum(["feminine", "masculine", "unisex"]),
    occasions: z.array(z.enum(OCCASIONS)).min(1),
    vto_spec_ok: z.boolean(),
    vto_image: z.string().regex(/^\/catalog\/aurum\/(?:[a-z0-9-]+\.png|photo\/(?:variants\/)?[a-z0-9_-]+\.jpg)$/),
    vto_image_fallback: z.string().regex(/^\/catalog\/aurum\/[a-z0-9-]+\.png$/).optional(),
    photo_image: z.string().regex(/^\/catalog\/aurum\/photo\/(?:variants\/)?[a-z0-9_-]+\.jpg$/).optional(),
    photo_vto_spec_ok: z.boolean().optional(),
    vto_params: z.record(z.string(), anchor).optional(),
    sku: z.string().regex(/^AUR-(EAR|NEC|RNG|BRC|WCH)-\d{3}$/),
    slug: z.string().regex(/^[a-z0-9-]+$/),
    price_band: z.enum(["under_100", "100_300", "300_800", "over_800"]),
  })
  .passthrough();

const IMG = /^\/catalog\/aurum\/(?:[a-z0-9-]+\.png|photo\/[a-z0-9-]+\.jpg|photo\/variants\/[a-z0-9_-]+\.jpg)$/;

export const metalVariantSchema = z
  .object({
    variantId: z.string().min(1),
    metal: z.enum(METALS),
    metal_tone: z.enum(["warm", "neutral", "cool"]),
    price: z.number().positive(),
    images: z.array(z.string().regex(IMG)).min(1),
    vto_image: z.string().regex(IMG),
    vto_spec_ok: z.boolean(),
  })
  .passthrough();

export const catalogSkuSchema = z.object({
  id: z.string().regex(UUID),
  storeId: z.string().regex(UUID),
  title: z.string().min(3),
  category: z.enum(CATEGORIES),
  price: z.number().positive(),
  currency: z.literal("USD"),
  images: z.array(z.string().min(1)).min(1),
  attributes,
  sourceUrl: z.string().optional(),
  variants: z.array(metalVariantSchema).min(1),
});

export function expectedTone(metal: Metal): MetalTone {
  if (metal === "yellow_gold" || metal === "rose_gold") return "warm";
  if (metal === "mixed_two_tone") return "neutral";
  return "cool";
}

/** Returns human-readable problems; empty means the catalog is valid. */
export function validateCatalog(rows: unknown): string[] {
  const problems: string[] = [];
  if (!Array.isArray(rows)) return ["catalog is not an array"];
  const ids = new Set<string>();
  const skus = new Set<string>();
  const slugs = new Set<string>();
  const variantIds = new Set<string>();
  rows.forEach((row, i) => {
    const r = catalogSkuSchema.safeParse(row);
    if (!r.success) {
      problems.push(`#${i}: ${r.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ")}`);
      return;
    }
    const s = r.data as unknown as CatalogSku;
    const a = s.attributes;
    const tag = String(a.sku);
    if (ids.has(s.id)) problems.push(`${tag}: duplicate id`);
    if (skus.has(tag)) problems.push(`${tag}: duplicate sku`);
    if (slugs.has(String(a.slug))) problems.push(`${tag}: duplicate slug`);
    ids.add(s.id);
    skus.add(tag);
    slugs.add(String(a.slug));
    if (a.category !== s.category) problems.push(`${tag}: attributes.category != category`);
    if (a.metal_tone !== expectedTone(a.metal)) problems.push(`${tag}: metal_tone ${a.metal_tone} inconsistent with ${a.metal}`);
    if (s.category === "earring" && !a.earring_shape) problems.push(`${tag}: earring without earring_shape`);
    if (s.category !== "earring" && a.earring_shape) problems.push(`${tag}: earring_shape on a ${s.category}`);
    if (s.category === "necklace" && (!a.necklace_style || !a.necklace_length_in)) problems.push(`${tag}: necklace without style/length`);
    if (s.category !== "necklace" && (a.necklace_style || a.necklace_length_in)) problems.push(`${tag}: necklace fields on a ${s.category}`);
    if (new Set(a.occasions).size !== a.occasions.length) problems.push(`${tag}: duplicate occasions`);
    if (!s.images.includes(a.vto_image)) problems.push(`${tag}: vto_image not in images`);
    const vs = s.variants ?? [];
    const v0 = vs[0];
    if (v0 && (v0.metal !== a.metal || v0.price !== s.price || v0.vto_image !== a.vto_image || JSON.stringify(v0.images) !== JSON.stringify(s.images) || v0.vto_spec_ok !== a.vto_spec_ok))
      problems.push(`${tag}: variants[0] does not mirror the default listing`);
    const metals = new Set<string>();
    for (const v of vs) {
      if (v.variantId !== `${s.id}:${v.metal}`) problems.push(`${tag}: variantId ${v.variantId} is not <skuId>:<metal>`);
      if (variantIds.has(v.variantId)) problems.push(`${tag}: duplicate variantId ${v.variantId}`);
      variantIds.add(v.variantId);
      if (metals.has(v.metal)) problems.push(`${tag}: duplicate variant metal ${v.metal}`);
      metals.add(v.metal);
      if (v.metal_tone !== expectedTone(v.metal)) problems.push(`${tag}: variant ${v.metal} has metal_tone ${v.metal_tone}`);
      if (!v.images.includes(v.vto_image)) problems.push(`${tag}: variant ${v.metal} vto_image not in its images`);
    }
    if (a.photo_image !== undefined) {
      if (s.images[0] !== a.photo_image) problems.push(`${tag}: photo is not images[0]`);
      if (typeof a.photo_vto_spec_ok !== "boolean") problems.push(`${tag}: photo without photo_vto_spec_ok`);
      if (a.photo_vto_spec_ok && a.vto_image !== a.photo_image) problems.push(`${tag}: spec-ok photo is not the vto_image`);
      if (!a.photo_vto_spec_ok && a.vto_image === a.photo_image) problems.push(`${tag}: photo failing the spec is used as vto_image`);
    }
  });
  return problems;
}

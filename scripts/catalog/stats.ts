/**
 * Prints catalog distribution counts (category, price band, metal, tone, occasion, tokens, gender).
 *   npx tsx scripts/catalog/stats.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { CatalogSku } from "@/server/contracts/giftfit";

export function catalogStats(skus: CatalogSku[]): Record<string, number> {
  const t: Record<string, number> = {};
  const inc = (k: string) => (t[k] = (t[k] ?? 0) + 1);
  for (const sku of skus) {
    const a = sku.attributes;
    inc(`category:${sku.category}`);
    inc(`band:${sku.category}:${String(a.price_band)}`);
    inc(`metal:${sku.category}:${a.metal}`);
    inc(`tone:${sku.category}:${a.metal_tone}`);
    inc(`gender:${sku.category}:${a.gender_presentation}`);
    inc(`style:${a.style}`);
    for (const o of a.occasions) inc(`occasion:${sku.category}:${o}`);
    if (a.earring_shape) inc(`earring_shape:${a.earring_shape}`);
    if (a.necklace_style) inc(`necklace_style:${a.necklace_style}`);
    if (a.necklace_length_in) inc(`necklace_length_in:${a.necklace_length_in}`);
    inc(`vto_spec_ok:${a.vto_spec_ok}`);
  }
  return t;
}

if (process.argv[1] && /stats\.ts$/.test(process.argv[1])) {
  const file = path.join(process.cwd(), "fixtures/aurum/catalog.json");
  const skus = JSON.parse(readFileSync(file, "utf8")) as CatalogSku[];
  const t = catalogStats(skus);
  console.log(`${skus.length} SKUs`);
  for (const [k, v] of Object.entries(t).sort()) console.log(`${k}\t${v}`);
}

/**
 * Generates the Aurum Jewelry demo catalog: renders every product image from code (SVG -> sharp),
 * checks it against the YouCam 2d-vto product spec, and writes
 *   public/catalog/aurum/<sku>.png   (1024 px, pure white background, one product)
 *   fixtures/aurum/catalog.json          (CatalogSku[], deterministic ids)
 *   fixtures/aurum/store.json            (the Aurum Jewelry store row)
 *   + wires the photo-real images in public/catalog/aurum/photo/ (scripts/catalog/photos.ts, ADR-018)
 *   + adds metal variants to every SKU (scripts/catalog/variants.ts, ADR-032/034)
 * Usage: npx tsx scripts/catalog/generate.ts [--only=AUR-EAR-001,...] [--data-only]
 *   --data-only  rebuild catalog.json from the tables without re-rendering: anchor points are reused from the
 *                current catalog.json and the existing vector PNGs are re-checked (seconds instead of minutes).
 * Spends 0 YouCam units. Images are CC0 by the team (docs/LICENSES.md).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildCatalog, STORE, type BuiltSku } from "./build";
import type { CatalogSku } from "@/server/contracts/giftfit";
import { composeImage } from "./compose";
import { applyPhotos } from "./photos";
import { applyVariants } from "./variants";
import { renderDesign } from "./render";
import { checkVtoSpec } from "./spec-check";

const ROOT = process.cwd();
const IMG_DIR = path.join(ROOT, "public/catalog/aurum");
const DATA_DIR = path.join(ROOT, "fixtures/aurum");

async function renderOne(b: BuiltSku): Promise<{ bytes: number; ok: boolean; reasons: string[] }> {
  const composed = await composeImage(renderDesign(b.design));
  const check = await checkVtoSpec(composed.png, b.sku.category);
  writeFileSync(path.join(IMG_DIR, b.file), composed.png);
  const a = b.sku.attributes;
  a.vto_spec_ok = check.ok;
  a.vto_params = composed.anchors;
  if (!check.ok) a.vto_spec_issues = check.reasons;
  return { bytes: composed.png.length, ok: check.ok, reasons: check.reasons };
}

/** Reuses anchors from the current catalog.json and re-checks the existing vector PNG. */
async function reuseOne(b: BuiltSku, previous: Map<string, CatalogSku>): Promise<{ bytes: number; ok: boolean; reasons: string[] }> {
  const file = path.join(IMG_DIR, b.file);
  if (!existsSync(file)) throw new Error(`--data-only: missing ${file}; run without --data-only`);
  const png = readFileSync(file);
  const check = await checkVtoSpec(png, b.sku.category);
  const prev = previous.get(String(b.sku.attributes.sku))?.attributes;
  const a = b.sku.attributes;
  a.vto_spec_ok = check.ok;
  a.vto_params = (prev?.vto_params_fallback ?? prev?.vto_params) as typeof a.vto_params; // vector anchors live on the fallback for photo SKUs
  if (!a.vto_params) throw new Error(`--data-only: no anchors for ${a.sku}`);
  if (!check.ok) a.vto_spec_issues = check.reasons;
  return { bytes: png.length, ok: check.ok, reasons: check.reasons };
}

async function main() {
  const t0 = Date.now();
  mkdirSync(IMG_DIR, { recursive: true });
  mkdirSync(DATA_DIR, { recursive: true });
  const built = buildCatalog();
  const dataOnly = process.argv.includes("--data-only");
  const previous = new Map<string, CatalogSku>();
  if (dataOnly) {
    for (const s of JSON.parse(readFileSync(path.join(DATA_DIR, "catalog.json"), "utf8")) as CatalogSku[]) previous.set(String(s.attributes.sku), s);
  }
  const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7).split(",");
  const todo = only ? built.filter((b) => only.includes(String(b.sku.attributes.sku))) : built;
  let bytes = 0;
  const failed: string[] = [];
  const queue = [...todo];
  const worker = async () => {
    for (let b = queue.shift(); b; b = queue.shift()) {
      const r = dataOnly ? await reuseOne(b, previous) : await renderOne(b);
      bytes += r.bytes;
      if (!r.ok) failed.push(`${b.sku.attributes.sku}: ${r.reasons.join("; ")}`);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  if (only) {
    console.log(`rendered ${todo.length} image(s); catalog.json not rewritten with --only`);
    return;
  }
  const photos = await applyPhotos(built.map((b) => b.sku), ROOT);
  // must run after applyPhotos: variants[0] mirrors the final default images / vto_image
  const variantOutcomes = await applyVariants(built.map((b) => b.sku), ROOT);
  writeFileSync(path.join(DATA_DIR, "catalog.json"), `${JSON.stringify(built.map((b) => b.sku), null, 2)}\n`);
  writeFileSync(path.join(DATA_DIR, "store.json"), `${JSON.stringify(STORE, null, 2)}\n`);
  console.log(`${built.length} SKUs, ${(bytes / 1024 / 1024).toFixed(2)} MB of PNG, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  console.log(failed.length ? `vto_spec_ok=false for:\n${failed.join("\n")}` : "all vector images pass the spec check");
  for (const v of variantOutcomes) console.log(`variant ${v.id}: ${v.ok ? "vto_spec_ok" : v.issues.join("; ")}`);
  for (const p of photos) console.log(`photo ${p.sku}: pixel check ${p.pixelOk ? "ok" : p.pixelIssues.join("; ")} -> ${p.specOk ? "try-on image" : "display only"}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

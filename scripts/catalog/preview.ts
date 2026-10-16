/**
 * Dev helper: renders every variant of one category into a contact sheet.
 *   npx tsx scripts/catalog/preview.ts <category> <outFile.png>
 */
import sharp from "sharp";
import type { JewelryCategory, Metal } from "@/lib/contracts/giftfit";
import { composeImage } from "./compose";
import type { Design } from "./design";
import { renderDesign, VARIANTS } from "./render";
import { checkVtoSpec } from "./spec-check";

async function main() {
  const category = (process.argv[2] ?? "earring") as JewelryCategory;
  const out = process.argv[3] ?? "preview.png";
  const metals: Metal[] = ["yellow_gold", "white_gold", "rose_gold", "mixed_two_tone", "silver", "platinum"];
  const tiles: { input: Buffer; left: number; top: number }[] = [];
  const variants = VARIANTS[category];
  const T = 256;
  const cols = 8;
  for (let i = 0; i < variants.length; i++) {
    const d: Design = { category, variant: variants[i], metal: metals[i % metals.length], stone: (["clear", "blue", "green", "red", "purple", "sky"] as const)[i % 6], pearl: "cream", pave: "clear", lengthIn: [14, 16, 18, 20, 24, 30][i % 6], dial: ["#F4F1EA", "#1D2A44", "#0F3B2E", "#222222"][i % 4], strap: (["leather_brown", "mesh", "link", "leather_black", "canvas"] as const)[i % 5], jitter: 0.5 };
    const r = renderDesign(d);
    const c = await composeImage(r);
    const chk = await checkVtoSpec(c.png, category);
    console.log(variants[i], c.png.length, chk.ok ? "OK" : chk.reasons.join("; "), JSON.stringify(c.anchors));
    let img = sharp(c.png);
    // mark anchors
    const marks = Object.values(c.anchors).flatMap((v) => (Array.isArray(v[0]) ? (v as number[][]) : [v as number[]]));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">${marks.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="10" fill="none" stroke="#ff00ff" stroke-width="4"/>`).join("")}<text x="20" y="1000" font-size="40" fill="#999">${variants[i]}</text></svg>`;
    img = img.composite([{ input: Buffer.from(svg) }]);
    const t = await sharp(await img.png().toBuffer()).resize(T, T).png().toBuffer();
    tiles.push({ input: t, left: (i % cols) * T, top: Math.floor(i / cols) * T });
  }
  const rows = Math.ceil(variants.length / cols);
  await sharp({ create: { width: cols * T, height: rows * T, channels: 3, background: "#eeeeee" } }).composite(tiles).png().toFile(out);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * Automated, conservative check of a product render against the YouCam 2d-vto product-image spec
 * (docs/research/api_matrix.md §9). It verifies what pixels can show:
 *  - format: PNG, long side <= 4096, < 10 MB
 *  - pure white (#FFFFFF) border, so `*_need_remove_background` has a clean background
 *  - exactly one object (one connected component), so an earring image is never a pair
 *  - the object is centred and large enough to be detected
 *  - category framing: watch upright (taller than wide, straps cropped near the frame edges);
 *    ring and bracelet shown as an ellipse-like three-quarter view; necklace wider than a pendant alone.
 * The geometric pose (front view, ~45 degrees, no clasp) is guaranteed by construction in the renderers;
 * the real verification is the first paid call (docs/hackathon/first_real_calls.md).
 */
import sharp from "sharp";
import type { JewelryCategory } from "@/server/contracts/giftfit";

export interface SpecCheck {
  ok: boolean;
  reasons: string[];
  bbox: { x: number; y: number; w: number; h: number };
  components: number;
}

export interface SpecOptions {
  /**
   * Photographic (JPEG) input: the background is near-white rather than exactly #FFFFFF, so the border test
   * accepts channels >= 238 and "object" pixels are those below 228 (soft studio shadows are not objects).
   */
  photo?: boolean;
}

export async function checkVtoSpec(png: Buffer, category: JewelryCategory, opts: SpecOptions = {}): Promise<SpecCheck> {
  const INK = opts.photo ? 228 : 240; // a pixel is "object" when any channel is below this
  const WHITE = opts.photo ? 238 : 255; // minimum channel value for a background (border) pixel
  const reasons: string[] = [];
  const meta = await sharp(png).metadata();
  if (meta.format !== "png" && meta.format !== "jpeg") reasons.push(`format ${meta.format}`);
  if ((meta.width ?? 0) > 4096 || (meta.height ?? 0) > 4096) reasons.push("long side > 4096");
  if (png.length >= 10 * 1024 * 1024) reasons.push("file >= 10 MB");
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const ch = info.channels;

  // 1. pure white border (8 px)
  let borderOk = true;
  for (let y = 0; y < H && borderOk; y++) {
    for (let x = 0; x < W; x++) {
      if (y >= 8 && y < H - 8 && x >= 8 && x < W - 8) continue;
      const i = (y * W + x) * ch;
      if (data[i] < WHITE || data[i + 1] < WHITE || data[i + 2] < WHITE) {
        borderOk = false;
        break;
      }
    }
  }
  if (!borderOk) reasons.push(opts.photo ? "border is not white" : "border is not pure white");

  // 2. bounding box and connected components on a downsampled mask
  const G = 4; // cell size
  const gw = Math.ceil(W / G);
  const gh = Math.ceil(H / G);
  const mask = new Uint8Array(gw * gh);
  let minX = W;
  let minY = H;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * ch;
      if (data[i] < INK || data[i + 1] < INK || data[i + 2] < INK) {
        mask[Math.floor(y / G) * gw + Math.floor(x / G)] = 1;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  const bbox = maxX < 0 ? { x: 0, y: 0, w: 0, h: 0 } : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  // dilate by one cell so hairline gaps (chain dashes, jump rings) do not split an object
  const dil = new Uint8Array(gw * gh);
  for (let y = 0; y < gh; y++)
    for (let x = 0; x < gw; x++) {
      if (!mask[y * gw + x]) continue;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < gw && yy < gh) dil[yy * gw + xx] = 1;
        }
    }
  const seen = new Uint8Array(gw * gh);
  let components = 0;
  const parts: string[] = [];
  const stack: number[] = [];
  for (let i = 0; i < dil.length; i++) {
    if (!dil[i] || seen[i]) continue;
    let area = 0;
    let bx0 = gw, by0 = gh, bx1 = 0, by1 = 0;
    stack.push(i);
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop()!;
      area++;
      const x = j % gw;
      const y = (j - x) / gw;
      bx0 = Math.min(bx0, x);
      by0 = Math.min(by0, y);
      bx1 = Math.max(bx1, x);
      by1 = Math.max(by1, y);
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= gw || yy >= gh) continue;
        const k = yy * gw + xx;
        if (dil[k] && !seen[k]) {
          seen[k] = 1;
          stack.push(k);
        }
      }
    }
    if (area >= 12) {
      components++;
      parts.push(`${bx0 * G},${by0 * G}-${bx1 * G},${by1 * G}`);
    }
  }
  if (components !== 1) reasons.push(`${components} separate objects (expected 1): ${parts.join(" | ")}`);

  // 3. size and centring
  const long = Math.max(bbox.w, bbox.h);
  if (long < 0.4 * Math.max(W, H)) reasons.push("object too small");
  const cx = bbox.x + bbox.w / 2;
  const cy = bbox.y + bbox.h / 2;
  if (Math.abs(cx - W / 2) > 0.06 * W || Math.abs(cy - H / 2) > 0.06 * H) reasons.push("object not centred");

  // 4. category framing
  const aspect = bbox.w / Math.max(1, bbox.h);
  if (category === "watch") {
    if (aspect > 0.8) reasons.push("watch not upright (expected taller than wide)");
    if (bbox.h < 0.85 * H) reasons.push("watch straps not cropped to a wearing length");
  }
  if (category === "ring" && (aspect < 0.45 || aspect > 1.6)) reasons.push("ring framing not three-quarter");
  // ~45 degrees reads as an ellipse: lying (wider than tall) or standing (aspect ~0.7); edge-on is too narrow
  if (category === "bracelet" && (aspect < 0.55 || aspect > 2.2)) reasons.push("bracelet framing not three-quarter (too close to edge-on or flat)");
  if (category === "necklace" && aspect < 0.5) reasons.push("necklace not shown as worn (too narrow)");

  return { ok: reasons.length === 0, reasons, bbox, components };
}

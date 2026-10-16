/**
 * SVG -> 1024 px PNG on pure white: rasterise at 2x, trim the white margin, scale the object into the
 * category's fit box, centre it, and quantise to a compact palette PNG. Anchor points follow the same
 * transform so they are valid in the final image's pixel space.
 */
import sharp from "sharp";
import type { Anchors, RenderOut } from "./design";
import { CANVAS } from "./svg";

const SUPERSAMPLE = 2;

export interface Composed {
  png: Buffer;
  anchors: Anchors;
}

function mapAnchors(anchors: Anchors, f: (x: number, y: number) => [number, number]): Anchors {
  const out: Anchors = {};
  for (const [k, v] of Object.entries(anchors)) {
    if (Array.isArray(v[0])) out[k] = (v as number[][]).map(([x, y]) => f(x, y));
    else {
      const [x, y] = v as number[];
      out[k] = f(x, y);
    }
  }
  return out;
}

export async function composeImage(r: RenderOut, size = CANVAS): Promise<Composed> {
  const raster = await sharp(Buffer.from(r.svg), { density: 72 * SUPERSAMPLE })
    .flatten({ background: "#ffffff" })
    .png()
    .toBuffer();
  const trimmed = await sharp(raster)
    .trim({ background: "#ffffff", threshold: 6 })
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = trimmed.info;
  // sharp reports the trim offset as a negative number (offset of the trimmed image from the original)
  const offL = -(trimmed.info.trimOffsetLeft ?? 0);
  const offT = -(trimmed.info.trimOffsetTop ?? 0);
  const fitW = (r.fit.w / CANVAS) * size;
  const fitH = (r.fit.h / CANVAS) * size;
  const scale = Math.min(fitW / w, fitH / h, ((r.maxScale ?? 2) / SUPERSAMPLE) * (size / CANVAS));
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));
  const left = Math.floor((size - nw) / 2);
  const top = Math.floor((size - nh) / 2);

  const png = await sharp(trimmed.data)
    .resize(nw, nh, { kernel: "lanczos3" })
    .extend({ left, top, right: size - nw - left, bottom: size - nh - top, background: "#ffffff" })
    .flatten({ background: "#ffffff" })
    .png({ palette: true, colours: 128, quality: 92, effort: 10, compressionLevel: 9, dither: 0.6 })
    .toBuffer();

  const anchors = mapAnchors(r.anchors, (x, y) => [
    Math.round((x * SUPERSAMPLE - offL) * (nw / w) + left),
    Math.round((y * SUPERSAMPLE - offT) * (nh / h) + top),
  ]);
  return { png, anchors };
}

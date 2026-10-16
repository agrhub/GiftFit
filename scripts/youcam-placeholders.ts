/**
 * Generates the self-made placeholder PNGs in fixtures/youcam/images/ (an abstract
 * drawn face and hand, simple drawn jewelry; no real person, no third-party asset). Re-run after changing shapes:
 *   npx tsx scripts/youcam-placeholders.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";

type RGB = [number, number, number];

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export function encodePng(width: number, height: number, pixel: (x: number, y: number) => RGB): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw.set([r, g, b], row + 1 + x * 3);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

interface FaceStyle {
  bg: RGB;
  skin: RGB;
  hair: RGB;
  lip: RGB;
  garment?: RGB;
  earring?: RGB;
  necklace?: RGB;
  blemish?: boolean;
}

const inEllipse = (x: number, y: number, cx: number, cy: number, rx: number, ry: number) =>
  ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;

function face(style: FaceStyle, size = 512): Buffer {
  const s = size / 512;
  return encodePng(size, size, (px, py) => {
    const x = px / s;
    const y = py / s;
    if (style.garment && y > 430 && inEllipse(x, y, 256, 560, 230, 150)) return style.garment;
    if (style.necklace && Math.abs(Math.hypot(x - 256, y - 330) - 120) < 5 && y > 380) return style.necklace;
    if (inEllipse(x, y, 256, 400, 52, 90) && y > 360) return style.skin; // neck
    if (style.earring && (inEllipse(x, y, 112, 300, 9, 14) || inEllipse(x, y, 400, 300, 9, 14))) return style.earring;
    if (inEllipse(x, y, 256, 250, 140, 180)) {
      if (y < 150 && inEllipse(x, y, 256, 170, 150, 110)) return style.hair; // fringe
      if (inEllipse(x, y, 200, 230, 20, 11) || inEllipse(x, y, 312, 230, 20, 11)) return [60, 50, 45]; // eyes
      if (inEllipse(x, y, 256, 345, 46, 15)) return style.lip;
      if (style.blemish && (inEllipse(x, y, 190, 300, 5, 5) || inEllipse(x, y, 330, 290, 4, 4))) return [190, 110, 100];
      return style.skin;
    }
    if (inEllipse(x, y, 256, 230, 175, 210) && y < 330) return style.hair;
    return style.bg;
  });
}

const BASE: FaceStyle = { bg: [228, 230, 236], skin: [222, 186, 160], hair: [70, 52, 40], lip: [190, 110, 110] };

const IMAGES: Record<string, FaceStyle> = {
  "placeholder-selfie": BASE,
  "mock-skin-mask": { ...BASE, skin: [236, 170, 160], blemish: true },
  "mock-skin-simulation": { ...BASE, skin: [230, 196, 172] },
  "mock-makeup-vto": { ...BASE, lip: [200, 40, 70] },
  "mock-hair-color": { ...BASE, hair: [150, 60, 40] },
  "mock-cloth-v4": { ...BASE, garment: [60, 90, 150] },
  "mock-jewelry-vto": { ...BASE, earring: [212, 175, 55], necklace: [212, 175, 55] },
};

const GOLD: RGB = [212, 175, 55];
const WHITE: RGB = [255, 255, 255];
const near = (x: number, y: number, cx: number, cy: number, r: number, w: number) => Math.abs(Math.hypot(x - cx, y - cy) - r) < w;

/** White-background product shot of a single drop earring (hoop + pearl). */
function earringProduct(): Buffer {
  return encodePng(512, 512, (x, y) => {
    if (near(x, y, 256, 170, 60, 6)) return GOLD;
    if (x > 252 && x < 260 && y > 230 && y < 300) return GOLD;
    if (inEllipse(x, y, 256, 330, 34, 40)) return [240, 236, 226];
    return WHITE;
  });
}

/** White-background product shot of a chain necklace with a pendant. */
function necklaceProduct(): Buffer {
  return encodePng(512, 512, (x, y) => {
    if (y > 120 && near(x, y, 256, 120, 170, 4)) return GOLD;
    if (inEllipse(x, y, 256, 312, 22, 26)) return [180, 30, 60];
    return WHITE;
  });
}

/** Back of a hand with five fingers on a grey background; optional ring and bracelet. */
function hand(opts: { ring?: boolean; bracelet?: boolean } = {}): Buffer {
  const skin: RGB = [222, 186, 160];
  const fingers = [
    { cx: 150, top: 150, w: 26 },
    { cx: 205, top: 90, w: 26 },
    { cx: 260, top: 75, w: 26 },
    { cx: 315, top: 95, w: 24 },
    { cx: 362, top: 145, w: 22 },
  ];
  return encodePng(512, 512, (x, y) => {
    if (opts.bracelet && y > 418 && y < 434 && x > 190 && x < 330) return GOLD;
    if (opts.ring && y > 215 && y < 228 && Math.abs(x - 260) < 27) return GOLD;
    if (y > 260 && y < 470 && x > 140 && x < 380 && inEllipse(x, y, 260, 330, 125, 160)) return skin;
    if (y > 400 && x > 195 && x < 325) return skin; // wrist
    for (const f of fingers) {
      if (Math.abs(x - f.cx) < f.w && y > f.top + f.w && y < 300) return skin;
      if (inEllipse(x, y, f.cx, f.top + f.w, f.w, f.w)) return skin;
    }
    return [228, 230, 236];
  });
}

const OTHER: Record<string, () => Buffer> = {
  "product-earring": earringProduct,
  "product-necklace": necklaceProduct,
  "placeholder-hand": () => hand(),
  "mock-hand-vto": () => hand({ ring: true, bracelet: true }),
};

function main() {
  const out = path.join(process.cwd(), "fixtures", "youcam", "images");
  mkdirSync(out, { recursive: true });
  const all: Record<string, () => Buffer> = {
    ...Object.fromEntries(Object.entries(IMAGES).map(([n, style]) => [n, () => face(style)])),
    ...OTHER,
  };
  for (const [name, draw] of Object.entries(all)) {
    const file = path.join(out, `${name}.png`);
    writeFileSync(file, draw());
    console.log(`wrote ${path.relative(process.cwd(), file)}`);
  }
}

if (process.argv[1] && /youcam-placeholders\.ts$/.test(process.argv[1])) main();

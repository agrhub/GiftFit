/**
 * sRGB (D65) <-> CIELAB conversions for the fairness fixtures. Independent of
 * lib/verticals/jewelry.ts on purpose, so the harness does not share code with what it audits.
 */
export interface Lab {
  L: number;
  a: number;
  b: number;
}

const WHITE = { X: 0.95047, Y: 1.0, Z: 1.08883 };

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
const fInv = (t: number) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`invalid hex color: ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function hexToLab(hex: string): Lab {
  const [r, g, b] = hexToRgb(hex).map((v) => toLinear(v / 255));
  const X = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
  const Y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const Z = 0.0193339 * r + 0.119192 * g + 0.9503041 * b;
  const fx = f(X / WHITE.X);
  const fy = f(Y / WHITE.Y);
  const fz = f(Z / WHITE.Z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

/** LAB -> hex, or null when the color is outside the sRGB gamut. */
export function labToHex(lab: Lab): string | null {
  const fy = (lab.L + 16) / 116;
  const fx = fy + lab.a / 500;
  const fz = fy - lab.b / 200;
  const X = fInv(fx) * WHITE.X;
  const Y = fInv(fy) * WHITE.Y;
  const Z = fInv(fz) * WHITE.Z;
  const lin = [
    3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z,
    -0.969266 * X + 1.8760108 * Y + 0.041556 * Z,
    0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z,
  ];
  const rgb = lin.map((c) => toGamma(c) * 255);
  if (rgb.some((c) => c < -0.5 || c > 255.5)) return null;
  return `#${rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, "0")).join("")}`;
}

export const hueDeg = (lab: Lab) => ((Math.atan2(lab.b, lab.a) * 180) / Math.PI + 360) % 360;
export const chroma = (lab: Lab) => Math.hypot(lab.a, lab.b);

export function fromLch(L: number, C: number, hDeg: number): Lab {
  const h = (hDeg * Math.PI) / 180;
  return { L, a: C * Math.cos(h), b: C * Math.sin(h) };
}

/**
 * Tiny SVG builder and shared drawing primitives for the Aurum Jewelry product renders.
 * Everything is drawn from code (no third-party artwork): metals are layered gradients,
 * stones are faceted polygons with radial gradients, pearls are radial gradients with a sheen.
 */
import type { Metal } from "@/lib/contracts/giftfit";

export const CANVAS = 1024;

export interface MetalPalette {
  hi: string;
  light: string;
  mid: string;
  dark: string;
  deep: string;
}

const YELLOW: MetalPalette = { hi: "#FFF6D1", light: "#F6DB82", mid: "#D9AE45", dark: "#A97C1E", deep: "#6E4E0E" };
const ROSE: MetalPalette = { hi: "#FFE9E1", light: "#F2BFAE", mid: "#D69482", dark: "#A8665A", deep: "#6E3F37" };
const WHITE_GOLD: MetalPalette = { hi: "#FFFFFF", light: "#E6E9EC", mid: "#BFC4CA", dark: "#8A9097", deep: "#555B62" };
const SILVER: MetalPalette = { hi: "#FAFBFC", light: "#DADDE1", mid: "#AEB3BA", dark: "#7C828A", deep: "#4C5259" };
const PLATINUM: MetalPalette = { hi: "#F4F6FA", light: "#D7DCE4", mid: "#B0B8C3", dark: "#7F8894", deep: "#4E5661" };

export function metalPalette(metal: Metal, part: "primary" | "secondary" = "primary"): MetalPalette {
  switch (metal) {
    case "yellow_gold":
      return YELLOW;
    case "rose_gold":
      return ROSE;
    case "white_gold":
      return WHITE_GOLD;
    case "silver":
      return SILVER;
    case "platinum":
      return PLATINUM;
    case "mixed_two_tone":
      return part === "primary" ? YELLOW : WHITE_GOLD;
  }
}

export type StoneColor =
  | "clear"
  | "blue"
  | "sky"
  | "green"
  | "red"
  | "purple"
  | "yellow"
  | "garnet"
  | "peach"
  | "pink"
  | "aqua"
  | "lime"
  | "opal"
  | "black";

const STONES: Record<StoneColor, { light: string; mid: string; dark: string }> = {
  clear: { light: "#FFFFFF", mid: "#E3ECF5", dark: "#9AA9BA" },
  blue: { light: "#7FA6FF", mid: "#2348B8", dark: "#0E1F5C" },
  sky: { light: "#D2F2FF", mid: "#6CC6EA", dark: "#2A7FA6" },
  green: { light: "#8BE3B1", mid: "#14915A", dark: "#064A2B" },
  red: { light: "#FF8DA6", mid: "#C0103A", dark: "#5E0519" },
  purple: { light: "#DDB6FF", mid: "#8D4CC4", dark: "#46196E" },
  yellow: { light: "#FFF0A8", mid: "#F0B32A", dark: "#A8640C" },
  garnet: { light: "#E0657A", mid: "#7E1024", dark: "#3A0510" },
  peach: { light: "#FFE6DE", mid: "#F2B3A3", dark: "#BF7766" },
  pink: { light: "#FFD1E3", mid: "#E77AA6", dark: "#A3365F" },
  aqua: { light: "#E2FAFF", mid: "#9ADDEB", dark: "#4E9DB0" },
  lime: { light: "#E4FFB0", mid: "#9CCB34", dark: "#557A0F" },
  opal: { light: "#FFFFFF", mid: "#D9EEF7", dark: "#9FC3D6" },
  black: { light: "#6B6F76", mid: "#22252A", dark: "#050607" },
};

export type PearlTone = "cream" | "white" | "dark";

const PEARLS: Record<PearlTone, { hi: string; mid: string; edge: string }> = {
  cream: { hi: "#FFFFFF", mid: "#F4EBDD", edge: "#C9B89F" },
  white: { hi: "#FFFFFF", mid: "#EEEFF3", edge: "#B9BCC6" },
  dark: { hi: "#C9D3D0", mid: "#5D6B6A", edge: "#2B3333" },
};

/** Linear blend between two #RRGGBB colours. */
export function mix(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return `#${pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, "0")).join("")}`;
}

/** Colour ramp across the extruded side of a band: shaded at the back, lit towards the front edge. */
export function sideShade(p: MetalPalette, u: number): string {
  if (u < 0.5) return mix(p.deep, p.mid, u / 0.5);
  if (u < 0.85) return mix(p.mid, p.light, (u - 0.5) / 0.35);
  return mix(p.light, p.dark, (u - 0.85) / 0.15);
}

export const fmt = (n: number) => (Math.round(n * 10) / 10).toString();

export class Svg {
  private defs: string[] = [];
  private body: string[] = [];
  private n = 0;
  private cache = new Map<string, string>();

  id(prefix: string): string {
    this.n += 1;
    return `${prefix}${this.n}`;
  }

  def(xml: string): void {
    this.defs.push(xml);
  }

  add(xml: string): void {
    this.body.push(xml);
  }

  /** Linear metal gradient (diagonal by default), cached per palette + angle. */
  metalFill(p: MetalPalette, angle: "diag" | "vert" | "horiz" = "diag"): string {
    const key = `m-${p.mid}-${angle}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const id = this.id("m");
    const [x1, y1, x2, y2] = angle === "vert" ? [0, 0, 0, 1] : angle === "horiz" ? [0, 0, 1, 0] : [0, 0, 1, 1];
    this.def(
      `<linearGradient id="${id}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">` +
        `<stop offset="0" stop-color="${p.hi}"/><stop offset="0.22" stop-color="${p.light}"/>` +
        `<stop offset="0.5" stop-color="${p.mid}"/><stop offset="0.72" stop-color="${p.light}"/>` +
        `<stop offset="0.9" stop-color="${p.dark}"/><stop offset="1" stop-color="${p.deep}"/></linearGradient>`,
    );
    const url = `url(#${id})`;
    this.cache.set(key, url);
    return url;
  }

  /** Radial metal gradient for domes, beads and buttons. */
  metalDome(p: MetalPalette): string {
    const key = `d-${p.mid}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const id = this.id("d");
    this.def(
      `<radialGradient id="${id}" cx="0.38" cy="0.32" r="0.75">` +
        `<stop offset="0" stop-color="${p.hi}"/><stop offset="0.35" stop-color="${p.light}"/>` +
        `<stop offset="0.75" stop-color="${p.mid}"/><stop offset="1" stop-color="${p.dark}"/></radialGradient>`,
    );
    const url = `url(#${id})`;
    this.cache.set(key, url);
    return url;
  }

  stoneFill(c: StoneColor): string {
    const key = `s-${c}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const s = STONES[c];
    const id = this.id("s");
    if (c === "opal") {
      this.def(
        `<radialGradient id="${id}" cx="0.4" cy="0.35" r="0.8"><stop offset="0" stop-color="#FFFFFF"/>` +
          `<stop offset="0.3" stop-color="#E6F7FF"/><stop offset="0.5" stop-color="#F9D9F0"/>` +
          `<stop offset="0.68" stop-color="#D3F5DA"/><stop offset="0.85" stop-color="#C8E3F7"/>` +
          `<stop offset="1" stop-color="#9DB9D0"/></radialGradient>`,
      );
    } else {
      this.def(
        `<radialGradient id="${id}" cx="0.42" cy="0.38" r="0.7"><stop offset="0" stop-color="${s.light}"/>` +
          `<stop offset="0.55" stop-color="${s.mid}"/><stop offset="1" stop-color="${s.dark}"/></radialGradient>`,
      );
    }
    const url = `url(#${id})`;
    this.cache.set(key, url);
    return url;
  }

  pearlFill(t: PearlTone): string {
    const key = `p-${t}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const p = PEARLS[t];
    const id = this.id("p");
    this.def(
      `<radialGradient id="${id}" cx="0.36" cy="0.3" r="0.78"><stop offset="0" stop-color="${p.hi}"/>` +
        `<stop offset="0.45" stop-color="${p.mid}"/><stop offset="0.85" stop-color="${p.mid}"/>` +
        `<stop offset="1" stop-color="${p.edge}"/></radialGradient>`,
    );
    const url = `url(#${id})`;
    this.cache.set(key, url);
    return url;
  }

  toString(): string {
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">` +
      `<defs>${this.defs.join("")}</defs><rect width="${CANVAS}" height="${CANVAS}" fill="#FFFFFF"/>` +
      `${this.body.join("")}</svg>`
    );
  }
}

/** A metal "wire" or tube: dark rim, body and a specular line. */
export function tube(s: Svg, d: string, w: number, p: MetalPalette, opts: { cap?: "round" | "butt"; fill?: string } = {}): void {
  const cap = opts.cap ?? "round";
  const fill = opts.fill ?? "none";
  s.add(`<path d="${d}" fill="${fill}" stroke="${p.deep}" stroke-width="${fmt(w)}" stroke-linecap="${cap}" stroke-linejoin="round"/>`);
  s.add(`<path d="${d}" fill="none" stroke="${p.mid}" stroke-width="${fmt(w * 0.78)}" stroke-linecap="${cap}" stroke-linejoin="round"/>`);
  s.add(`<path d="${d}" fill="none" stroke="${p.light}" stroke-width="${fmt(w * 0.42)}" stroke-linecap="${cap}" stroke-linejoin="round"/>`);
  s.add(
    `<path d="${d}" fill="none" stroke="${p.hi}" stroke-width="${fmt(Math.max(1.2, w * 0.14))}" stroke-linecap="${cap}" stroke-linejoin="round" transform="translate(${fmt(-w * 0.12)} ${fmt(-w * 0.14)})" opacity="0.9"/>`,
  );
}

/** A chain: dark core, alternating link dashes and a glint. */
export function chain(s: Svg, d: string, w: number, p: MetalPalette, style: "cable" | "box" | "rope" | "curb" = "cable"): void {
  s.add(`<path d="${d}" fill="none" stroke="${p.deep}" stroke-width="${fmt(w)}" stroke-linecap="round" stroke-linejoin="round"/>`);
  const link = style === "box" ? w * 1.1 : style === "rope" ? w * 0.8 : style === "curb" ? w * 1.6 : w * 1.9;
  const gap = style === "box" ? w * 0.35 : style === "rope" ? w * 0.45 : style === "curb" ? w * 0.4 : w * 0.7;
  s.add(
    `<path d="${d}" fill="none" stroke="${p.light}" stroke-width="${fmt(w * 0.68)}" stroke-dasharray="${fmt(link)} ${fmt(gap)}" stroke-linecap="${style === "box" ? "butt" : "round"}"/>`,
  );
  s.add(
    `<path d="${d}" fill="none" stroke="${p.hi}" stroke-width="${fmt(Math.max(1, w * 0.22))}" stroke-dasharray="${fmt(link * 0.45)} ${fmt(link * 0.55 + gap)}" stroke-linecap="round" opacity="0.95"/>`,
  );
}

export type Cut = "round" | "oval" | "pear" | "square" | "emerald" | "marquise" | "cushion";

function cutOutline(cut: Cut, cx: number, cy: number, w: number, h: number): string {
  const rx = w / 2;
  const ry = h / 2;
  switch (cut) {
    case "round":
    case "oval":
      return `M${fmt(cx - rx)} ${fmt(cy)} A${fmt(rx)} ${fmt(ry)} 0 1 0 ${fmt(cx + rx)} ${fmt(cy)} A${fmt(rx)} ${fmt(ry)} 0 1 0 ${fmt(cx - rx)} ${fmt(cy)} Z`;
    case "pear":
      // point at the top, round at the bottom
      return (
        `M${fmt(cx)} ${fmt(cy - ry)} C${fmt(cx + rx * 0.45)} ${fmt(cy - ry * 0.55)} ${fmt(cx + rx)} ${fmt(cy - ry * 0.05)} ${fmt(cx + rx)} ${fmt(cy + ry * 0.35)} ` +
        `C${fmt(cx + rx)} ${fmt(cy + ry * 0.8)} ${fmt(cx + rx * 0.55)} ${fmt(cy + ry)} ${fmt(cx)} ${fmt(cy + ry)} ` +
        `C${fmt(cx - rx * 0.55)} ${fmt(cy + ry)} ${fmt(cx - rx)} ${fmt(cy + ry * 0.8)} ${fmt(cx - rx)} ${fmt(cy + ry * 0.35)} ` +
        `C${fmt(cx - rx)} ${fmt(cy - ry * 0.05)} ${fmt(cx - rx * 0.45)} ${fmt(cy - ry * 0.55)} ${fmt(cx)} ${fmt(cy - ry)} Z`
      );
    case "marquise":
      return `M${fmt(cx)} ${fmt(cy - ry)} Q${fmt(cx + rx * 1.25)} ${fmt(cy)} ${fmt(cx)} ${fmt(cy + ry)} Q${fmt(cx - rx * 1.25)} ${fmt(cy)} ${fmt(cx)} ${fmt(cy - ry)} Z`;
    case "square":
    case "cushion": {
      const r = cut === "cushion" ? Math.min(rx, ry) * 0.35 : Math.min(rx, ry) * 0.06;
      return `M${fmt(cx - rx + r)} ${fmt(cy - ry)} H${fmt(cx + rx - r)} Q${fmt(cx + rx)} ${fmt(cy - ry)} ${fmt(cx + rx)} ${fmt(cy - ry + r)} V${fmt(cy + ry - r)} Q${fmt(cx + rx)} ${fmt(cy + ry)} ${fmt(cx + rx - r)} ${fmt(cy + ry)} H${fmt(cx - rx + r)} Q${fmt(cx - rx)} ${fmt(cy + ry)} ${fmt(cx - rx)} ${fmt(cy + ry - r)} V${fmt(cy - ry + r)} Q${fmt(cx - rx)} ${fmt(cy - ry)} ${fmt(cx - rx + r)} ${fmt(cy - ry)} Z`;
    }
    case "emerald": {
      const c = Math.min(rx, ry) * 0.28;
      return `M${fmt(cx - rx + c)} ${fmt(cy - ry)} H${fmt(cx + rx - c)} L${fmt(cx + rx)} ${fmt(cy - ry + c)} V${fmt(cy + ry - c)} L${fmt(cx + rx - c)} ${fmt(cy + ry)} H${fmt(cx - rx + c)} L${fmt(cx - rx)} ${fmt(cy + ry - c)} V${fmt(cy - ry + c)} Z`;
    }
  }
}

/** A faceted gemstone. `w`, `h` are the stone's outline size. */
export function gem(s: Svg, cut: Cut, cx: number, cy: number, w: number, h: number, color: StoneColor): void {
  const outline = cutOutline(cut, cx, cy, w, h);
  const st = STONES[color];
  s.add(`<path d="${outline}" fill="${s.stoneFill(color)}" stroke="${st.dark}" stroke-width="${fmt(Math.max(1, w * 0.018))}"/>`);
  // facets: table + star lines
  const tw = w * (cut === "emerald" || cut === "square" ? 0.56 : 0.5);
  const th = h * (cut === "emerald" || cut === "square" ? 0.56 : 0.5);
  const tcy = cut === "pear" ? cy + h * 0.1 : cy;
  const table = cut === "emerald" || cut === "square" || cut === "cushion" ? cutOutline("emerald", cx, tcy, tw, th) : cutOutline(cut === "pear" ? "oval" : cut, cx, tcy, tw, th);
  const facetStroke = color === "clear" || color === "opal" ? "#8FA2B6" : "#FFFFFF";
  const op = color === "clear" || color === "opal" ? 0.55 : 0.35;
  s.add(`<path d="${table}" fill="#FFFFFF" fill-opacity="${color === "black" ? 0.08 : 0.18}" stroke="${facetStroke}" stroke-opacity="${op}" stroke-width="${fmt(Math.max(1, w * 0.012))}"/>`);
  const n = 8;
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + Math.PI / 8;
    const ix = cx + Math.cos(a) * tw * 0.5;
    const iy = tcy + Math.sin(a) * th * 0.5;
    const ox = cx + Math.cos(a) * w * 0.5 * (cut === "marquise" ? 0.6 : 0.95);
    const oy = cy + Math.sin(a) * h * 0.5 * 0.95;
    lines.push(`M${fmt(ix)} ${fmt(iy)} L${fmt(ox)} ${fmt(oy)}`);
  }
  s.add(`<path d="${lines.join(" ")}" stroke="${facetStroke}" stroke-opacity="${op}" stroke-width="${fmt(Math.max(1, w * 0.01))}" fill="none"/>`);
  // glints
  s.add(`<ellipse cx="${fmt(cx - w * 0.16)}" cy="${fmt(tcy - h * 0.14)}" rx="${fmt(w * 0.09)}" ry="${fmt(h * 0.05)}" fill="#FFFFFF" opacity="0.85" transform="rotate(-30 ${fmt(cx - w * 0.16)} ${fmt(tcy - h * 0.14)})"/>`);
  s.add(`<circle cx="${fmt(cx + w * 0.17)}" cy="${fmt(tcy + h * 0.16)}" r="${fmt(Math.max(1.2, w * 0.03))}" fill="#FFFFFF" opacity="0.7"/>`);
}

/** Metal bezel (rim) around a stone, drawn before the stone. */
export function bezel(s: Svg, cut: Cut, cx: number, cy: number, w: number, h: number, p: MetalPalette, rim = 0.16): void {
  const k = 1 + rim;
  s.add(`<path d="${cutOutline(cut, cx, cy, w * k, h * k)}" fill="${s.metalFill(p)}" stroke="${p.deep}" stroke-width="${fmt(Math.max(1.2, w * 0.02))}"/>`);
}

/** Claw prongs at the given angles around an elliptical stone. */
export function prongs(s: Svg, cx: number, cy: number, w: number, h: number, p: MetalPalette, count = 4): void {
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + (count === 4 ? Math.PI / 4 : -Math.PI / 2);
    const x = cx + Math.cos(a) * w * 0.47;
    const y = cy + Math.sin(a) * h * 0.47;
    const r = Math.max(4, w * 0.075);
    s.add(`<ellipse cx="${fmt(x)}" cy="${fmt(y)}" rx="${fmt(r)}" ry="${fmt(r * 0.85)}" fill="${s.metalDome(p)}" stroke="${p.deep}" stroke-width="1.2"/>`);
  }
}

export function pearl(s: Svg, cx: number, cy: number, r: number, tone: PearlTone, ry = r): void {
  const p = PEARLS[tone];
  s.add(`<ellipse cx="${fmt(cx)}" cy="${fmt(cy)}" rx="${fmt(r)}" ry="${fmt(ry)}" fill="${s.pearlFill(tone)}" stroke="${p.edge}" stroke-width="${fmt(Math.max(1, r * 0.03))}"/>`);
  s.add(`<ellipse cx="${fmt(cx - r * 0.3)}" cy="${fmt(cy - ry * 0.36)}" rx="${fmt(r * 0.22)}" ry="${fmt(ry * 0.13)}" fill="#FFFFFF" opacity="0.9" transform="rotate(-28 ${fmt(cx - r * 0.3)} ${fmt(cy - ry * 0.36)})"/>`);
  s.add(`<ellipse cx="${fmt(cx + r * 0.25)}" cy="${fmt(cy + ry * 0.4)}" rx="${fmt(r * 0.35)}" ry="${fmt(ry * 0.16)}" fill="#FFE9F2" opacity="0.35"/>`);
}

/** Polished metal ball or dome. */
export function bead(s: Svg, cx: number, cy: number, r: number, p: MetalPalette): void {
  s.add(`<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(r)}" fill="${s.metalDome(p)}" stroke="${p.deep}" stroke-width="${fmt(Math.max(1, r * 0.06))}"/>`);
  s.add(`<ellipse cx="${fmt(cx - r * 0.32)}" cy="${fmt(cy - r * 0.36)}" rx="${fmt(r * 0.24)}" ry="${fmt(r * 0.14)}" fill="#FFFFFF" opacity="0.85" transform="rotate(-35 ${fmt(cx - r * 0.32)} ${fmt(cy - r * 0.36)})"/>`);
}

/** Small pavé stone: a bright round with a tiny metal rim. */
export function pave(s: Svg, cx: number, cy: number, r: number, p: MetalPalette, color: StoneColor = "clear"): void {
  s.add(`<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(r * 1.18)}" fill="${p.dark}"/>`);
  s.add(`<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(r)}" fill="${s.stoneFill(color)}"/>`);
  s.add(`<circle cx="${fmt(cx - r * 0.3)}" cy="${fmt(cy - r * 0.3)}" r="${fmt(r * 0.28)}" fill="#FFFFFF" opacity="0.9"/>`);
}

export interface Pt {
  x: number;
  y: number;
}

export const ellipsePt = (cx: number, cy: number, rx: number, ry: number, t: number): Pt => ({ x: cx + Math.cos(t) * rx, y: cy + Math.sin(t) * ry });

/** Cubic bezier point. */
export function bez(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

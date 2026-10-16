/**
 * Watches: dial upright and front-facing, straps cut straight at a realistic wearing length, no buckle,
 * clasp or strap back visible (api_matrix.md §9). No text or logo on the dial.
 * Anchors (`watch_anchor_point`, 4x2): strap start, strap end, case top, case bottom.
 */
import type { Design, RenderOut } from "../design";
import { Svg, bead, fmt, metalPalette, pave, type MetalPalette } from "../svg";

const CX = 512;
const CY = 512;
const STRAP_TOP = 6;
const STRAP_BOTTOM = 1018;

type CaseShape = "round" | "cushion" | "rect" | "tonneau";

interface Spec {
  shape: CaseShape;
  /** half width / half height of the case (without lugs) */
  hw: number;
  hh: number;
  strapW: number;
  bezel: "plain" | "diver" | "pave" | "thin";
  sub: "none" | "chrono" | "small_seconds";
  date: boolean;
  indices: "bars" | "dots" | "field" | "minimal";
}

const SPECS: Record<string, Spec> = {
  dress_round: { shape: "round", hw: 200, hh: 200, strapW: 200, bezel: "thin", sub: "small_seconds", date: false, indices: "bars" },
  minimal_round: { shape: "round", hw: 205, hh: 205, strapW: 200, bezel: "thin", sub: "none", date: false, indices: "minimal" },
  diver: { shape: "round", hw: 215, hh: 215, strapW: 214, bezel: "diver", sub: "none", date: true, indices: "dots" },
  chrono: { shape: "round", hw: 215, hh: 215, strapW: 214, bezel: "plain", sub: "chrono", date: true, indices: "bars" },
  field: { shape: "round", hw: 196, hh: 196, strapW: 196, bezel: "plain", sub: "none", date: false, indices: "field" },
  square_case: { shape: "cushion", hw: 180, hh: 190, strapW: 196, bezel: "plain", sub: "none", date: true, indices: "bars" },
  rect_case: { shape: "rect", hw: 140, hh: 205, strapW: 170, bezel: "thin", sub: "none", date: false, indices: "bars" },
  tonneau: { shape: "tonneau", hw: 170, hh: 215, strapW: 180, bezel: "plain", sub: "none", date: true, indices: "bars" },
  petite_round: { shape: "round", hw: 150, hh: 150, strapW: 140, bezel: "thin", sub: "none", date: false, indices: "minimal" },
  petite_pave: { shape: "round", hw: 155, hh: 155, strapW: 140, bezel: "pave", sub: "none", date: false, indices: "dots" },
};

export const WATCH_VARIANTS = Object.keys(SPECS);

function caseOutline(sp: Spec, grow = 0): string {
  const hw = sp.hw + grow;
  const hh = sp.hh + grow;
  switch (sp.shape) {
    case "round":
      return `M${CX - hw} ${CY} A${hw} ${hh} 0 1 0 ${CX + hw} ${CY} A${hw} ${hh} 0 1 0 ${CX - hw} ${CY} Z`;
    case "cushion": {
      const r = hw * 0.32;
      return `M${CX - hw + r} ${CY - hh} H${CX + hw - r} Q${CX + hw} ${CY - hh} ${CX + hw} ${CY - hh + r} V${CY + hh - r} Q${CX + hw} ${CY + hh} ${CX + hw - r} ${CY + hh} H${CX - hw + r} Q${CX - hw} ${CY + hh} ${CX - hw} ${CY + hh - r} V${CY - hh + r} Q${CX - hw} ${CY - hh} ${CX - hw + r} ${CY - hh} Z`;
    }
    case "rect": {
      const r = 18;
      return `M${CX - hw + r} ${CY - hh} H${CX + hw - r} Q${CX + hw} ${CY - hh} ${CX + hw} ${CY - hh + r} V${CY + hh - r} Q${CX + hw} ${CY + hh} ${CX + hw - r} ${CY + hh} H${CX - hw + r} Q${CX - hw} ${CY + hh} ${CX - hw} ${CY + hh - r} V${CY - hh + r} Q${CX - hw} ${CY - hh} ${CX - hw + r} ${CY - hh} Z`;
    }
    case "tonneau":
      return `M${CX - hw * 0.8} ${CY - hh} Q${CX} ${CY - hh - 18} ${CX + hw * 0.8} ${CY - hh} Q${CX + hw + 24} ${CY} ${CX + hw * 0.8} ${CY + hh} Q${CX} ${CY + hh + 18} ${CX - hw * 0.8} ${CY + hh} Q${CX - hw - 24} ${CY} ${CX - hw * 0.8} ${CY - hh} Z`;
  }
}

function strap(s: Svg, d: Design, p: MetalPalette, sp: Spec, y0: number, y1: number): void {
  const w0 = sp.strapW;
  const w1 = sp.strapW * 0.88;
  const top = y0 < y1;
  const ya = top ? y0 : y1; // outer end
  const yb = top ? y1 : y0; // at the lugs
  const wa = w1;
  const wb = w0;
  const path = `M${fmt(CX - wa / 2)} ${ya} L${fmt(CX + wa / 2)} ${ya} L${fmt(CX + wb / 2)} ${yb} L${fmt(CX - wb / 2)} ${yb} Z`;
  const kind = d.strap ?? "leather_brown";
  const id = s.id("st");
  const leather: Record<string, [string, string, string]> = {
    leather_brown: ["#8A5530", "#5E3519", "#3C200C"],
    leather_black: ["#3A3A3C", "#1D1D1F", "#09090A"],
    leather_tan: ["#C8925C", "#9C6634", "#6B4220"],
    leather_green: ["#3F5B45", "#26392A", "#142017"],
    canvas: ["#7B7F5A", "#5B5F3E", "#3B3E26"],
    rubber: ["#3B4048", "#22262C", "#0E1013"],
  };
  if (kind === "mesh" || kind === "link") {
    s.add(`<path d="${path}" fill="${s.metalFill(p, "horiz")}" stroke="${p.deep}" stroke-width="2.5"/>`);
    if (kind === "mesh") {
      s.def(`<pattern id="${id}" width="8" height="8" patternUnits="userSpaceOnUse"><path d="M0 8 L8 0 M-2 2 L2 -2 M6 10 L10 6" stroke="${p.dark}" stroke-width="1.6" opacity="0.6"/><path d="M0 0 L8 8" stroke="${p.hi}" stroke-width="1.2" opacity="0.6"/></pattern>`);
      s.add(`<path d="${path}" fill="url(#${id})"/>`);
    } else {
      const rows = Math.floor(Math.abs(yb - ya) / 46);
      for (let i = 0; i < rows; i++) {
        const y = Math.min(ya, yb) + i * 46 + 3;
        const k = top ? i / rows : 1 - i / rows;
        const w = wa + (wb - wa) * k;
        s.add(`<rect x="${fmt(CX - w / 2 + 3)}" y="${fmt(y)}" width="${fmt(w * 0.28)}" height="40" rx="6" fill="${s.metalFill(p, "vert")}" stroke="${p.deep}" stroke-width="2"/>`);
        s.add(`<rect x="${fmt(CX - w * 0.2)}" y="${fmt(y)}" width="${fmt(w * 0.4)}" height="40" rx="6" fill="${s.metalFill(p, "vert")}" stroke="${p.deep}" stroke-width="2"/>`);
        s.add(`<rect x="${fmt(CX + w / 2 - 3 - w * 0.28)}" y="${fmt(y)}" width="${fmt(w * 0.28)}" height="40" rx="6" fill="${s.metalFill(p, "vert")}" stroke="${p.deep}" stroke-width="2"/>`);
      }
    }
    return;
  }
  const [l, m, dk] = leather[kind];
  s.def(`<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${dk}"/><stop offset="0.18" stop-color="${m}"/><stop offset="0.5" stop-color="${l}"/><stop offset="0.82" stop-color="${m}"/><stop offset="1" stop-color="${dk}"/></linearGradient>`);
  s.add(`<path d="${path}" fill="url(#${id})" stroke="${dk}" stroke-width="2.5"/>`);
  if (kind === "canvas") {
    const lines: string[] = [];
    for (let y = Math.min(ya, yb) + 6; y < Math.max(ya, yb); y += 9) lines.push(`M${CX - wb / 2 + 6} ${y} H${CX + wb / 2 - 6}`);
    s.add(`<path d="${lines.join(" ")}" stroke="${dk}" stroke-width="1.4" opacity="0.45"/>`);
  } else if (kind === "rubber") {
    const lines: string[] = [];
    for (let y = Math.min(ya, yb) + 20; y < Math.max(ya, yb) - 10; y += 30) lines.push(`M${CX - wb * 0.3} ${y} H${CX + wb * 0.3}`);
    s.add(`<path d="${lines.join(" ")}" stroke="#000000" stroke-width="6" opacity="0.35" stroke-linecap="round"/>`);
  } else {
    // stitching along both edges
    s.add(`<path d="M${fmt(CX - wa / 2 + 12)} ${ya + 10} L${fmt(CX - wb / 2 + 12)} ${yb} M${fmt(CX + wa / 2 - 12)} ${ya + 10} L${fmt(CX + wb / 2 - 12)} ${yb}" stroke="${l}" stroke-width="3" stroke-dasharray="10 7" opacity="0.85"/>`);
  }
}

export function renderWatch(d: Design): RenderOut {
  const sp = SPECS[d.variant];
  if (!sp) throw new Error(`unknown watch variant ${d.variant}`);
  const s = new Svg();
  const p = metalPalette(d.metal);
  const p2 = metalPalette(d.metal, "secondary");
  const dial = d.dial ?? "#F3F0E8";
  const dark = /^#([0-4])/.test(dial);
  const ink = dark ? "#EDEDED" : "#2A2B2E";

  // straps first (behind lugs and case)
  const lugTop = CY - sp.hh - 46;
  const lugBottom = CY + sp.hh + 46;
  strap(s, d, d.metal === "mixed_two_tone" && d.strap === "link" ? p2 : p, sp, STRAP_TOP, lugTop + 10);
  strap(s, d, d.metal === "mixed_two_tone" && d.strap === "link" ? p2 : p, sp, STRAP_BOTTOM, lugBottom - 10);

  // lugs
  for (const sy of [-1, 1]) {
    for (const sx of [-1, 1]) {
      const x = CX + sx * (sp.strapW / 2 + 8);
      const yIn = CY + sy * (sp.hh * 0.6);
      const yOut = CY + sy * (sp.hh + 50);
      s.add(`<path d="M${fmt(x - 16)} ${fmt(yIn)} L${fmt(x + 16)} ${fmt(yIn)} L${fmt(x + 12)} ${fmt(yOut)} L${fmt(x - 12)} ${fmt(yOut)} Z" fill="${s.metalFill(p, "horiz")}" stroke="${p.deep}" stroke-width="2"/>`);
    }
  }
  // crown (+ chrono pushers)
  const crownX = CX + sp.hw + (sp.shape === "tonneau" ? 18 : 0);
  s.add(`<rect x="${crownX - 4}" y="${CY - 22}" width="34" height="44" rx="8" fill="${s.metalFill(p, "vert")}" stroke="${p.deep}" stroke-width="2"/>`);
  if (sp.sub === "chrono") {
    for (const a of [-0.55, 0.55]) {
      const x = CX + Math.cos(a) * (sp.hw + 6);
      const y = CY + Math.sin(a) * (sp.hh + 6);
      s.add(`<rect x="${fmt(x - 4)}" y="${fmt(y - 14)}" width="30" height="28" rx="6" fill="${s.metalFill(p, "vert")}" stroke="${p.deep}" stroke-width="2" transform="rotate(${fmt((a * 180) / Math.PI)} ${fmt(x)} ${fmt(y)})"/>`);
    }
  }
  // case
  s.add(`<path d="${caseOutline(sp, 6)}" fill="${p.deep}"/>`);
  s.add(`<path d="${caseOutline(sp)}" fill="${s.metalFill(p)}"/>`);
  const bezelW = sp.bezel === "diver" ? 38 : sp.bezel === "pave" ? 28 : sp.bezel === "plain" ? 20 : 11;
  if (sp.bezel === "diver") {
    s.add(`<path d="${caseOutline(sp, -8)}" fill="#1B2130" stroke="${p.deep}" stroke-width="2"/>`);
    const ticks: string[] = [];
    for (let i = 0; i < 60; i++) {
      const a = (i / 60) * Math.PI * 2 - Math.PI / 2;
      const r0 = sp.hw - 14;
      const r1 = sp.hw - (i % 5 === 0 ? 34 : 24);
      if (i === 0) continue;
      ticks.push(`M${fmt(CX + Math.cos(a) * r0)} ${fmt(CY + Math.sin(a) * r0)} L${fmt(CX + Math.cos(a) * r1)} ${fmt(CY + Math.sin(a) * r1)}`);
    }
    s.add(`<path d="${ticks.join(" ")}" stroke="#E8E8E8" stroke-width="3"/>`);
    s.add(`<path d="M${CX - 11} ${CY - sp.hh + 14} L${CX + 11} ${CY - sp.hh + 14} L${CX} ${CY - sp.hh + 34} Z" fill="#F2F2F2"/>`);
  }
  if (sp.bezel === "pave") {
    for (let i = 0; i < 30; i++) {
      const a = (i / 30) * Math.PI * 2;
      pave(s, CX + Math.cos(a) * (sp.hw - 14), CY + Math.sin(a) * (sp.hh - 14), 9, p, "clear");
    }
  }
  // dial
  const dialId = s.id("dl");
  s.def(`<radialGradient id="${dialId}" cx="0.45" cy="0.4" r="0.75"><stop offset="0" stop-color="${dial}" stop-opacity="1"/><stop offset="0.8" stop-color="${dial}"/><stop offset="1" stop-color="#000000" stop-opacity="0.35"/></radialGradient>`);
  s.add(`<path d="${caseOutline(sp, -bezelW)}" fill="${dial}" stroke="${p.dark}" stroke-width="3"/>`);
  s.add(`<path d="${caseOutline(sp, -bezelW)}" fill="url(#${dialId})" opacity="0.5"/>`);
  const rIdx = Math.min(sp.hw, sp.hh) - bezelW - 16;
  const rIdxY = sp.hh - bezelW - 16;
  const rIdxX = sp.hw - bezelW - 16;
  const marks: string[] = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 - Math.PI / 2;
    const ux = Math.cos(a);
    const uy = Math.sin(a);
    // project onto the dial shape (rect dials get marks near their edges)
    const k = sp.shape === "round" ? 1 : Math.min(1 / Math.max(Math.abs(ux) * (rIdx / rIdxX), 1e-6), 1 / Math.max(Math.abs(uy) * (rIdx / rIdxY), 1e-6), sp.shape === "rect" ? 1.6 : 1.2);
    const r0 = rIdx * k;
    const major = i % 3 === 0;
    if (sp.indices === "minimal" && !major) continue;
    if (sp.indices === "dots" && !major) {
      s.add(`<circle cx="${fmt(CX + ux * (r0 - 10))}" cy="${fmt(CY + uy * (r0 - 10))}" r="9" fill="${ink}"/>`);
      continue;
    }
    const len = major ? (sp.indices === "field" ? 38 : 34) : 22;
    marks.push(`M${fmt(CX + ux * r0)} ${fmt(CY + uy * r0)} L${fmt(CX + ux * (r0 - len))} ${fmt(CY + uy * (r0 - len))}`);
  }
  if (sp.indices === "field") {
    const minutes: string[] = [];
    for (let i = 0; i < 60; i++) {
      const a = (i / 60) * Math.PI * 2;
      minutes.push(`M${fmt(CX + Math.cos(a) * (rIdx + 6))} ${fmt(CY + Math.sin(a) * (rIdx + 6))} L${fmt(CX + Math.cos(a) * (rIdx - 2))} ${fmt(CY + Math.sin(a) * (rIdx - 2))}`);
    }
    s.add(`<path d="${minutes.join(" ")}" stroke="${ink}" stroke-width="2"/>`);
  }
  s.add(`<path d="${marks.join(" ")}" stroke="${dark ? p.light : p.dark}" stroke-width="${sp.indices === "field" ? 7 : 9}" stroke-linecap="round"/>`);
  if (sp.sub === "chrono") {
    for (const [dx, dy] of [
      [-70, 10],
      [70, 10],
      [0, 85],
    ]) {
      s.add(`<circle cx="${CX + dx}" cy="${CY + dy}" r="40" fill="${dark ? "#2C3340" : "#E2DED4"}" stroke="${ink}" stroke-width="2" opacity="0.95"/>`);
      s.add(`<path d="M${CX + dx} ${CY + dy} L${CX + dx + 12} ${CY + dy - 28}" stroke="${ink}" stroke-width="3" stroke-linecap="round"/>`);
    }
  }
  if (sp.sub === "small_seconds") {
    s.add(`<circle cx="${CX}" cy="${CY + rIdx * 0.5}" r="${fmt(rIdx * 0.22)}" fill="none" stroke="${ink}" stroke-width="2" opacity="0.7"/>`);
    s.add(`<path d="M${CX} ${fmt(CY + rIdx * 0.5)} L${CX + 10} ${fmt(CY + rIdx * 0.5 - rIdx * 0.18)}" stroke="${ink}" stroke-width="2.5"/>`);
  }
  if (sp.date) {
    const x = CX + rIdxX * (sp.shape === "rect" ? 0.55 : 0.62);
    s.add(`<rect x="${fmt(x - 18)}" y="${CY - 15}" width="36" height="30" rx="3" fill="#FAFAFA" stroke="${p.dark}" stroke-width="2.5"/>`);
  }
  // hands at 10:10
  const hand = (deg: number, len: number, w: number, color: string) => {
    const a = ((deg - 90) * Math.PI) / 180;
    const x = CX + Math.cos(a) * len;
    const y = CY + Math.sin(a) * len;
    const nx = -Math.sin(a) * w;
    const ny = Math.cos(a) * w;
    s.add(`<path d="M${fmt(CX + nx)} ${fmt(CY + ny)} L${fmt(x + nx * 0.35)} ${fmt(y + ny * 0.35)} L${fmt(x)} ${fmt(y)} L${fmt(x - nx * 0.35)} ${fmt(y - ny * 0.35)} L${fmt(CX - nx)} ${fmt(CY - ny)} Z" fill="${color}" stroke="${p.deep}" stroke-width="1.5"/>`);
  };
  const handCol = dark ? p.hi : p.dark;
  hand(305, rIdx * 0.58, 9, handCol);
  hand(60, rIdx * 0.85, 7, handCol);
  if (sp.sub !== "small_seconds") {
    const a = ((180 - 90) * Math.PI) / 180;
    s.add(`<path d="M${fmt(CX - Math.cos(a) * 40)} ${fmt(CY - Math.sin(a) * 40)} L${fmt(CX + Math.cos(a) * rIdx * 0.92)} ${fmt(CY + Math.sin(a) * rIdx * 0.92)}" stroke="${sp.bezel === "diver" || sp.indices === "field" ? "#D9452B" : handCol}" stroke-width="3"/>`);
  }
  bead(s, CX, CY, 12, p);
  // crystal glint
  s.add(`<path d="${caseOutline(sp, -bezelW - 4)}" fill="none" stroke="#FFFFFF" stroke-width="2" opacity="0.25"/>`);
  s.add(`<ellipse cx="${CX - rIdx * 0.42}" cy="${CY - rIdx * 0.5}" rx="${fmt(rIdx * 0.36)}" ry="${fmt(rIdx * 0.12)}" fill="#FFFFFF" opacity="0.13" transform="rotate(-35 ${fmt(CX - rIdx * 0.42)} ${fmt(CY - rIdx * 0.5)})"/>`);

  return {
    svg: s.toString(),
    anchors: {
      watch_anchor_point: [
        [CX, STRAP_TOP],
        [CX, STRAP_BOTTOM],
        [CX, CY - sp.hh],
        [CX, CY + sp.hh],
      ],
    },
    fit: { w: 700, h: 980 },
  };
}

/**
 * Earrings: ONE earring, straight front view, centred on white (api_matrix.md §9: "single earring, clear front
 * view, unobstructed"). Anchor = the point that sits in the ear lobe (`earring_anchor_point`).
 */
import type { Design, RenderOut } from "../design";
import {
  Svg,
  bead,
  bezel,
  chain,
  fmt,
  gem,
  metalPalette,
  pave,
  pearl,
  prongs,
  tube,
  type MetalPalette,
  type StoneColor,
} from "../svg";

const CX = 512;

/** French ear wire whose bottom loop is at (x, y). Returns the lobe point. */
function earWire(s: Svg, p: MetalPalette, x: number, y: number): [number, number] {
  const d = `M${x} ${y} L${x} ${y - 40} C${x} ${y - 125} ${x + 78} ${y - 150} ${x + 100} ${y - 98} C${x + 112} ${y - 66} ${x + 104} ${y - 28} ${x + 92} ${y + 8}`;
  tube(s, d, 10, p);
  bead(s, x, y - 34, 11, p);
  return [x + 44, y - 128];
}

/** Small post stud with a round stone or bead at (x, y). Returns the lobe point. */
function postTop(s: Svg, p: MetalPalette, x: number, y: number, r: number, stone?: StoneColor): [number, number] {
  if (stone) {
    bezel(s, "round", x, y, r * 2, r * 2, p, 0.22);
    gem(s, "round", x, y, r * 2, r * 2, stone);
  } else {
    bead(s, x, y, r, p);
  }
  return [x, y];
}

function jumpRing(s: Svg, p: MetalPalette, x: number, y1: number, y2: number): void {
  const h = Math.abs(y2 - y1);
  s.add(`<ellipse cx="${x}" cy="${fmt((y1 + y2) / 2)}" rx="${fmt(Math.max(8, h * 0.35))}" ry="${fmt(h / 2)}" fill="none" stroke="${p.dark}" stroke-width="7"/>`);
  s.add(`<ellipse cx="${x}" cy="${fmt((y1 + y2) / 2)}" rx="${fmt(Math.max(8, h * 0.35))}" ry="${fmt(h / 2)}" fill="none" stroke="${p.light}" stroke-width="3"/>`);
}

function hoopArc(cx: number, cy: number, rx: number, ry: number, gapDeg = 14): string {
  const a0 = ((-90 + gapDeg / 2) * Math.PI) / 180;
  const a1 = ((270 - gapDeg / 2) * Math.PI) / 180;
  const x0 = cx + Math.cos(a0) * rx;
  const y0 = cy + Math.sin(a0) * ry;
  const x1 = cx + Math.cos(a1) * rx;
  const y1 = cy + Math.sin(a1) * ry;
  return `M${fmt(x0)} ${fmt(y0)} A${rx} ${ry} 0 1 1 ${fmt(x1)} ${fmt(y1)}`;
}

function paveAlong(s: Svg, p: MetalPalette, cx: number, cy: number, rx: number, ry: number, r: number, from: number, to: number, n: number, color: StoneColor): void {
  for (let i = 0; i < n; i++) {
    const t = from + ((to - from) * i) / (n - 1);
    pave(s, cx + Math.cos(t) * rx, cy + Math.sin(t) * ry, r, p, color);
  }
}

function polygon(cx: number, cy: number, r: number, sides: number, rot = -Math.PI / 2, sy = 1): string {
  const pts: string[] = [];
  for (let i = 0; i < sides; i++) {
    const a = rot + (i / sides) * Math.PI * 2;
    pts.push(`${fmt(cx + Math.cos(a) * r)} ${fmt(cy + Math.sin(a) * r * sy)}`);
  }
  return `M${pts.join(" L")} Z`;
}

export function renderEarring(d: Design): RenderOut {
  const s = new Svg();
  const p = metalPalette(d.metal);
  const p2 = metalPalette(d.metal, "secondary");
  const stone = d.stone ?? "clear";
  const pv = d.pave ?? "clear";
  const tone = d.pearl ?? "cream";
  let anchor: [number, number] = [CX, 512];
  let fit = { w: 680, h: 900 };

  switch (d.variant) {
    // ---------- stud_small ----------
    case "stud_prong":
      gem(s, "round", CX, 512, 300, 300, stone);
      prongs(s, CX, 512, 300, 300, p2, 4);
      fit = { w: 560, h: 560 };
      break;
    case "stud_bezel":
      bezel(s, "round", CX, 512, 260, 260, p, 0.24);
      gem(s, "round", CX, 512, 260, 260, stone);
      fit = { w: 540, h: 540 };
      break;
    case "stud_dome":
      bead(s, CX, 512, 170, p);
      s.add(`<ellipse cx="${CX}" cy="512" rx="120" ry="120" fill="none" stroke="${p.hi}" stroke-width="5" opacity="0.5"/>`);
      fit = { w: 520, h: 520 };
      break;
    case "stud_pearl":
      s.add(`<ellipse cx="${CX}" cy="650" rx="70" ry="22" fill="${s.metalFill(p)}" stroke="${p.deep}" stroke-width="2"/>`);
      pearl(s, CX, 512, 165, tone);
      fit = { w: 540, h: 560 };
      break;
    case "stud_flower":
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
        const x = CX + Math.cos(a) * 105;
        const y = 512 + Math.sin(a) * 105;
        s.add(`<ellipse cx="${fmt(x)}" cy="${fmt(y)}" rx="95" ry="66" fill="${s.metalFill(p)}" stroke="${p.deep}" stroke-width="3" transform="rotate(${fmt((a * 180) / Math.PI)} ${fmt(x)} ${fmt(y)})"/>`);
      }
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
        pave(s, CX + Math.cos(a) * 120, 512 + Math.sin(a) * 120, 26, p, pv);
      }
      bezel(s, "round", CX, 512, 110, 110, p, 0.2);
      gem(s, "round", CX, 512, 110, 110, stone);
      fit = { w: 580, h: 580 };
      break;

    // ---------- stud_statement ----------
    case "statement_cluster":
      s.add(`<circle cx="${CX}" cy="512" r="250" fill="${s.metalFill(p)}" stroke="${p.deep}" stroke-width="3"/>`);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const x = CX + Math.cos(a) * 165;
        const y = 512 + Math.sin(a) * 165;
        gem(s, "round", x, y, 120, 120, i % 2 ? pv : stone);
        prongs(s, x, y, 120, 120, p2, 4);
      }
      gem(s, "round", CX, 512, 170, 170, stone);
      prongs(s, CX, 512, 170, 170, p2, 6);
      fit = { w: 760, h: 760 };
      break;
    case "statement_button": {
      s.add(`<circle cx="${CX}" cy="512" r="270" fill="${s.metalDome(p)}" stroke="${p.deep}" stroke-width="4"/>`);
      const rays: string[] = [];
      for (let i = 0; i < 48; i++) {
        const a = (i / 48) * Math.PI * 2;
        rays.push(`M${fmt(CX + Math.cos(a) * 70)} ${fmt(512 + Math.sin(a) * 70)} L${fmt(CX + Math.cos(a) * 250)} ${fmt(512 + Math.sin(a) * 250)}`);
      }
      s.add(`<path d="${rays.join(" ")}" stroke="${p.dark}" stroke-width="3" opacity="0.55"/>`);
      s.add(`<circle cx="${CX}" cy="512" r="258" fill="none" stroke="${p.light}" stroke-width="10"/>`);
      bead(s, CX, 512, 64, p);
      fit = { w: 760, h: 760 };
      break;
    }
    case "statement_halo":
      s.add(`<rect x="${CX - 215}" y="297" width="430" height="430" rx="120" fill="${s.metalFill(p)}" stroke="${p.deep}" stroke-width="3"/>`);
      for (let i = 0; i < 20; i++) {
        const a = (i / 20) * Math.PI * 2;
        const k = 1 / Math.max(Math.abs(Math.cos(a)), Math.abs(Math.sin(a)));
        const r = 175 * Math.min(k, 1.18);
        pave(s, CX + Math.cos(a) * r, 512 + Math.sin(a) * r, 22, p, pv);
      }
      gem(s, "cushion", CX, 512, 260, 260, stone);
      prongs(s, CX, 512, 260, 260, p2, 4);
      fit = { w: 720, h: 720 };
      break;
    case "statement_bar":
      s.add(`<rect x="${CX - 300}" y="452" width="600" height="120" rx="60" fill="${s.metalFill(p, "vert")}" stroke="${p.deep}" stroke-width="3"/>`);
      for (let i = 0; i < 9; i++) pave(s, CX - 240 + i * 60, 512, 24, p, pv);
      anchor = [CX, 512];
      fit = { w: 820, h: 300 };
      break;

    // ---------- hoop_round_large ----------
    case "hoop_plain_large":
    case "hoop_twisted":
    case "hoop_pave_large":
    case "hoop_hammered": {
      const cy = 540;
      const r = 330;
      const arc = hoopArc(CX, cy, r, r);
      tube(s, arc, 50, p);
      if (d.metal === "mixed_two_tone") tube(s, hoopArc(CX, cy, r - 12, r - 12), 16, p2);
      if (d.variant === "hoop_twisted") {
        s.add(`<path d="${arc}" fill="none" stroke="${p.dark}" stroke-width="50" stroke-dasharray="4 22" opacity="0.55"/>`);
        s.add(`<path d="${arc}" fill="none" stroke="${p.hi}" stroke-width="30" stroke-dasharray="3 23" stroke-dashoffset="9" opacity="0.6"/>`);
      }
      if (d.variant === "hoop_pave_large") paveAlong(s, p, CX, cy, r, r, 16, -0.15, Math.PI + 0.15, 22, pv);
      if (d.variant === "hoop_hammered") {
        for (let i = 0; i < 36; i++) {
          const t = -Math.PI / 2 + 0.2 + (i / 36) * (Math.PI * 2 - 0.4);
          const off = ((i * 37) % 11) - 5;
          s.add(`<ellipse cx="${fmt(CX + Math.cos(t) * (r + off))}" cy="${fmt(cy + Math.sin(t) * (r + off))}" rx="9" ry="6" fill="${p.hi}" opacity="0.7" transform="rotate(${fmt((t * 180) / Math.PI)} ${fmt(CX + Math.cos(t) * (r + off))} ${fmt(cy + Math.sin(t) * (r + off))})"/>`);
        }
      }
      anchor = [CX, cy - r];
      fit = { w: 820, h: 820 };
      break;
    }

    // ---------- hoop_small_medium ----------
    case "huggie":
    case "huggie_pave":
    case "huggie_charm":
    case "huggie_pearl":
    case "hoop_thin": {
      const thin = d.variant === "hoop_thin";
      const cy = thin ? 470 : 400;
      const r = thin ? 230 : 160;
      const arc = hoopArc(CX, cy, r, r, thin ? 10 : 18);
      tube(s, arc, thin ? 24 : 62, p);
      if (d.metal === "mixed_two_tone") tube(s, hoopArc(CX, cy, r - (thin ? 4 : 18), r - (thin ? 4 : 18), thin ? 10 : 18), thin ? 8 : 20, p2);
      if (d.variant === "huggie_pave") paveAlong(s, p, CX, cy, r, r, 18, 0.05, Math.PI - 0.05, 9, pv);
      if (d.variant === "huggie_charm") {
        jumpRing(s, p2, CX, cy + r + 10, cy + r + 60);
        bezel(s, "round", CX, cy + r + 140, 150, 150, p, 0.2);
        gem(s, "round", CX, cy + r + 140, 150, 150, stone);
      }
      if (d.variant === "huggie_pearl") {
        jumpRing(s, p2, CX, cy + r + 10, cy + r + 60);
        bead(s, CX, cy + r + 78, 18, p);
        pearl(s, CX, cy + r + 185, 95, tone);
      }
      anchor = [CX, cy - r];
      fit = d.variant === "huggie_charm" || d.variant === "huggie_pearl" ? { w: 600, h: 860 } : { w: 640, h: 640 };
      break;
    }

    // ---------- hoop_oval_curved ----------
    case "oval_hoop":
    case "oval_pave": {
      const cy = 520;
      const arc = hoopArc(CX, cy, 205, 330, 12);
      tube(s, arc, 44, p);
      if (d.metal === "mixed_two_tone") tube(s, hoopArc(CX, cy, 195, 320, 12), 14, p2);
      if (d.variant === "oval_pave") paveAlong(s, p, CX, cy, 205, 330, 15, 0.1, Math.PI - 0.1, 15, pv);
      anchor = [CX, cy - 330];
      fit = { w: 560, h: 860 };
      break;
    }
    case "wave_hoop": {
      const dd = `M${CX + 14} 190 C${CX + 230} 200 ${CX + 300} 420 ${CX + 200} 600 C${CX + 120} 760 ${CX - 60} 860 ${CX - 190} 760 C${CX - 300} 660 ${CX - 180} 520 ${CX - 240} 380 C${CX - 280} 290 ${CX - 140} 190 ${CX - 14} 190`;
      tube(s, dd, 38, p);
      anchor = [CX, 190];
      fit = { w: 640, h: 860 };
      break;
    }
    case "crescent": {
      const crescent = `M${CX - 30} 190 C${CX - 330} 230 ${CX - 380} 640 ${CX - 120} 790 C${CX + 80} 900 ${CX + 300} 800 ${CX + 330} 620 C${CX + 230} 760 ${CX + 20} 790 ${CX - 110} 690 C${CX - 260} 560 ${CX - 220} 300 ${CX - 30} 190 Z`;
      s.add(`<path d="${crescent}" fill="${s.metalFill(p)}" stroke="${p.deep}" stroke-width="4"/>`);
      s.add(`<path d="M${CX - 60} 260 C${CX - 260} 360 ${CX - 260} 620 ${CX - 110} 740" fill="none" stroke="${p.hi}" stroke-width="8" opacity="0.7"/>`);
      tube(s, `M${CX - 30} 190 L${CX + 30} 180`, 10, p);
      anchor = [CX, 185];
      fit = { w: 680, h: 860 };
      break;
    }

    // ---------- drop_long_narrow ----------
    case "bar_drop": {
      const top = 260;
      anchor = earWire(s, p2, CX, top);
      jumpRing(s, p2, CX, top, top + 40);
      s.add(`<rect x="${CX - 15}" y="${top + 40}" width="30" height="560" rx="6" fill="${s.metalFill(p, "horiz")}" stroke="${p.deep}" stroke-width="2"/>`);
      fit = { w: 520, h: 900 };
      break;
    }
    case "chain_drop": {
      const top = 230;
      anchor = earWire(s, p2, CX, top);
      chain(s, `M${CX} ${top} L${CX} ${top + 470}`, 8, p, "cable");
      bezel(s, "round", CX, top + 520, 90, 90, p, 0.22);
      gem(s, "round", CX, top + 520, 90, 90, stone);
      fit = { w: 520, h: 900 };
      break;
    }
    case "linear_bezels": {
      anchor = postTop(s, p2, CX, 170, 48, pv);
      const sizes = [80, 100, 120, 150];
      let y = 170 + 48;
      for (const sz of sizes) {
        jumpRing(s, p2, CX, y, y + 28);
        y += 28 + sz / 2;
        bezel(s, "round", CX, y, sz, sz, p, 0.22);
        gem(s, "round", CX, y, sz, sz, stone);
        y += sz / 2 + 6;
      }
      fit = { w: 480, h: 900 };
      break;
    }
    case "threader": {
      chain(s, `M${CX} 150 C${CX + 6} 360 ${CX - 6} 560 ${CX} 820`, 7, p, "box");
      s.add(`<rect x="${CX - 6}" y="760" width="12" height="110" rx="5" fill="${s.metalFill(p, "horiz")}" stroke="${p.deep}" stroke-width="1.5"/>`);
      tube(s, `M${CX} 150 L${CX} 90`, 6, p);
      bezel(s, "round", CX, 190, 56, 56, p, 0.25);
      gem(s, "round", CX, 190, 56, 56, pv);
      anchor = [CX, 150];
      fit = { w: 360, h: 900 };
      break;
    }
    case "pearl_drop": {
      const top = 230;
      anchor = earWire(s, p2, CX, top);
      chain(s, `M${CX} ${top} L${CX} ${top + 320}`, 8, p, "cable");
      bead(s, CX, top + 330, 16, p);
      pearl(s, CX, top + 430, 92, tone);
      fit = { w: 520, h: 900 };
      break;
    }

    // ---------- drop_teardrop ----------
    case "halo_drop": {
      anchor = postTop(s, p2, CX, 180, 58, pv);
      jumpRing(s, p2, CX, 238, 290);
      const cy = 520;
      s.add(`<path d="M${CX} 296 C${CX + 120} 360 ${CX + 200} 450 ${CX + 200} 560 C${CX + 200} 690 ${CX + 110} 760 ${CX} 760 C${CX - 110} 760 ${CX - 200} 690 ${CX - 200} 560 C${CX - 200} 450 ${CX - 120} 360 ${CX} 296 Z" fill="${s.metalFill(p)}" stroke="${p.deep}" stroke-width="3"/>`);
      const n = 22;
      for (let i = 0; i < n; i++) {
        const t = (i / n) * Math.PI * 2;
        const x = CX + Math.sin(t) * 170 * (t < Math.PI * 0.35 || t > Math.PI * 1.65 ? 0.55 + 0.45 * Math.abs(Math.sin(t)) : 1);
        const y = cy + 30 - Math.cos(t) * 205;
        pave(s, x, y, 15, p, pv);
      }
      gem(s, "pear", CX, cy + 40, 250, 340, stone);
      prongs(s, CX, cy + 40, 250, 340, p2, 3);
      fit = { w: 600, h: 900 };
      break;
    }
    case "dew_bezel": {
      const top = 240;
      anchor = earWire(s, p2, CX, top);
      jumpRing(s, p2, CX, top, top + 46);
      bezel(s, "pear", CX, top + 230, 220, 330, p, 0.14);
      gem(s, "pear", CX, top + 230, 220, 330, stone);
      fit = { w: 560, h: 900 };
      break;
    }
    case "teardrop_outline": {
      const top = 220;
      anchor = earWire(s, p2, CX, top);
      jumpRing(s, p2, CX, top, top + 44);
      const t2 = top + 40;
      tube(s, `M${CX} ${t2} C${CX + 140} ${t2 + 110} ${CX + 210} ${t2 + 240} ${CX + 210} ${t2 + 360} C${CX + 210} ${t2 + 480} ${CX + 120} ${t2 + 560} ${CX} ${t2 + 560} C${CX - 120} ${t2 + 560} ${CX - 210} ${t2 + 480} ${CX - 210} ${t2 + 360} C${CX - 210} ${t2 + 240} ${CX - 140} ${t2 + 110} ${CX} ${t2} Z`, 30, p);
      fit = { w: 560, h: 900 };
      break;
    }
    case "pearl_teardrop": {
      anchor = postTop(s, p2, CX, 190, 44);
      bead(s, CX, 260, 22, p);
      s.add(`<path d="M${CX - 40} 285 Q${CX} 260 ${CX + 40} 285 L${CX + 30} 310 L${CX - 30} 310 Z" fill="${s.metalFill(p)}" stroke="${p.deep}" stroke-width="2"/>`);
      pearl(s, CX, 470, 135, tone, 175);
      fit = { w: 480, h: 860 };
      break;
    }
    case "pear_big": {
      anchor = postTop(s, p2, CX, 170, 50, pv);
      jumpRing(s, p2, CX, 222, 270);
      gem(s, "pear", CX, 500, 300, 420, stone);
      prongs(s, CX, 500, 300, 420, p2, 3);
      fit = { w: 560, h: 900 };
      break;
    }

    // ---------- drop_wide_bottom ----------
    case "fan": {
      const top = 230;
      anchor = earWire(s, p2, CX, top);
      jumpRing(s, p2, CX, top, top + 40);
      const y0 = top + 46;
      const y1 = y0 + 380;
      s.add(`<path d="M${CX} ${y0} L${CX + 220} ${y1} Q${CX} ${y1 + 60} ${CX - 220} ${y1} Z" fill="${s.metalFill(p)}" stroke="${p.deep}" stroke-width="3"/>`);
      const rays: string[] = [];
      for (let i = -6; i <= 6; i++) rays.push(`M${CX} ${y0 + 20} L${fmt(CX + i * 34)} ${fmt(y1 + 20 - Math.abs(i) * 3)}`);
      s.add(`<path d="${rays.join(" ")}" stroke="${p.dark}" stroke-width="2.5" opacity="0.6"/>`);
      for (let i = -5; i <= 5; i++) bead(s, CX + i * 40, y1 + 28 - Math.abs(i) * 4, 12, p);
      fit = { w: 620, h: 900 };
      break;
    }
    case "bell": {
      const top = 230;
      anchor = earWire(s, p2, CX, top);
      jumpRing(s, p2, CX, top, top + 40);
      const y0 = top + 46;
      s.add(`<path d="M${CX - 40} ${y0} C${CX - 60} ${y0 + 120} ${CX - 120} ${y0 + 220} ${CX - 200} ${y0 + 320} Q${CX} ${y0 + 380} ${CX + 200} ${y0 + 320} C${CX + 120} ${y0 + 220} ${CX + 60} ${y0 + 120} ${CX + 40} ${y0} Z" fill="${s.metalFill(p)}" stroke="${p.deep}" stroke-width="3"/>`);
      s.add(`<path d="M${CX - 20} ${y0 + 30} C${CX - 40} ${y0 + 140} ${CX - 90} ${y0 + 220} ${CX - 150} ${y0 + 300}" fill="none" stroke="${p.hi}" stroke-width="10" opacity="0.6"/>`);
      bezel(s, "round", CX, y0 + 300, 60, 60, p, 0.2);
      gem(s, "round", CX, y0 + 300, 60, 60, stone);
      fit = { w: 600, h: 860 };
      break;
    }
    case "tassel": {
      const top = 220;
      anchor = earWire(s, p2, CX, top);
      s.add(`<path d="M${CX - 34} ${top + 10} H${CX + 34} L${CX + 44} ${top + 90} H${CX - 44} Z" fill="${s.metalFill(p)}" stroke="${p.deep}" stroke-width="2"/>`);
      for (let i = -6; i <= 6; i++) {
        const x2 = CX + i * 26;
        const y2 = top + 600 - Math.abs(i) * 6;
        chain(s, `M${CX + i * 6} ${top + 92} Q${CX + i * 12} ${top + 300} ${x2} ${y2}`, 5, p, "cable");
        bead(s, x2, y2 + 8, 9, p);
      }
      fit = { w: 560, h: 900 };
      break;
    }
    case "triangle_pave": {
      const top = 230;
      anchor = earWire(s, p2, CX, top);
      jumpRing(s, p2, CX, top, top + 40);
      const y0 = top + 60;
      const y1 = y0 + 400;
      tube(s, `M${CX} ${y0} L${CX + 220} ${y1} L${CX - 220} ${y1} Z`, 46, p);
      for (let i = 0; i < 7; i++) pave(s, CX - 180 + i * 60, y1, 15, p, pv);
      for (let i = 1; i < 6; i++) {
        pave(s, CX + i * 34, y0 + i * 62, 15, p, pv);
        pave(s, CX - i * 34, y0 + i * 62, 15, p, pv);
      }
      fit = { w: 620, h: 900 };
      break;
    }

    // ---------- chandelier ----------
    case "chandelier_gems":
    case "chandelier_pearl":
    case "chandelier_filigree":
    case "chandelier_classic": {
      const top = 210;
      anchor = earWire(s, p2, CX, top);
      const g1 = top + 70;
      const isPearl = d.variant === "chandelier_pearl";
      const isFil = d.variant === "chandelier_filigree";
      const cut = d.variant === "chandelier_classic" ? "marquise" : "round";
      jumpRing(s, p2, CX, top, top + 40);
      if (isFil) bead(s, CX, g1, 26, p);
      else {
        bezel(s, "round", CX, g1, 60, 60, p, 0.2);
        gem(s, "round", CX, g1, 60, 60, stone);
      }
      const a1 = g1 + 70;
      const a2 = a1 + 170;
      // y on the symmetric quadratic arcs, so struts and dangles start exactly on the metal
      const arcY = (x: number, half: number, yEnd: number, yCtl: number) => {
        const t = (x - (CX - half)) / (2 * half);
        return (1 - t) * (1 - t) * yEnd + 2 * t * (1 - t) * yCtl + t * t * yEnd;
      };
      const arc1 = (x: number) => arcY(x, 150, a1 + 30, a1 - 50);
      const arc2 = (x: number) => arcY(x, 230, a2 + 40, a2 - 60);
      tube(s, `M${CX - 150} ${a1 + 30} Q${CX} ${a1 - 50} ${CX + 150} ${a1 + 30}`, 14, p);
      tube(s, `M${CX} ${g1 + 30} L${CX} ${fmt(arc1(CX))}`, 8, p2);
      tube(s, `M${CX - 230} ${a2 + 40} Q${CX} ${a2 - 60} ${CX + 230} ${a2 + 40}`, 14, p);
      if (isFil) {
        for (const k of [-1, 1]) {
          s.add(`<circle cx="${CX + k * 75}" cy="${a1 + 48}" r="44" fill="none" stroke="${p.mid}" stroke-width="9"/>`);
          s.add(`<circle cx="${CX + k * 75}" cy="${a1 + 66}" r="22" fill="none" stroke="${p.dark}" stroke-width="6"/>`);
        }
      }
      for (const i of [-1, 0, 1]) {
        const x = CX + i * 120;
        tube(s, `M${x} ${fmt(arc1(x))} L${x} ${fmt(arc2(x))}`, 6, p);
      }
      for (const i of [-2, -1, 0, 1, 2]) {
        const x = CX + i * 105;
        const y0 = arc2(x) - 2;
        const len = 150 - Math.abs(i) * 30;
        chain(s, `M${x} ${fmt(y0)} L${x} ${fmt(y0 + len)}`, 6, p, "cable");
        const yy = y0 + len + 40;
        if (isPearl) pearl(s, x, yy, 34, tone, 40);
        else if (isFil) bead(s, x, yy - 20, 20, p);
        else {
          gem(s, cut, x, yy + (cut === "marquise" ? 8 : 0), cut === "marquise" ? 44 : 64, cut === "marquise" ? 96 : 64, i === 0 ? stone : pv);
          if (cut === "round") prongs(s, x, yy, 64, 64, p2, 4);
        }
      }
      fit = { w: 640, h: 920 };
      break;
    }

    // ---------- chandelier_short ----------
    case "short_chandelier_gems":
    case "short_pearl": {
      anchor = postTop(s, p2, CX, 230, 46, d.variant === "short_pearl" ? undefined : pv);
      tube(s, `M${CX - 260} 340 Q${CX} 250 ${CX + 260} 340`, 16, p);
      tube(s, `M${CX} 276 L${CX} 300`, 8, p);
      for (let i = -3; i <= 3; i++) {
        const x = CX + i * 82;
        const y0 = 318 - (3 - Math.abs(i)) * 9 + Math.abs(i) * 10;
        const len = 140 - Math.abs(i) * 26;
        chain(s, `M${x} ${y0} L${x} ${y0 + len}`, 6, p, "cable");
        if (d.variant === "short_pearl") pearl(s, x, y0 + len + 34, 32, tone, 36);
        else {
          gem(s, "pear", x, y0 + len + 40, 54, 80, Math.abs(i) % 2 ? pv : stone);
        }
      }
      fit = { w: 860, h: 560 };
      break;
    }
    case "fringe": {
      anchor = postTop(s, p2, CX, 250, 40);
      s.add(`<rect x="${CX - 210}" y="300" width="420" height="34" rx="12" fill="${s.metalFill(p, "vert")}" stroke="${p.deep}" stroke-width="2"/>`);
      tube(s, `M${CX} 286 L${CX} 302`, 8, p);
      for (let i = -5; i <= 5; i++) {
        const x = CX + i * 38;
        const len = 230 - Math.abs(i) * 12;
        s.add(`<rect x="${x - 7}" y="336" width="14" height="${len}" rx="4" fill="${s.metalFill(p, "horiz")}" stroke="${p.deep}" stroke-width="1.5"/>`);
      }
      fit = { w: 760, h: 520 };
      break;
    }
    case "fan_chandelier": {
      anchor = postTop(s, p2, CX, 240, 44, pv);
      jumpRing(s, p2, CX, 284, 320);
      s.add(`<path d="M${CX} 330 L${CX + 250} 520 A260 220 0 0 1 ${CX - 250} 520 Z" fill="${s.metalFill(p)}" stroke="${p.deep}" stroke-width="3"/>`);
      for (let i = -3; i <= 3; i++) {
        const a = Math.PI / 2 + i * 0.26;
        const x = CX + Math.cos(a) * 270 * -1;
        const y = 330 + Math.sin(a) * 270;
        gem(s, "marquise", x, y - 40, 40, 90, i === 0 ? stone : pv);
      }
      fit = { w: 820, h: 620 };
      break;
    }

    // ---------- geometric_angular ----------
    case "geo_square_stud":
      s.add(`<rect x="${CX - 190}" y="322" width="380" height="380" rx="10" fill="${s.metalFill(p)}" stroke="${p.deep}" stroke-width="3"/>`);
      s.add(`<rect x="${CX - 130}" y="382" width="260" height="260" rx="6" fill="none" stroke="${p.dark}" stroke-width="5" opacity="0.7"/>`);
      gem(s, "square", CX, 512, 170, 170, stone);
      anchor = [CX, 512];
      fit = { w: 560, h: 560 };
      break;
    case "hex_drop": {
      const top = 230;
      anchor = earWire(s, p2, CX, top);
      jumpRing(s, p2, CX, top, top + 40);
      tube(s, polygon(CX, top + 272, 230, 6, -Math.PI / 2), 28, p);
      fit = { w: 560, h: 880 };
      break;
    }
    case "stacked_squares": {
      anchor = postTop(s, p2, CX, 170, 40);
      let y = 210;
      for (const size of [130, 180, 240]) {
        jumpRing(s, p2, CX, y, y + 26);
        y += 26;
        const half = size / 2;
        s.add(`<path d="${polygon(CX, y + half * 1.41, half * 1.41, 4, -Math.PI / 2)}" fill="none" stroke="${p.deep}" stroke-width="30" stroke-linejoin="miter"/>`);
        s.add(`<path d="${polygon(CX, y + half * 1.41, half * 1.41, 4, -Math.PI / 2)}" fill="none" stroke="${s.metalFill(p)}" stroke-width="22" stroke-linejoin="miter"/>`);
        y += half * 2.82;
      }
      fit = { w: 480, h: 900 };
      break;
    }
    case "kite": {
      const top = 230;
      anchor = earWire(s, p2, CX, top);
      jumpRing(s, p2, CX, top, top + 40);
      const y0 = top + 44;
      tube(s, `M${CX} ${y0} L${CX} ${y0 + 560}`, 8, p2);
      tube(s, `M${CX} ${y0} L${CX + 160} ${y0 + 230} L${CX} ${y0 + 560} L${CX - 160} ${y0 + 230} Z`, 26, p);
      gem(s, "marquise", CX, y0 + 270, 120, 300, stone);
      fit = { w: 520, h: 900 };
      break;
    }
    default:
      throw new Error(`unknown earring variant ${d.variant}`);
  }
  return { svg: s.toString(), anchors: { earring_anchor_point: anchor }, fit };
}

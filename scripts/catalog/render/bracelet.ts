/**
 * Bracelets: lying on its side and seen from about 45 degrees (three-quarter view, api_matrix.md §9), so the
 * loop reads as an ellipse with ry = r * cos 45°. The back half is drawn first, smaller and darker.
 * Anchors = left/right extremes of the loop (`bracelet_anchor_point`).
 */
import type { Design, RenderOut } from "../design";
import { Svg, sideShade, bead, bezel, chain, ellipsePt, fmt, gem, metalPalette, pave, pearl, type MetalPalette, type StoneColor } from "../svg";

const CX = 512;
const CY = 470;
const RX = 360;
const RY = 255;

/** Ellipse arc path between angles (radians, y down: PI/2 = front). */
function arcPath(cy: number, a0: number, a1: number, rx = RX, ry = RY): string {
  const steps = 48;
  const pts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = a0 + ((a1 - a0) * i) / steps;
    pts.push(`${fmt(CX + Math.cos(t) * rx)} ${fmt(cy + Math.sin(t) * ry)}`);
  }
  return `M${pts.join(" L")}`;
}

/** Perspective factor: 1 at the front (t = PI/2), ~0.78 at the back. */
const depth = (t: number) => 0.89 + 0.11 * Math.sin(t);

/** Places items around the loop, back half first. */
function around(n: number, draw: (x: number, y: number, k: number, t: number) => void, cy = CY, skipBack = 0): void {
  const ts = Array.from({ length: n }, (_, i) => (i / n) * Math.PI * 2 + Math.PI / 2);
  const back = ts.filter((t) => Math.sin(t) < 0);
  const front = ts.filter((t) => Math.sin(t) >= 0);
  for (const t of [...back, ...front]) {
    if (skipBack && Math.sin(t) < -1 + skipBack) continue;
    const q = ellipsePt(CX, cy, RX, RY, t);
    draw(q.x, q.y, depth(t), t);
  }
}

/** Solid bangle or cuff: a sweep of arcs from the bottom edge to the top edge. */
function solid(s: Svg, p: MetalPalette, h: number, t: number, gap = 0, stripe?: MetalPalette): void {
  const a0 = -Math.PI / 2 + gap;
  const a1 = (3 * Math.PI) / 2 - gap;
  const steps = Math.max(8, Math.round(h / 1.5));
  // sweep from the bottom edge up to the top edge, then the polished top rim
  for (let i = steps; i >= 0; i--) {
    const y = CY + (h * i) / steps;
    s.add(`<path d="${arcPath(y, a0, a1)}" fill="none" stroke="${sideShade(p, 1 - i / steps)}" stroke-width="${t}" stroke-linecap="butt"/>`);
  }
  if (stripe) s.add(`<path d="${arcPath(CY + h / 2, a0, a1)}" fill="none" stroke="${stripe.mid}" stroke-width="${Math.max(6, t * 0.6)}"/>`);
  s.add(`<path d="${arcPath(CY, a0, a1)}" fill="none" stroke="${p.deep}" stroke-width="${t + 2}"/>`);
  s.add(`<path d="${arcPath(CY, a0, a1)}" fill="none" stroke="${s.metalFill(p, "horiz")}" stroke-width="${t}"/>`);
  s.add(`<path d="${arcPath(CY - t * 0.2, 0.2, Math.PI - 0.2)}" fill="none" stroke="${p.hi}" stroke-width="${Math.max(2, t * 0.18)}" opacity="0.8"/>`);
}

export function renderBracelet(d: Design): RenderOut {
  const s = new Svg();
  const p = metalPalette(d.metal);
  const p2 = metalPalette(d.metal, "secondary");
  const stone: StoneColor = d.stone ?? "clear";
  const pv: StoneColor = d.pave ?? "clear";
  const full = `M${CX - RX} ${CY} A${RX} ${RY} 0 1 0 ${CX + RX} ${CY} A${RX} ${RY} 0 1 0 ${CX - RX} ${CY} Z`;

  switch (d.variant) {
    case "tennis":
      chain(s, full, 8, p2, "box");
      around(40, (x, y, k) => {
        s.add(`<circle cx="${fmt(x)}" cy="${fmt(y)}" r="${fmt(22 * k)}" fill="${p.mid}" stroke="${p.deep}" stroke-width="2"/>`);
        gem(s, "round", x, y, 34 * k, 30 * k, stone);
      });
      break;
    case "bangle":
      solid(s, p, 24, 22, 0, d.metal === "mixed_two_tone" ? p2 : undefined);
      break;
    case "bangle_pave":
      solid(s, p, 28, 26);
      around(36, (x, y, k, t) => {
        if (Math.sin(t) > 0.05) pave(s, x, y + 2, 9 * k, p, pv);
      });
      break;
    case "bangle_station": {
      solid(s, p, 26, 22);
      const f = ellipsePt(CX, CY, RX, RY, Math.PI / 2);
      bezel(s, "oval", f.x, f.y + 4, 110, 80, p2, 0.18);
      gem(s, "oval", f.x, f.y + 4, 110, 80, stone);
      break;
    }
    case "cuff":
      solid(s, p, 90, 18, 0.42, d.metal === "mixed_two_tone" ? p2 : undefined);
      break;
    case "cuff_gem": {
      solid(s, p, 80, 18, 0.42);
      const f = ellipsePt(CX, CY, RX, RY, Math.PI / 2);
      bezel(s, "oval", f.x, f.y + 40, 120, 86, p2, 0.16);
      gem(s, "oval", f.x, f.y + 40, 120, 86, stone);
      break;
    }
    case "cuff_hammered":
      solid(s, p, 70, 18, 0.42);
      around(30, (x, y, k, t) => {
        if (Math.sin(t) > 0.1) s.add(`<ellipse cx="${fmt(x)}" cy="${fmt(y + 34)}" rx="${fmt(12 * k)}" ry="${fmt(8 * k)}" fill="${p.hi}" opacity="0.55"/>`);
      });
      break;
    case "curb":
    case "curb_heavy": {
      const big = d.variant === "curb_heavy";
      const n = big ? 30 : 36;
      let i = 0;
      around(n, (x, y, k, t) => {
        const ang = (Math.atan2(Math.cos(t) * RY, -Math.sin(t) * RX) * 180) / Math.PI + (i++ % 2 ? 18 : -18);
        const lx = (big ? 44 : 36) * k;
        const ly = (big ? 26 : 20) * k;
        const pp = d.metal === "mixed_two_tone" && i % 2 ? p2 : p;
        const tr = `rotate(${fmt(ang)} ${fmt(x)} ${fmt(y)})`;
        s.add(`<ellipse cx="${fmt(x)}" cy="${fmt(y)}" rx="${fmt(lx)}" ry="${fmt(ly)}" fill="none" stroke="${pp.deep}" stroke-width="${fmt((big ? 17 : 13) * k)}" transform="${tr}"/>`);
        s.add(`<ellipse cx="${fmt(x)}" cy="${fmt(y)}" rx="${fmt(lx)}" ry="${fmt(ly)}" fill="none" stroke="${s.metalFill(pp)}" stroke-width="${fmt((big ? 12 : 9) * k)}" transform="${tr}"/>`);
        s.add(`<ellipse cx="${fmt(x)}" cy="${fmt(y - ly * 0.6)}" rx="${fmt(lx * 0.5)}" ry="${fmt(2.5 * k)}" fill="${pp.hi}" opacity="0.8" transform="${tr}"/>`);
      });
      break;
    }
    case "paperclip":
      around(24, (x, y, k, t) => {
        const ang = (Math.atan2(Math.cos(t) * RY, -Math.sin(t) * RX) * 180) / Math.PI;
        s.add(`<rect x="${fmt(x - 60 * k)}" y="${fmt(y - 16 * k)}" width="${fmt(120 * k)}" height="${fmt(32 * k)}" rx="${fmt(16 * k)}" fill="none" stroke="${p.deep}" stroke-width="${fmt(11 * k)}" transform="rotate(${fmt(ang)} ${fmt(x)} ${fmt(y)})"/>`);
        s.add(`<rect x="${fmt(x - 60 * k)}" y="${fmt(y - 16 * k)}" width="${fmt(120 * k)}" height="${fmt(32 * k)}" rx="${fmt(16 * k)}" fill="none" stroke="${s.metalFill(p)}" stroke-width="${fmt(7 * k)}" transform="rotate(${fmt(ang)} ${fmt(x)} ${fmt(y)})"/>`);
      });
      break;
    case "beaded":
      chain(s, full, 4, p2, "box");
      around(30, (x, y, k, t) => {
        if (d.stone && d.stone !== "clear" && Math.round((t - Math.PI / 2) / ((Math.PI * 2) / 30)) % 3 !== 0) {
          s.add(`<circle cx="${fmt(x)}" cy="${fmt(y)}" r="${fmt(30 * k)}" fill="${s.stoneFill(d.stone)}" stroke="#00000033" stroke-width="2"/>`);
          s.add(`<circle cx="${fmt(x - 9 * k)}" cy="${fmt(y - 10 * k)}" r="${fmt(7 * k)}" fill="#FFFFFF" opacity="0.6"/>`);
        } else bead(s, x, y, 30 * k, p);
      });
      break;
    case "pearl_strand":
      chain(s, full, 3, p2, "box");
      around(32, (x, y, k) => pearl(s, x, y, 28 * k, d.pearl ?? "cream"));
      break;
    case "station":
      chain(s, full, 6, p, "cable");
      around(10, (x, y, k, t) => {
        if (Math.sin(t) > -0.2) {
          bezel(s, "round", x, y, 38 * k, 38 * k, p, 0.25);
          gem(s, "round", x, y, 38 * k, 38 * k, stone);
        }
      });
      break;
    case "rope":
      around(90, (x, y, k, t) => {
        const ang = (Math.atan2(Math.cos(t) * RY, -Math.sin(t) * RX) * 180) / Math.PI + 50;
        const tr = `rotate(${fmt(ang)} ${fmt(x)} ${fmt(y)})`;
        s.add(`<ellipse cx="${fmt(x)}" cy="${fmt(y)}" rx="${fmt(22 * k)}" ry="${fmt(9 * k)}" fill="${s.metalFill(p)}" stroke="${p.deep}" stroke-width="${fmt(2.2 * k)}" transform="${tr}"/>`);
      });
      break;
    case "box_link":
      around(26, (x, y, k, t) => {
        const ang = (Math.atan2(Math.cos(t) * RY, -Math.sin(t) * RX) * 180) / Math.PI;
        s.add(`<rect x="${fmt(x - 46 * k)}" y="${fmt(y - 22 * k)}" width="${fmt(92 * k)}" height="${fmt(44 * k)}" rx="${fmt(8 * k)}" fill="${s.metalFill(p, "vert")}" stroke="${p.deep}" stroke-width="2.5" transform="rotate(${fmt(ang)} ${fmt(x)} ${fmt(y)})"/>`);
      });
      break;
    default:
      throw new Error(`unknown bracelet variant ${d.variant}`);
  }
  return {
    svg: s.toString(),
    anchors: {
      bracelet_anchor_point: [
        [CX - RX, CY],
        [CX + RX, CY],
      ],
    },
    fit: { w: 880, h: 760 },
  };
}

/**
 * Rings: standing upright and turned about 45 degrees (three-quarter front view, api_matrix.md §9).
 * The band is an extruded ellipse (rx = r * cos 45°); the setting sits on top.
 * Anchors = the two farthest points of the inner edge of the front rim (`ring_anchor_point`).
 */
import type { Design, RenderOut } from "../design";
import { Svg, sideShade, bead, bezel, fmt, gem, metalPalette, pave, pearl, prongs, type MetalPalette, type StoneColor } from "../svg";

interface Band {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  t: number;
  dx: number;
}

/** Extruded band: sweep of ellipses from the back rim to the front rim. */
function band(s: Svg, p: MetalPalette, b: Band, opts: { gapTop?: number; stripe?: MetalPalette; brushed?: boolean } = {}): void {
  const steps = Math.max(8, Math.round(b.dx / 1.5));
  const arc = (cx: number) => {
    if (!opts.gapTop) return `M${fmt(cx - b.rx)} ${b.cy} A${b.rx} ${b.ry} 0 1 0 ${fmt(cx + b.rx)} ${b.cy} A${b.rx} ${b.ry} 0 1 0 ${fmt(cx - b.rx)} ${b.cy} Z`;
    const g = opts.gapTop;
    const a0 = -Math.PI / 2 + g;
    const a1 = (3 * Math.PI) / 2 - g;
    return `M${fmt(cx + Math.cos(a0) * b.rx)} ${fmt(b.cy + Math.sin(a0) * b.ry)} A${b.rx} ${b.ry} 0 1 1 ${fmt(cx + Math.cos(a1) * b.rx)} ${fmt(b.cy + Math.sin(a1) * b.ry)}`;
  };
  const back = b.cx + b.dx / 2;
  const front = b.cx - b.dx / 2;
  s.add(`<path d="${arc(back)}" fill="none" stroke="${p.deep}" stroke-width="${b.t + 3}"/>`);
  for (let i = 0; i <= steps; i++) {
    const x = back - (b.dx * i) / steps;
    s.add(`<path d="${arc(x)}" fill="none" stroke="${sideShade(p, i / steps)}" stroke-width="${b.t}"/>`);
  }
  if (opts.stripe) {
    const mid = (back + front) / 2;
    s.add(`<path d="${arc(mid)}" fill="none" stroke="${opts.stripe.mid}" stroke-width="${b.t}"/>`);
    s.add(`<path d="${arc(mid - 3)}" fill="none" stroke="${opts.stripe.light}" stroke-width="${b.t * 0.7}"/>`);
  }
  // front rim: polished highlight
  s.add(`<path d="${arc(front)}" fill="none" stroke="${p.deep}" stroke-width="${b.t + 2}"/>`);
  s.add(`<path d="${arc(front)}" fill="none" stroke="${s.metalFill(p)}" stroke-width="${b.t}"/>`);
  s.add(`<path d="${arc(front - b.t * 0.12)}" fill="none" stroke="${p.hi}" stroke-width="${Math.max(2, b.t * 0.16)}" opacity="${opts.brushed ? 0.35 : 0.8}"/>`);
  if (opts.brushed) s.add(`<path d="${arc(front)}" fill="none" stroke="${p.dark}" stroke-width="${b.t * 0.9}" stroke-dasharray="1 3" opacity="0.35"/>`);
}

function topOf(b: Band): { x: number; y: number } {
  return { x: b.cx - b.dx / 2, y: b.cy - b.ry };
}

/** Basket/gallery under a raised stone. */
function basket(s: Svg, p: MetalPalette, x: number, yTop: number, yBottom: number, w: number): void {
  s.add(`<path d="M${fmt(x - w / 2)} ${fmt(yTop)} L${fmt(x + w / 2)} ${fmt(yTop)} L${fmt(x + w * 0.18)} ${fmt(yBottom)} L${fmt(x - w * 0.18)} ${fmt(yBottom)} Z" fill="${s.metalFill(p, "horiz")}" stroke="${p.deep}" stroke-width="2.5"/>`);
}

export function renderRing(d: Design): RenderOut {
  const s = new Svg();
  const p = metalPalette(d.metal);
  const p2 = metalPalette(d.metal, "secondary");
  const stone: StoneColor = d.stone ?? "clear";
  const pv: StoneColor = d.pave ?? "clear";
  let b: Band = { cx: 512, cy: 600, rx: 175, ry: 250, t: 26, dx: 60 };

  switch (d.variant) {
    case "solitaire": {
      band(s, p, b);
      const tp = topOf(b);
      basket(s, p2, tp.x, tp.y - 70, tp.y + 6, 110);
      gem(s, "round", tp.x, tp.y - 110, 170, 120, stone);
      prongs(s, tp.x, tp.y - 110, 170, 120, p2, 4);
      break;
    }
    case "halo": {
      band(s, p, b);
      const tp = topOf(b);
      basket(s, p2, tp.x, tp.y - 60, tp.y + 6, 120);
      s.add(`<ellipse cx="${tp.x}" cy="${tp.y - 100}" rx="118" ry="86" fill="${s.metalFill(p)}" stroke="${p.deep}" stroke-width="2.5"/>`);
      for (let i = 0; i < 18; i++) {
        const a = (i / 18) * Math.PI * 2;
        pave(s, tp.x + Math.cos(a) * 102, tp.y - 100 + Math.sin(a) * 72, 11, p, pv);
      }
      gem(s, "cushion", tp.x, tp.y - 100, 150, 110, stone);
      prongs(s, tp.x, tp.y - 100, 150, 110, p2, 4);
      break;
    }
    case "three_stone": {
      band(s, p, b);
      const tp = topOf(b);
      basket(s, p2, tp.x, tp.y - 50, tp.y + 6, 200);
      for (const [dx, dy, w] of [
        [-100, -70, 90],
        [100, -70, 90],
        [0, -100, 140],
      ] as const) {
        gem(s, "oval", tp.x + dx, tp.y + dy, w, w * 0.75, dx === 0 ? stone : pv);
        prongs(s, tp.x + dx, tp.y + dy, w, w * 0.75, p2, 4);
      }
      break;
    }
    case "band_plain":
      b = { ...b, t: 42, dx: 110 };
      band(s, p, b, { stripe: d.metal === "mixed_two_tone" ? p2 : undefined });
      break;
    case "band_wide":
      b = { ...b, t: 56, dx: 170, rx: 185, ry: 260 };
      band(s, p, b, { brushed: true, stripe: d.metal === "mixed_two_tone" ? p2 : undefined });
      break;
    case "eternity": {
      b = { ...b, t: 34, dx: 60 };
      band(s, p, b);
      const fx = b.cx - b.dx / 2;
      for (let i = 0; i < 22; i++) {
        const a = (i / 22) * Math.PI * 2;
        const x = fx + Math.cos(a) * b.rx;
        const y = b.cy + Math.sin(a) * b.ry;
        if (Math.cos(a) > 0.92) continue;
        pave(s, x, y, 13, p, i % 2 && d.stone ? stone : pv);
      }
      break;
    }
    case "signet": {
      b = { ...b, t: 36, dx: 90 };
      band(s, p, b);
      const tp = topOf(b);
      s.add(`<path d="M${tp.x - 120} ${tp.y - 40} L${tp.x + 120} ${tp.y - 40} L${tp.x + 70} ${tp.y + 20} L${tp.x - 70} ${tp.y + 20} Z" fill="${s.metalFill(p, "horiz")}" stroke="${p.deep}" stroke-width="2.5"/>`);
      s.add(`<ellipse cx="${tp.x}" cy="${tp.y - 60}" rx="140" ry="74" fill="${s.metalFill(p)}" stroke="${p.deep}" stroke-width="3"/>`);
      if (d.stone && d.stone !== "clear") {
        s.add(`<ellipse cx="${tp.x}" cy="${tp.y - 60}" rx="108" ry="54" fill="${s.stoneFill(d.stone)}" stroke="${p.deep}" stroke-width="2"/>`);
        s.add(`<ellipse cx="${tp.x - 30}" cy="${tp.y - 78}" rx="34" ry="10" fill="#FFFFFF" opacity="0.35"/>`);
      } else {
        s.add(`<ellipse cx="${tp.x}" cy="${tp.y - 60}" rx="110" ry="56" fill="none" stroke="${p.dark}" stroke-width="3"/>`);
        s.add(`<path d="M${tp.x - 70} ${tp.y - 60} H${tp.x + 70} M${tp.x - 50} ${tp.y - 80} H${tp.x + 50} M${tp.x - 50} ${tp.y - 40} H${tp.x + 50}" stroke="${p.dark}" stroke-width="3" opacity="0.6"/>`);
      }
      break;
    }
    case "cocktail": {
      band(s, p, b);
      const tp = topOf(b);
      basket(s, p2, tp.x, tp.y - 70, tp.y + 6, 150);
      s.add(`<ellipse cx="${tp.x}" cy="${tp.y - 120}" rx="150" ry="112" fill="${s.metalFill(p)}" stroke="${p.deep}" stroke-width="2.5"/>`);
      for (let i = 0; i < 22; i++) {
        const a = (i / 22) * Math.PI * 2;
        pave(s, tp.x + Math.cos(a) * 134, tp.y - 120 + Math.sin(a) * 98, 11, p, pv);
      }
      gem(s, "oval", tp.x, tp.y - 120, 220, 160, stone);
      prongs(s, tp.x, tp.y - 120, 220, 160, p2, 4);
      break;
    }
    case "pearl_ring": {
      band(s, p, b);
      const tp = topOf(b);
      s.add(`<ellipse cx="${tp.x}" cy="${tp.y - 8}" rx="46" ry="18" fill="${s.metalFill(p)}" stroke="${p.deep}" stroke-width="2"/>`);
      pearl(s, tp.x, tp.y - 90, 92, d.pearl ?? "cream");
      break;
    }
    case "bypass": {
      b = { ...b, t: 22, dx: 50 };
      band(s, p, b, { gapTop: 0.32 });
      const fx = b.cx - b.dx / 2;
      const l = { x: fx + Math.cos(-Math.PI / 2 - 0.32) * b.rx, y: b.cy + Math.sin(-Math.PI / 2 - 0.32) * b.ry };
      const r = { x: fx + Math.cos(-Math.PI / 2 + 0.32) * b.rx, y: b.cy + Math.sin(-Math.PI / 2 + 0.32) * b.ry };
      bezel(s, "round", l.x, l.y - 10, 74, 74, p, 0.2);
      gem(s, "round", l.x, l.y - 10, 74, 74, stone);
      bead(s, r.x, r.y - 6, 30, p);
      break;
    }
    case "stack_thin": {
      b = { ...b, t: 14, dx: 26 };
      band(s, p, b);
      const tp = topOf(b);
      bezel(s, "round", tp.x, tp.y - 18, 52, 40, p, 0.25);
      gem(s, "round", tp.x, tp.y - 18, 52, 40, stone);
      break;
    }
    default:
      throw new Error(`unknown ring variant ${d.variant}`);
  }
  const fx = b.cx - b.dx / 2;
  const inner = b.ry - b.t / 2;
  return {
    svg: s.toString(),
    anchors: {
      ring_anchor_point: [
        [fx, b.cy - inner],
        [fx, b.cy + inner],
      ],
    },
    fit: { w: 760, h: 820 },
  };
}

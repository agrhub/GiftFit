/**
 * Necklaces: drawn "as worn", front view (api_matrix.md §9): the chain rises to both sides of the neck and
 * drapes to a depth set by `necklace_length_in`. Anchors = left/right chain ends (`necklace_anchor_point`).
 */
import type { Design, RenderOut } from "../design";
import { Svg, bead, bez, bezel, chain, fmt, gem, metalPalette, pave, pearl, prongs, tube, type MetalPalette, type Pt } from "../svg";

const CX = 512;
const TOP = 96;

interface Drape {
  d: string;
  left: Pt;
  right: Pt;
  bottom: Pt;
  /** Point on the drape at u in [0,1] (0 = left end, 0.5 = bottom, 1 = right end). */
  at(u: number): Pt;
}

/** Bottom depth (px) for a length in inches: choker 14 in is shallow, opera 34 in deep. */
export const depthFor = (lengthIn: number) => 200 + (lengthIn - 14) * 24;

function drape(lengthIn: number, extra = 0): Drape {
  const depth = depthFor(lengthIn) + extra;
  const hw = 160 + depth * 0.14;
  const yb = TOP + depth;
  // short necklaces hang as a round U, long ones narrow into a soft V
  const w2 = hw * (lengthIn <= 16 ? 0.95 : lengthIn <= 20 ? 0.75 : lengthIn <= 24 ? 0.55 : 0.38);
  const k = lengthIn <= 16 ? 0.75 : 0.6;
  const L: Pt = { x: CX - hw, y: TOP };
  const R: Pt = { x: CX + hw, y: TOP };
  const B: Pt = { x: CX, y: yb };
  const l1: Pt = { x: CX - hw, y: TOP + depth * k };
  const l2: Pt = { x: CX - w2, y: yb };
  const r1: Pt = { x: CX + w2, y: yb };
  const r2: Pt = { x: CX + hw, y: TOP + depth * k };
  const d = `M${fmt(L.x)} ${fmt(L.y)} C${fmt(l1.x)} ${fmt(l1.y)} ${fmt(l2.x)} ${fmt(l2.y)} ${fmt(B.x)} ${fmt(B.y)} C${fmt(r1.x)} ${fmt(r1.y)} ${fmt(r2.x)} ${fmt(r2.y)} ${fmt(R.x)} ${fmt(R.y)}`;
  return {
    d,
    left: L,
    right: R,
    bottom: B,
    at: (u: number) => (u <= 0.5 ? bez(L, l1, l2, B, u * 2) : bez(B, r1, r2, R, (u - 0.5) * 2)),
  };
}

function bail(s: Svg, p: MetalPalette, x: number, y: number, h = 34): number {
  s.add(`<rect x="${fmt(x - 9)}" y="${fmt(y - 6)}" width="18" height="${h}" rx="9" fill="${s.metalFill(p, "horiz")}" stroke="${p.deep}" stroke-width="2"/>`);
  return y + h - 8;
}

export function renderNecklace(d: Design): RenderOut {
  const s = new Svg();
  const p = metalPalette(d.metal);
  const p2 = metalPalette(d.metal, "secondary");
  const stone = d.stone ?? "clear";
  const pv = d.pave ?? "clear";
  const tone = d.pearl ?? "cream";
  const len = d.lengthIn ?? 18;
  let dr = drape(len);
  const chainW = 7;

  const fine = () => chain(s, dr.d, chainW, p2, "cable");

  switch (d.variant) {
    // ---------- pendant_v_y ----------
    case "lariat_y": {
      fine();
      const y0 = dr.bottom.y;
      chain(s, `M${CX} ${y0} L${CX} ${y0 + 150}`, 6, p, "cable");
      bezel(s, "round", CX, y0 + 185, 62, 62, p, 0.22);
      gem(s, "round", CX, y0 + 185, 62, 62, stone);
      break;
    }
    case "vee_bar": {
      fine();
      const B = dr.bottom;
      tube(s, `M${CX - 90} ${B.y - 70} L${CX} ${B.y + 10} L${CX + 90} ${B.y - 70}`, 18, p);
      break;
    }
    case "y_pearl": {
      fine();
      const y0 = dr.bottom.y;
      chain(s, `M${CX} ${y0} L${CX} ${y0 + 130}`, 6, p, "cable");
      bead(s, CX, y0 + 136, 10, p);
      pearl(s, CX, y0 + 180, 38, tone, 44);
      break;
    }
    case "plume_lariat": {
      fine();
      const y0 = dr.bottom.y;
      chain(s, `M${CX} ${y0} L${CX} ${y0 + 110}`, 6, p, "cable");
      s.add(`<path d="M${CX} ${y0 + 105} C${CX + 40} ${y0 + 150} ${CX + 34} ${y0 + 230} ${CX} ${y0 + 280} C${CX - 34} ${y0 + 230} ${CX - 40} ${y0 + 150} ${CX} ${y0 + 105} Z" fill="${s.metalFill(p)}" stroke="${p.deep}" stroke-width="2.5"/>`);
      s.add(`<path d="M${CX} ${y0 + 118} L${CX} ${y0 + 270}" stroke="${p.dark}" stroke-width="3"/>`);
      break;
    }
    case "vee_gem": {
      fine();
      const B = dr.bottom;
      const yb = bail(s, p2, CX, B.y);
      gem(s, "marquise", CX, yb + 70, 70, 150, stone);
      prongs(s, CX, yb + 70, 50, 150, p2, 4);
      break;
    }

    // ---------- pendant_curved ----------
    case "disc": {
      fine();
      const yb = bail(s, p2, CX, dr.bottom.y);
      s.add(`<circle cx="${CX}" cy="${yb + 70}" r="72" fill="${s.metalDome(p)}" stroke="${p.deep}" stroke-width="2.5"/>`);
      s.add(`<circle cx="${CX}" cy="${yb + 70}" r="60" fill="none" stroke="${p.dark}" stroke-width="2" opacity="0.6"/>`);
      break;
    }
    case "locket": {
      fine();
      const yb = bail(s, p2, CX, dr.bottom.y);
      s.add(`<ellipse cx="${CX}" cy="${yb + 92}" rx="74" ry="94" fill="${s.metalFill(p)}" stroke="${p.deep}" stroke-width="3"/>`);
      s.add(`<ellipse cx="${CX}" cy="${yb + 92}" rx="58" ry="76" fill="none" stroke="${p.dark}" stroke-width="3" stroke-dasharray="3 7" opacity="0.8"/>`);
      s.add(`<path d="M${CX - 22} ${yb + 92} Q${CX} ${yb + 60} ${CX + 22} ${yb + 92} Q${CX} ${yb + 124} ${CX - 22} ${yb + 92} Z" fill="none" stroke="${p.dark}" stroke-width="3" opacity="0.7"/>`);
      break;
    }
    case "halo_circle": {
      fine();
      const cy = dr.bottom.y + 70;
      tube(s, `M${CX} ${cy - 70} A70 70 0 1 1 ${CX - 0.1} ${cy - 70}`, 22, p);
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * Math.PI * 2;
        pave(s, CX + Math.cos(a) * 70, cy + Math.sin(a) * 70, 8, p, pv);
      }
      gem(s, "round", CX, cy, 56, 56, stone);
      prongs(s, CX, cy, 56, 56, p2, 4);
      tube(s, `M${CX} ${cy - 62} L${CX} ${cy - 30}`, 6, p2);
      break;
    }
    case "crescent_moon": {
      fine();
      const yb = bail(s, p2, CX, dr.bottom.y);
      const k = 0.34;
      const tx = CX - k * (CX - 30);
      const ty = yb - 6 - k * 190;
      const cres = `M${CX - 30} 190 C${CX - 330} 230 ${CX - 380} 640 ${CX - 120} 790 C${CX + 80} 900 ${CX + 300} 800 ${CX + 330} 620 C${CX + 230} 760 ${CX + 20} 790 ${CX - 110} 690 C${CX - 260} 560 ${CX - 220} 300 ${CX - 30} 190 Z`;
      s.add(`<path d="${cres}" fill="${s.metalFill(p)}" stroke="${p.deep}" stroke-width="7" transform="translate(${fmt(tx)} ${fmt(ty)}) scale(${k})"/>`);
      break;
    }
    case "pearl_orb": {
      fine();
      const y0 = dr.bottom.y;
      bead(s, CX, y0 + 6, 12, p);
      pearl(s, CX, y0 + 62, 50, tone);
      break;
    }

    // ---------- choker ----------
    case "ribbon_choker":
      tube(s, dr.d, 14, p);
      break;
    case "pearl_choker":
    case "bead_choker": {
      chain(s, dr.d, 4, p2, "box");
      const n = d.variant === "pearl_choker" ? 25 : 31;
      for (let i = 0; i < n; i++) {
        const q = dr.at(0.04 + (0.92 * i) / (n - 1));
        if (d.variant === "pearl_choker") pearl(s, q.x, q.y, 17, tone);
        else bead(s, q.x, q.y, 12, p);
      }
      break;
    }
    case "gem_choker": {
      chain(s, dr.d, 6, p2, "box");
      bezel(s, "round", CX, dr.bottom.y + 18, 50, 50, p, 0.22);
      gem(s, "round", CX, dr.bottom.y + 18, 50, 50, stone);
      break;
    }

    // ---------- choker_heavy ----------
    case "torque":
      tube(s, dr.d, 34, p);
      bead(s, dr.left.x, dr.left.y, 22, p);
      bead(s, dr.right.x, dr.right.y, 22, p);
      break;
    case "chunky_curb":
      chain(s, dr.d, 24, p, "curb");
      break;
    case "pave_choker": {
      tube(s, dr.d, 28, p);
      const n = 34;
      for (let i = 0; i < n; i++) {
        const q = dr.at(0.12 + (0.76 * i) / (n - 1));
        pave(s, q.x, q.y, 8.5, p, pv);
      }
      break;
    }
    case "herringbone": {
      tube(s, dr.d, 30, p, { cap: "butt" });
      s.add(`<path d="${dr.d}" fill="none" stroke="${p.dark}" stroke-width="26" stroke-dasharray="2 6" opacity="0.45"/>`);
      break;
    }

    // ---------- collar_bib_horizontal ----------
    case "leaf_bib": {
      fine();
      for (let row = 0; row < 2; row++) {
        const n = row === 0 ? 11 : 7;
        for (let i = 0; i < n; i++) {
          const u = 0.5 + (i - (n - 1) / 2) * 0.042;
          const q = dr.at(u);
          const y = q.y + 24 + row * 46;
          const ang = (i - (n - 1) / 2) * 7;
          s.add(`<ellipse cx="${fmt(q.x)}" cy="${fmt(y)}" rx="17" ry="32" fill="${s.metalFill(p)}" stroke="${p.deep}" stroke-width="2" transform="rotate(${fmt(ang)} ${fmt(q.x)} ${fmt(y)})"/>`);
          s.add(`<path d="M${fmt(q.x)} ${fmt(y - 26)} L${fmt(q.x)} ${fmt(y + 26)}" stroke="${p.dark}" stroke-width="2" transform="rotate(${fmt(ang)} ${fmt(q.x)} ${fmt(y)})"/>`);
        }
      }
      break;
    }
    case "layered_trio": {
      const a = drape(len);
      const b = drape(len, 50);
      const c = drape(len, 100);
      chain(s, a.d, 6, p, "cable");
      chain(s, b.d, 6, p2, "box");
      chain(s, c.d, 7, p, "rope");
      bead(s, CX, c.bottom.y + 6, 12, p);
      dr = a;
      break;
    }
    case "starlit_bib": {
      fine();
      for (let row = 0; row < 3; row++) {
        const n = 9 - row * 2;
        for (let i = 0; i < n; i++) {
          const u = 0.5 + (i - (n - 1) / 2) * 0.04;
          const q = dr.at(u);
          const y = q.y + 22 + row * 40;
          bezel(s, "round", q.x, y, 30, 30, p, 0.3);
          gem(s, "round", q.x, y, 30, 30, row === 1 ? stone : pv);
        }
      }
      break;
    }
    case "bar_collar": {
      fine();
      const y = dr.bottom.y;
      s.add(`<rect x="${CX - 130}" y="${y - 12}" width="260" height="24" rx="12" fill="${s.metalFill(p, "vert")}" stroke="${p.deep}" stroke-width="2"/>`);
      break;
    }

    // ---------- long_vertical ----------
    case "tassel_long": {
      fine();
      const y0 = dr.bottom.y;
      s.add(`<path d="M${CX - 20} ${y0} H${CX + 20} L${CX + 26} ${y0 + 50} H${CX - 26} Z" fill="${s.metalFill(p)}" stroke="${p.deep}" stroke-width="2"/>`);
      for (let i = -4; i <= 4; i++) chain(s, `M${CX + i * 5} ${y0 + 50} L${CX + i * 9} ${y0 + 170}`, 4, p, "cable");
      break;
    }
    case "long_bar": {
      fine();
      const y0 = dr.bottom.y;
      s.add(`<rect x="${CX - 9}" y="${y0 - 4}" width="18" height="170" rx="5" fill="${s.metalFill(p, "horiz")}" stroke="${p.deep}" stroke-width="2"/>`);
      break;
    }
    case "pearl_rope": {
      const n = 46;
      chain(s, dr.d, 3, p2, "box");
      for (let i = 0; i < n; i++) {
        const q = dr.at(0.02 + (0.96 * i) / (n - 1));
        pearl(s, q.x, q.y, 14, tone);
      }
      break;
    }
    case "medal": {
      chain(s, dr.d, 8, p, "curb");
      const yb = bail(s, p, CX, dr.bottom.y);
      const cy = yb + 66;
      s.add(`<circle cx="${CX}" cy="${cy}" r="66" fill="${s.metalDome(p)}" stroke="${p.deep}" stroke-width="3"/>`);
      s.add(`<circle cx="${CX}" cy="${cy}" r="54" fill="none" stroke="${p.dark}" stroke-width="2.5"/>`);
      const star: string[] = [];
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
        const r = i % 2 ? 14 : 42;
        star.push(`${fmt(CX + Math.cos(a) * r)} ${fmt(cy + Math.sin(a) * r)}`);
      }
      s.add(`<path d="M${star.join(" L")} Z" fill="${p.light}" stroke="${p.dark}" stroke-width="2"/>`);
      break;
    }
    case "station_long":
    case "station_fine": {
      chain(s, dr.d, d.variant === "station_fine" ? 4 : 5, p2, "cable");
      const n = d.variant === "station_fine" ? 5 : 9;
      for (let i = 0; i < n; i++) {
        const q = dr.at(0.5 + (i - (n - 1) / 2) * (d.variant === "station_fine" ? 0.09 : 0.085));
        bezel(s, "round", q.x, q.y, 24, 24, p, 0.32);
        gem(s, "round", q.x, q.y, 24, 24, stone);
      }
      break;
    }

    // ---------- thin_chain ----------
    case "fine_chain":
      chain(s, dr.d, 4, p, "cable");
      break;
    case "bead_chain":
      chain(s, dr.d, 4, p, "cable");
      bead(s, CX, dr.bottom.y, 13, p);
      break;
    case "rope_chain":
      chain(s, dr.d, 7, p, "rope");
      break;
    case "curb_chain":
      chain(s, dr.d, 10, p, "curb");
      break;
    case "box_chain":
      chain(s, dr.d, 6, p, "box");
      break;

    // ---------- large_stone ----------
    case "grand_oval":
    case "regent_halo":
    case "step_cut":
    case "statement_pear": {
      fine();
      const yb = bail(s, p2, CX, dr.bottom.y, 40);
      const cut = d.variant === "grand_oval" ? "oval" : d.variant === "regent_halo" ? "cushion" : d.variant === "step_cut" ? "emerald" : "pear";
      const w = cut === "cushion" ? 130 : 120;
      const h = cut === "cushion" ? 130 : cut === "pear" ? 190 : 160;
      const cy = yb + h / 2 + 10;
      if (cut === "cushion") {
        s.add(`<rect x="${CX - 92}" y="${cy - 92}" width="184" height="184" rx="50" fill="${s.metalFill(p)}" stroke="${p.deep}" stroke-width="2.5"/>`);
        for (let i = 0; i < 20; i++) {
          const a = (i / 20) * Math.PI * 2;
          const k = 1 / Math.max(Math.abs(Math.cos(a)), Math.abs(Math.sin(a)));
          const r = 78 * Math.min(k, 1.16);
          pave(s, CX + Math.cos(a) * r, cy + Math.sin(a) * r, 9, p, pv);
        }
        gem(s, cut, CX, cy, w, h, stone);
        prongs(s, CX, cy, w, h, p2, 4);
      } else {
        bezel(s, cut, CX, cy, w, h, p, 0.14);
        gem(s, cut, CX, cy, w, h, stone);
      }
      break;
    }

    // ---------- geometric_angular ----------
    case "square_pendant": {
      fine();
      const yb = bail(s, p2, CX, dr.bottom.y);
      s.add(`<rect x="${CX - 62}" y="${yb}" width="124" height="124" rx="4" fill="${s.metalFill(p)}" stroke="${p.deep}" stroke-width="3"/>`);
      gem(s, "square", CX, yb + 62, 64, 64, stone);
      break;
    }
    case "triangle_pendant": {
      fine();
      const y0 = dr.bottom.y;
      tube(s, `M${CX} ${y0} L${CX + 80} ${y0 + 140} L${CX - 80} ${y0 + 140} Z`, 16, p);
      break;
    }
    case "hex_pendant": {
      fine();
      const cy = dr.bottom.y + 78;
      const pts: string[] = [];
      for (let i = 0; i < 6; i++) {
        const a = -Math.PI / 2 + (i / 6) * Math.PI * 2;
        pts.push(`${fmt(CX + Math.cos(a) * 78)} ${fmt(cy + Math.sin(a) * 78)}`);
      }
      tube(s, `M${pts.join(" L")} Z`, 16, p);
      break;
    }
    case "kite_bar": {
      fine();
      const y0 = dr.bottom.y;
      s.add(`<path d="M${CX} ${y0 - 4} L${CX + 42} ${y0 + 80} L${CX} ${y0 + 210} L${CX - 42} ${y0 + 80} Z" fill="${s.metalFill(p)}" stroke="${p.deep}" stroke-width="3"/>`);
      s.add(`<path d="M${CX} ${y0 + 10} L${CX} ${y0 + 196}" stroke="${p.hi}" stroke-width="3" opacity="0.8"/>`);
      break;
    }
    default:
      throw new Error(`unknown necklace variant ${d.variant}`);
  }
  return {
    svg: s.toString(),
    anchors: {
      necklace_anchor_point: [
        [dr.left.x, dr.left.y],
        [dr.right.x, dr.right.y],
      ],
    },
    fit: { w: 900, h: 900 },
    maxScale: 1.5,
  };
}

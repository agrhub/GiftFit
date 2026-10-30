/** Render-time description of one product (not stored in catalog.json except via the SKU fields). */
import type { JewelryCategory, Metal } from "@/server/contracts/giftfit";
import type { PearlTone, StoneColor } from "./svg";

export interface Design {
  category: JewelryCategory;
  /** Renderer key, e.g. "hoop_plain_large", "solitaire", "dress_leather". */
  variant: string;
  metal: Metal;
  /** Main stone colour when the design has a gem slot. */
  stone?: StoneColor;
  /** Pearl tone when the design has a pearl slot. */
  pearl?: PearlTone;
  /** Small accent stones (pavé). */
  pave?: StoneColor;
  /** Necklaces only. */
  lengthIn?: number;
  /** Watches: dial colour, strap material, case size. */
  dial?: string;
  strap?: "leather_brown" | "leather_black" | "leather_tan" | "leather_green" | "mesh" | "link" | "canvas" | "rubber";
  /** Deterministic per-SKU variation (0..1). */
  jitter: number;
}

/** Anchor points in final 1024 px image coordinates, named after the YouCam 2d-vto parameters. */
export type Anchors = Record<string, number[] | number[][]>;

export interface RenderOut {
  svg: string;
  /** Anchor points in the SVG's own 1024 design space (transformed after trim/fit). */
  anchors: Anchors;
  /** Box (px) the trimmed object is scaled to fit inside the 1024 canvas. */
  fit: { w: number; h: number };
  /** Largest allowed magnification of the design (default 2). Keeps thin chains from being blown up. */
  maxScale?: number;
}

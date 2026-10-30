/**
 * Focused crop of try-on images per jewelry category (owner: A4). Full-frame try-ons make
 * earrings tiny, especially on phones and on deep skin tones, so each card opens on the area
 * the piece sits on. Fixed ratios of the frame, tuned on the committed showcase try-ons
 * (fixtures/youcam/ai-demo/showcase, 806x1080 portrait selfies). Pure CSS (scale +
 * transform-origin), no image processing. Reusable by A9 for video shots and screenshots.
 *
 * A region is the part of the frame to show: `top` and `height` as fractions of the image
 * height, centred horizontally on `centerX`; the zoom is 1 / height (same factor both axes).
 * If face-attribute geometry ever reaches the client, it can refine these per photo.
 */
import type { CSSProperties } from "react";
import type { JewelryCategory } from "@/server/contracts/giftfit";

export interface CropRegion {
  /** Top of the region, 0..1 of the image height. */
  top: number;
  /** Height of the region, 0..1 (zoom = 1 / height). */
  height: number;
  /** Horizontal centre of the region, 0..1 of the width. */
  centerX: number;
  /** Visible label of the "zoom back in" state, e.g. for screen-reader announcements. */
  focusLabel: string;
}

export const CROP_CONFIG: Record<JewelryCategory, CropRegion> = {
  // Face and both ears: about the top 55% of the frame (from just above the hairline).
  earring: { top: 0.08, height: 0.55, centerX: 0.5, focusLabel: "earrings" },
  // Neck and collarbone: centred on roughly 45–80% of the height.
  necklace: { top: 0.42, height: 0.42, centerX: 0.5, focusLabel: "necklace" },
  // Back-of-hand photos: centre on the hand and wrist.
  ring: { top: 0.2, height: 0.6, centerX: 0.5, focusLabel: "ring" },
  bracelet: { top: 0.25, height: 0.6, centerX: 0.5, focusLabel: "bracelet" },
  watch: { top: 0.25, height: 0.6, centerX: 0.5, focusLabel: "watch" },
};

/** Zoom factor and transform origin that show `region` inside the frame. */
export function cropTransform(
  region: Pick<CropRegion, "top" | "height" | "centerX">,
): { zoom: number; originX: number; originY: number } {
  const h = Math.min(1, Math.max(0.2, region.height));
  const zoom = 1 / h;
  if (h >= 1) return { zoom: 1, originX: 0.5, originY: 0.5 };
  // Scaling by z about origin o keeps o fixed; the visible window starts at o * (1 - 1/z).
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const originY = clamp(region.top / (1 - h));
  const originX = clamp((region.centerX - h / 2) / (1 - h));
  return { zoom, originX, originY };
}

/** Inline style for an <img> filling its card (object-fit: cover). */
export function cropStyle(category: JewelryCategory): CSSProperties {
  const { zoom, originX, originY } = cropTransform(CROP_CONFIG[category]);
  return {
    transform: `scale(${zoom.toFixed(3)})`,
    transformOrigin: `${(originX * 100).toFixed(1)}% ${(originY * 100).toFixed(1)}%`,
  };
}

export const FULL_FRAME_STYLE: CSSProperties = {
  transform: "scale(1)",
  transformOrigin: "50% 50%",
};

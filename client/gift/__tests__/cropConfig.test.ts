import { describe, expect, it } from "vitest";
import { CROP_CONFIG, cropStyle, cropTransform } from "../recipient/cropConfig";

/** The visible window of a frame after scale(z) about origin o: [o(1 - 1/z), o(1 - 1/z) + 1/z]. */
function window1d(origin: number, zoom: number): [number, number] {
  const start = origin * (1 - 1 / zoom);
  return [start, start + 1 / zoom];
}

describe("focused crop config", () => {
  it("earrings: face and ears, about the top 55% of the frame, centred", () => {
    const t = cropTransform(CROP_CONFIG.earring);
    const [y0, y1] = window1d(t.originY, t.zoom);
    expect(y0).toBeCloseTo(0.08, 5);
    expect(y1).toBeCloseTo(0.63, 5);
    const [x0, x1] = window1d(t.originX, t.zoom);
    expect((x0 + x1) / 2).toBeCloseTo(0.5, 5);
  });

  it("necklaces: neck and collarbone, roughly 45–80% of the height", () => {
    const t = cropTransform(CROP_CONFIG.necklace);
    const [y0, y1] = window1d(t.originY, t.zoom);
    expect(y0).toBeGreaterThanOrEqual(0.4);
    expect(y0).toBeLessThanOrEqual(0.46);
    expect(y1).toBeGreaterThanOrEqual(0.8);
    expect(y1).toBeLessThanOrEqual(0.86);
  });

  it("hand pieces centre on the hand with a milder zoom", () => {
    for (const c of ["ring", "bracelet", "watch"] as const) {
      const t = cropTransform(CROP_CONFIG[c]);
      expect(t.zoom).toBeLessThan(cropTransform(CROP_CONFIG.earring).zoom);
      const [x0, x1] = window1d(t.originX, t.zoom);
      expect((x0 + x1) / 2).toBeCloseTo(0.5, 5);
    }
  });

  it("produces a CSS transform per category", () => {
    expect(cropStyle("earring")).toEqual({ transform: "scale(1.818)", transformOrigin: "50.0% 17.8%" });
    expect(cropStyle("necklace").transform).toBe("scale(2.381)");
  });

  it("never pushes the window outside the frame", () => {
    const t = cropTransform({ top: 0.9, height: 0.5, centerX: 0.95 });
    const [y0, y1] = window1d(t.originY, t.zoom);
    const [x0, x1] = window1d(t.originX, t.zoom);
    expect(y0).toBeGreaterThanOrEqual(0);
    expect(y1).toBeLessThanOrEqual(1 + 1e-9);
    expect(x0).toBeGreaterThanOrEqual(0);
    expect(x1).toBeLessThanOrEqual(1 + 1e-9);
  });
});

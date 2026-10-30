import { describe, expect, it } from "vitest";
import { THRESHOLDS, allOk, faceSizeCheck, framingHeuristic, handChecks, lightingCheck, lumaStats, neckCheck, scaleToFit, selfieChecks } from "../recipient/captureChecks";

/** RGBA buffer filled by a luminance function of (x, y). */
function frame(w: number, h: number, lum: (x: number, y: number) => number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const v = lum(x, y);
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
  return d;
}
const W = 60,
  H = 80;
const inCenter = (x: number, y: number) => x >= W * 0.25 && x < W * 0.75 && y >= H * 0.15 && y < H * 0.75;
const textured = (base: number) => (x: number, y: number) => base + ((x * 7 + y * 13) % 5) * 12 - 24;

describe("capture checks: lighting", () => {
  it("passes a well-lit, textured frame", () => {
    const s = lumaStats(frame(W, H, textured(150)), W, H);
    expect(lightingCheck(s).state).toBe("ok");
  });
  it("flags a dark frame", () => {
    const s = lumaStats(frame(W, H, textured(50)), W, H);
    expect(lightingCheck(s)).toMatchObject({ state: "warn", label: "A bit dark" });
  });
  it("flags blown highlights", () => {
    const s = lumaStats(frame(W, H, () => 252), W, H);
    expect(lightingCheck(s)).toMatchObject({ state: "warn", label: "Too bright" });
  });
  it("flags a backlit subject (bright window behind a darker face)", () => {
    const s = lumaStats(frame(W, H, (x, y) => (inCenter(x, y) ? 110 : 235)), W, H);
    expect(s.edgeMean - s.centerMean).toBeGreaterThan(THRESHOLDS.backlitDelta);
    expect(lightingCheck(s).label).toBe("Light is behind you");
  });
});

describe("capture checks: face size and neck (FaceDetector boxes)", () => {
  const f = { width: 1200, height: 1600 };
  it("accepts a centred face of ~40% width with the neck in view", () => {
    const face = { x: 360, y: 300, width: 480, height: 600 };
    expect(faceSizeCheck(face, f).state).toBe("ok");
    expect(neckCheck(face, f).state).toBe("ok");
    expect(allOk(selfieChecks({ stats: lumaStats(frame(W, H, textured(150)), W, H), frame: f, face }))).toBe(true);
  });
  it("asks to come closer when the 60% analysis crop would be under 320 px or the face is tiny", () => {
    expect(faceSizeCheck({ x: 500, y: 300, width: 180, height: 220 }, f).label).toBe("Too far away");
    expect(faceSizeCheck({ x: 300, y: 200, width: 160, height: 200 }, { width: 640, height: 480 }).label).toBe("Too far away");
  });
  it("asks to back off when the face fills the frame", () => {
    expect(faceSizeCheck({ x: 100, y: 100, width: 1000, height: 1200 }, f).label).toBe("Too close");
  });
  it("asks to centre an off-centre face", () => {
    expect(faceSizeCheck({ x: 0, y: 300, width: 400, height: 500 }, f).label).toBe("Off center");
  });
  it("flags a missing neck when the chin is near the bottom edge", () => {
    expect(neckCheck({ x: 360, y: 900, width: 480, height: 600 }, f)).toMatchObject({ state: "warn", label: "Neck not visible" });
  });
  it("reports no face when the detector finds none", () => {
    expect(faceSizeCheck(null, f)).toMatchObject({ state: "warn", label: "No face found" });
  });
});

describe("capture checks: heuristic fallback without FaceDetector", () => {
  it("warns when the guide area is flat (camera at a wall)", () => {
    const s = lumaStats(frame(W, H, () => 140), W, H);
    expect(framingHeuristic(s).state).toBe("warn");
    expect(selfieChecks({ stats: s, frame: { width: W, height: H } })[0].state).toBe("warn");
  });
  it("is neutral (not a pass) when something is in the oval", () => {
    const s = lumaStats(frame(W, H, textured(150)), W, H);
    const checks = selfieChecks({ stats: s, frame: { width: W, height: H } });
    expect(checks.map((c) => c.id)).toEqual(["framing", "neck", "light"]);
    expect(checks[0].state).toBe("unknown");
    expect(allOk(checks)).toBe(true);
  });
  it("checks hand photos for framing and light", () => {
    expect(handChecks(lumaStats(frame(W, H, textured(40)), W, H)).map((c) => c.state)).toContain("warn");
  });
});

describe("upload sizing", () => {
  it("caps the long side at 1600 px and keeps the aspect ratio", () => {
    expect(scaleToFit(3000, 4000)).toEqual({ width: 1200, height: 1600 });
    expect(scaleToFit(800, 600)).toEqual({ width: 800, height: 600 });
  });
});

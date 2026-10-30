import { describe, expect, it } from "vitest";
import { clampMouth, createMouthFollower, frameRms, mouthTarget, mouthToParam, rmsToLevel, smoothMouth, typingRhythm } from "../mouth";

describe("clampMouth", () => {
  it("clamps to 0..1 and maps NaN/undefined to 0", () => {
    expect(clampMouth(-0.5)).toBe(0);
    expect(clampMouth(0.4)).toBe(0.4);
    expect(clampMouth(7)).toBe(1);
    expect(clampMouth(Infinity)).toBe(1);
    expect(clampMouth(-Infinity)).toBe(0);
    expect(clampMouth(Number.NaN)).toBe(0);
    expect(clampMouth(undefined)).toBe(0);
  });
});

describe("smoothMouth", () => {
  it("opens faster than it closes (attack < release)", () => {
    const opened = smoothMouth(0, 1, 16);
    const closed = 1 - smoothMouth(1, 0, 16);
    expect(opened).toBeGreaterThan(closed);
    expect(opened).toBeGreaterThan(0);
    expect(opened).toBeLessThan(1);
  });

  it("converges to the (clamped) target and snaps when close", () => {
    let v = 0;
    for (let i = 0; i < 60; i++) v = smoothMouth(v, 3, 16);
    expect(v).toBe(1);
    for (let i = 0; i < 120; i++) v = smoothMouth(v, -1, 16);
    expect(v).toBe(0);
  });

  it("is frame-rate independent", () => {
    let a = 0;
    for (let i = 0; i < 4; i++) a = smoothMouth(a, 1, 8);
    const b = smoothMouth(0, 1, 32);
    expect(a).toBeCloseTo(b, 6);
  });

  it("ignores negative dt", () => {
    expect(smoothMouth(0.3, 1, -10)).toBe(0.3);
  });
});

describe("audio level helpers", () => {
  it("computes RMS of a frame", () => {
    expect(frameRms([])).toBe(0);
    expect(frameRms([0.5, -0.5, 0.5, -0.5])).toBeCloseTo(0.5);
  });

  it("gates silence and clamps loud input", () => {
    expect(rmsToLevel(0)).toBe(0);
    expect(rmsToLevel(0.01)).toBe(0);
    expect(rmsToLevel(0.1)).toBeGreaterThan(0.3);
    expect(rmsToLevel(0.9)).toBe(1);
  });
});

describe("mouth targets", () => {
  it("is closed unless talking; `mouth` wins over the rhythm", () => {
    expect(mouthTarget(100, { talking: false, mouth: 1, rhythm: true })).toBe(0);
    expect(mouthTarget(100, { talking: true, mouth: 2, rhythm: true })).toBe(1);
    expect(mouthTarget(100, { talking: true, rhythm: false })).toBe(0);
    expect(mouthTarget(100, { talking: true, rhythm: true })).toBe(typingRhythm(100));
  });

  it("keeps the typing rhythm soft (0.15..0.7)", () => {
    for (let t = 0; t < 5000; t += 37) {
      const r = typingRhythm(t);
      expect(r).toBeGreaterThanOrEqual(0.15);
      expect(r).toBeLessThanOrEqual(0.7);
    }
  });

  it("follows a target smoothly over frames", () => {
    const follow = createMouthFollower();
    const first = follow(0, 1);
    const later = follow(16, 1);
    expect(first).toBeGreaterThan(0);
    expect(later).toBeGreaterThan(first);
    expect(later).toBeLessThan(1);
  });
});

describe("mouthToParam (Live2D ParamMouthOpenY)", () => {
  it("maps 0..1 to 0..1, monotonic, opening early for quiet speech", () => {
    expect(mouthToParam(0)).toBe(0);
    expect(mouthToParam(1)).toBe(1);
    expect(mouthToParam(-3)).toBe(0);
    expect(mouthToParam(9)).toBe(1);
    expect(mouthToParam(Number.NaN)).toBe(0);
    expect(mouthToParam(0.25)).toBeGreaterThan(0.25);
    let prev = -1;
    for (let m = 0; m <= 1; m += 0.05) {
      const p = mouthToParam(m);
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
  });
});

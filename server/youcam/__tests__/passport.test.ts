import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MemoryAuditSink } from "../audit";
import { YoucamClient } from "../client";
import { LEAN_HD_ACTIONS, buildSkinPassport, passportPlan, runSkinPassport } from "../passport";

const FIXTURES = path.join(process.cwd(), "fixtures", "youcam");
const mock = () => new YoucamClient({ config: { mock: true, fixturesDir: FIXTURES }, audit: new MemoryAuditSink(), cache: null });
const selfie = { bytes: new Uint8Array([1, 2, 3]), contentType: "image/png" as const };

describe("buildSkinPassport", () => {
  it("maps scores, regions, skin type, age and colors", () => {
    const p = buildSkinPassport({
      skin: {
        output: [
          { type: "hd_pore", region: "nose", ui_score: 40, raw_score: 39.6 },
          { type: "hd_pore", region: "whole", ui_score: 55, raw_score: 55.2 },
          { type: "hd_acne", ui_score: 80 },
          { type: "hd_skin_type", region: "whole", skin_type: "Dry" },
          { type: "hd_skin_type", region: "t_zone", skin_type: "Oily" },
          { type: "hd_skin_type", region: "u_zone", skin_type: "Normal" },
          { type: "skin_type", skin_type: "Dry" },
          { type: "skin_age", score: 31 },
          { type: "all", score: 70 },
          { type: "resize_image", mask_urls: ["x"] },
          { type: "hd_redness", raw_score: 12.5 },
          { type: "hd_skin_type", region: "whole", raw_score: 98.5, ui_score: 97 },
        ],
      },
      fitzpatrick: { fitzpatrick_scale: "IV" },
      tones: { color: { skin_color: "#aa8877" }, face_quality: { has_face: true } },
      imageSha256: "h",
      createdAt: "2026-10-15T00:00:00.000Z",
    });
    expect(p).toMatchObject({
      skinAge: 31,
      overallScore: 70,
      skinType: { whole: "Dry", tZone: "Oily", uZone: "Normal" },
      fitzpatrick: "IV",
      colors: { skin_color: "#aa8877" },
      faceQuality: { has_face: true },
      createdAt: "2026-10-15T00:00:00.000Z",
    });
    expect(p.concerns).toEqual([
      { key: "pore", uiScore: 55, rawScore: 55.2, regions: { nose: 39.6, whole: 55.2 }, uiRegions: { nose: 40, whole: 55 } },
      { key: "acne", uiScore: 80, rawScore: undefined, regions: {}, uiRegions: { whole: 80 } },
      { key: "redness", uiScore: undefined, rawScore: 12.5, regions: { whole: 12.5 }, uiRegions: {} },
      { key: "skin_type", uiScore: 97, rawScore: 98.5, regions: { whole: 98.5 }, uiRegions: { whole: 97 } },
    ]);
  });

  it("tolerates missing optional parts", () => {
    const p = buildSkinPassport({ skin: { output: undefined as never }, tones: {} as never, imageSha256: "h" });
    expect(p).toMatchObject({ concerns: [], skinType: undefined, fitzpatrick: undefined, colors: {} });
  });
});

describe("runSkinPassport", () => {
  it("builds a full passport in mock mode (52 units expected, 0 charged)", async () => {
    const onResult = vi.fn();
    const p = await runSkinPassport(mock(), selfie, { onResult });
    expect(p.units).toEqual({ expected: 52, charged: 0 });
    expect(p.source).toEqual({ mock: true, synthetic: true, tier: "full" });
    expect(p.concerns.length).toBe(15);
    expect(p.fitzpatrick).toBe("III");
    expect(Object.keys(p.taskIds)).toEqual(["skin-analysis", "fitzpatrick-scale-analyzer", "skin-tone-analysis"]);
    expect(onResult).toHaveBeenCalledTimes(3);
    expect(p.imageSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("supports the lean and no-Fitzpatrick levers", async () => {
    const lean = await runSkinPassport(mock(), { url: "https://img.test/x.jpg" }, { tier: "lean", includeFitzpatrick: false });
    expect(lean.units.expected).toBe(36);
    expect(lean.fitzpatrick).toBeUndefined();
    expect(lean.source.tier).toBe("lean");
    expect(passportPlan({ tier: "lean" })[0].params.dstActions).toBe(LEAN_HD_ACTIONS);
    expect(passportPlan({ includeFitzpatrick: false }).map((p) => p.feature)).toEqual(["skin-analysis", "skin-tone-analysis"]);
  });
});

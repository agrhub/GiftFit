import { describe, expect, it } from "vitest";
import { selfieChecks, allOk, lumaStats } from "../recipient/captureChecks";
import { failureCopy, isEarlobeFailure, isWristFailure } from "../recipient/tryOnFailures";

describe("earring failures (engine error 2, ADR-026)", () => {
  it("recognises the engine's earlobe failures", () => {
    for (const r of ["2", " 2 ", "2: earlobe alignment not confident.", "earlobe alignment not confident.", "EARLOBE_NOT_FOUND", "ears not visible"]) expect(isEarlobeFailure(r)).toBe(true);
    for (const r of [undefined, "", "render_failed", "12", "expired", "PHOTO_DETECTION_FAIL"]) expect(isEarlobeFailure(r)).toBe(false);
  });

  it("offers a retake with neutral copy only for earrings", () => {
    expect(failureCopy({ category: "earring" }, "2")).toEqual({ text: "We couldn't see your ears, so this earring preview was skipped. Retake?", retake: "ears" });
    expect(failureCopy({ category: "necklace" }, "2").retake).toBeNull();
    expect(failureCopy({ category: "earring" }, "render_failed").retake).toBeNull();
    expect(failureCopy({ category: "earring" }, "2").text).not.toMatch(/\b(she|her|he|his)\b/i);
  });

  it("maps the wrist failure (engine code 4) to a photo retake for hand pieces", () => {
    for (const r of ["4", "4: Wrist position should be in the center.", "Wrist position should be in the center."]) expect(isWristFailure(r)).toBe(true);
    for (const r of [undefined, "40", "2", "render_failed"]) expect(isWristFailure(r)).toBe(false);
    for (const category of ["bracelet", "watch", "ring"] as const)
      expect(failureCopy({ category }, "4")).toEqual({ text: "We couldn't see your whole wrist, so this preview was skipped. Retake?", retake: "wrist" });
    expect(failureCopy({ category: "earring" }, "4").retake).toBeNull();
  });

  it("adds a non-blocking 'Ears visible' reminder when the carousel has earrings", () => {
    const px = new Uint8ClampedArray(40 * 40 * 4).map((_, i) => (i % 4 === 3 ? 255 : 120 + ((i * 7) % 60)));
    const stats = lumaStats(px, 40, 40);
    const withEars = selfieChecks({ stats, frame: { width: 40, height: 40 }, needsEars: true });
    expect(withEars.find((c) => c.id === "ears")).toMatchObject({ state: "unknown", hint: "Tuck your hair behind your ears." });
    expect(allOk(withEars)).toBe(allOk(selfieChecks({ stats, frame: { width: 40, height: 40 } })));
    expect(selfieChecks({ stats, frame: { width: 40, height: 40 } }).some((c) => c.id === "ears")).toBe(false);
  });
});

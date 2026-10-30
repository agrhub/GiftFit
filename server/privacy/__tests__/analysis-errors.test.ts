/**
 * A refused selfie gets a hint the recipient can act on (ADR-058: YouCam refused an AI model's selfie as "tilted too far
 * downward"; the page only said "we couldn't read that photo").
 */
import { describe, expect, it } from "vitest";
import { ApiError } from "@/client/gift/api";
import { recipientErrorMessage } from "@/client/gift/recipient/i18n";
import { recipientTranslator } from "@/server/i18n/recipient";
import { CostGuardError, YoucamTaskError } from "@/server/youcam/errors";
import { analysisFailureCode, analysisFailureLog } from "../analysis-errors";

const task = (message: string, engineError?: string) => new YoucamTaskError(message, "skin-tone-analysis", "t1", engineError);

describe("analysisFailureCode", () => {
  it("reads YouCam's head-angle refusal (the paid take's exact message) as face_angle", () => {
    expect(analysisFailureCode(task("The face is tilted too far downward for accurate analysis. Slightly tilt head upwards and try again."))).toBe("face_angle");
    expect(analysisFailureCode(task("Face angle is not frontal enough"))).toBe("face_angle");
  });

  it("no face or several faces → face_not_found; light, blur or size → photo_quality; anything else stays generic", () => {
    expect(analysisFailureCode(task("No face detected in the image"))).toBe("face_not_found");
    expect(analysisFailureCode(task("More than one face found"))).toBe("face_not_found");
    expect(analysisFailureCode(task("The image is too dark"))).toBe("photo_quality");
    expect(analysisFailureCode(task("Image is blurry"))).toBe("photo_quality");
    expect(analysisFailureCode(task("Internal error", "error_internal"))).toBe("analysis_failed");
    expect(analysisFailureCode(new CostGuardError("refused", "daily_cap", "skin-tone-analysis", 20))).toBe("analysis_failed");
    expect(analysisFailureCode(new Error("boom"))).toBe("analysis_failed");
  });

  it("logs the feature and YouCam's message, not a minified class name", () => {
    expect(analysisFailureLog(task("The face is tilted too far downward."))).toBe('face_angle feature=skin-tone-analysis engine=- message="The face is tilted too far downward."');
    expect(analysisFailureLog(new CostGuardError("refused", "daily_cap", "skin-tone-analysis", 20))).toBe("analysis_failed daily_cap");
  });
});

describe("the recipient sees a specific hint in their language", () => {
  it.each([
    ["face_angle", "en", "chin slightly up"],
    ["face_angle", "ja", "あごを少し上げて"],
    ["face_angle", "de", "Kinn leicht angehoben"],
    ["face_angle", "vi", "hơi ngẩng cằm"],
    ["face_not_found", "en", "Fit your face in the oval"],
    ["photo_quality", "en", "Face the light"],
    ["analysis_failed", "en", "We couldn't read that photo"],
  ] as const)("%s in %s", (code, locale, text) => {
    expect(recipientErrorMessage(recipientTranslator(locale), new ApiError(422, code))).toContain(text);
  });
});

/**
 * Client-side capture checks (owner: A4), run before anything leaves the phone.
 * Pure functions over plain numbers so they are unit-tested without a camera.
 *
 * Requirements they guard (docs/research/api_matrix.md):
 *   - Facial Color Tones / Face Attributes: min 320 px, face width > 60% of the (server-cropped)
 *     analysis image, frontal, even light, no blown highlights.
 *   - Necklace VTO: neck clearly visible, neck width >= 15% of image width.
 *   - Ring / bracelet / watch VTO: back of the hand, all five fingers, unoccluded.
 * We send the full frame; the server crops so the face fills >= 60% of the analysis crop.
 */

export interface FaceBox {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface FrameSize {
  width: number;
  height: number;
}

export type CheckId = "face" | "neck" | "light" | "framing" | "ears";
export type CheckState = "ok" | "warn" | "unknown";
export interface CheckResult {
  id: CheckId;
  state: CheckState;
  label: string;
  hint?: string;
}

export interface LumaStats {
  /** 0..255 */
  mean: number;
  stdev: number;
  /** Share of pixels >= 245 (blown highlights). */
  clipped: number;
  /** Mean of the guide area (central oval box) and of the outer ring. */
  centerMean: number;
  centerStdev: number;
  edgeMean: number;
}

export const THRESHOLDS = {
  /** API minimum side of the analysis image. */
  minCropPx: 320,
  /** Face share of the analysis crop the server makes. */
  cropFaceShare: 0.6,
  /** Face width / frame width: closer than this is needed for a usable neck (>= 15% of width) and detail. */
  minFaceRatio: 0.25,
  /** Above this the neck and ears are usually cut off. */
  maxFaceRatio: 0.7,
  /** Space under the chin, in face heights, to show the neck and collarbone. */
  minNeckSpace: 0.55,
  darkMean: 75,
  brightClipped: 0.2,
  backlitDelta: 45,
  /** Central area this flat means there's nothing (or no face) in the guide. */
  flatCenterStdev: 12,
} as const;

const luma = (r: number, g: number, b: number) =>
  0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Luminance statistics of an RGBA buffer (e.g. a small canvas snapshot). */
export function lumaStats(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
): LumaStats {
  let n = 0,
    sum = 0,
    sumSq = 0,
    clipped = 0;
  let cN = 0,
    cSum = 0,
    cSumSq = 0,
    eN = 0,
    eSum = 0;
  const cx0 = width * 0.25,
    cx1 = width * 0.75,
    cy0 = height * 0.15,
    cy1 = height * 0.75;
  const ex = width * 0.15,
    ey = height * 0.12;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const l = luma(rgba[i], rgba[i + 1], rgba[i + 2]);
      n++;
      sum += l;
      sumSq += l * l;
      if (l >= 245) clipped++;
      if (x >= cx0 && x < cx1 && y >= cy0 && y < cy1) {
        cN++;
        cSum += l;
        cSumSq += l * l;
      } else if (x < ex || x >= width - ex || y < ey) {
        eN++;
        eSum += l;
      }
    }
  }
  const mean = n ? sum / n : 0;
  const centerMean = cN ? cSum / cN : mean;
  return {
    mean,
    stdev: n ? Math.sqrt(Math.max(0, sumSq / n - mean * mean)) : 0,
    clipped: n ? clipped / n : 0,
    centerMean,
    centerStdev: cN
      ? Math.sqrt(Math.max(0, cSumSq / cN - centerMean * centerMean))
      : 0,
    edgeMean: eN ? eSum / eN : mean,
  };
}

export function lightingCheck(s: LumaStats): CheckResult {
  const base = { id: "light" as const };
  if (s.mean < THRESHOLDS.darkMean || s.centerMean < THRESHOLDS.darkMean)
    return {
      ...base,
      state: "warn",
      label: "A bit dark",
      hint: "Face a window or turn on a light.",
    };
  if (s.clipped > THRESHOLDS.brightClipped)
    return {
      ...base,
      state: "warn",
      label: "Too bright",
      hint: "Step out of direct sun or harsh light.",
    };
  if (s.edgeMean - s.centerMean > THRESHOLDS.backlitDelta)
    return {
      ...base,
      state: "warn",
      label: "Light is behind you",
      hint: "Turn so the light falls on your face.",
    };
  return { ...base, state: "ok", label: "Good light" };
}

/** The square-ish crop the server makes so the face is 60% of its width. */
export function analysisCropWidth(face: FaceBox): number {
  return face.width / THRESHOLDS.cropFaceShare;
}

export function faceSizeCheck(
  face: FaceBox | null,
  frame: FrameSize,
): CheckResult {
  const base = { id: "face" as const };
  if (!face)
    return {
      ...base,
      state: "warn",
      label: "No face found",
      hint: "Line up your face with the oval.",
    };
  const ratio = face.width / frame.width;
  const centerX = (face.x + face.width / 2) / frame.width;
  if (
    analysisCropWidth(face) < THRESHOLDS.minCropPx ||
    ratio < THRESHOLDS.minFaceRatio
  )
    return {
      ...base,
      state: "warn",
      label: "Too far away",
      hint: "Bring the phone a little closer.",
    };
  if (ratio > THRESHOLDS.maxFaceRatio)
    return {
      ...base,
      state: "warn",
      label: "Too close",
      hint: "Hold the phone a little further away.",
    };
  if (centerX < 0.3 || centerX > 0.7)
    return {
      ...base,
      state: "warn",
      label: "Off center",
      hint: "Move your face into the middle of the oval.",
    };
  if (face.y < 0)
    return {
      ...base,
      state: "warn",
      label: "Head cut off",
      hint: "Tilt the phone up a little.",
    };
  return { ...base, state: "ok", label: "Face size good" };
}

export function neckCheck(face: FaceBox | null, frame: FrameSize): CheckResult {
  const base = { id: "neck" as const };
  if (!face)
    return {
      ...base,
      state: "unknown",
      label: "Neck visible",
      hint: "Keep your neck and collarbones in view.",
    };
  const below = frame.height - (face.y + face.height);
  if (below / face.height < THRESHOLDS.minNeckSpace)
    return {
      ...base,
      state: "warn",
      label: "Neck not visible",
      hint: "Tilt the phone down a little so your neck shows.",
    };
  return { ...base, state: "ok", label: "Neck visible" };
}

/** Without a face detector we can only tell whether something is in the guide area. */
export function framingHeuristic(
  s: LumaStats,
  subject: "face" | "hand" = "face",
): CheckResult {
  const base = { id: "framing" as const };
  if (s.centerStdev < THRESHOLDS.flatCenterStdev)
    return {
      ...base,
      state: "warn",
      label:
        subject === "face" ? "Nothing in the oval" : "No hand in the outline",
      hint:
        subject === "face"
          ? "Line up your face with the oval."
          : "Place the back of your hand in the outline.",
    };
  return {
    ...base,
    state: "unknown",
    label:
      subject === "face" ? "Line up with the oval" : "All five fingers in view",
    hint:
      subject === "face"
        ? "Face the camera, chin level, neck in view."
        : "Back of the hand, wrist in the middle, a little forearm showing.",
  };
}

export interface SelfieCheckInput {
  stats: LumaStats;
  frame: FrameSize;
  /** null when no face was detected; undefined when no detector is available. */
  face?: FaceBox | null;
  /** The carousel has earrings: the earring VTO needs visible earlobes (first real run, ADR-026). */
  needsEars?: boolean;
}

/**
 * Earlobes can't be measured on-device without landmarks, so this is a standing reminder
 * (state "unknown", never blocks). The real engine refuses earrings with covered ears.
 */
export const EARS_REMINDER: CheckResult = {
  id: "ears",
  state: "unknown",
  label: "Ears visible",
  hint: "Tuck your hair behind your ears.",
};

export function selfieChecks({
  stats,
  frame,
  face,
  needsEars = false,
}: SelfieCheckInput): CheckResult[] {
  const light = lightingCheck(stats);
  const ears = needsEars ? [EARS_REMINDER] : [];
  if (face === undefined)
    return [
      framingHeuristic(stats, "face"),
      ...ears,
      {
        id: "neck",
        state: "unknown",
        label: "Neck visible",
        hint: "Keep your neck and collarbones in view.",
      },
      light,
    ];
  return [faceSizeCheck(face, frame), ...ears, neckCheck(face, frame), light];
}

export function handChecks(stats: LumaStats): CheckResult[] {
  return [framingHeuristic(stats, "hand"), lightingCheck(stats)];
}

export const allOk = (checks: readonly CheckResult[]) =>
  checks.every((c) => c.state !== "warn");

/** Long side we upload. Keeps files small (< 10 MB) and under the VTO long-side limits. */
export const MAX_UPLOAD_SIDE = 1600;

export function scaleToFit(
  w: number,
  h: number,
  max = MAX_UPLOAD_SIDE,
): FrameSize {
  const s = Math.min(1, max / Math.max(w, h));
  return { width: Math.round(w * s), height: Math.round(h * s) };
}

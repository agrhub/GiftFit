/**
 * Face crop for the two analyses (ADR-025 design, ADR-058 paid take): Facial Color Tones and Face Attributes read a
 * crop where the face is about 60% of the width; the try-ons keep the full frame (neck and ears in view). Every real
 * analysis that passed used such a crop; the full selfie of the same AI model was refused as "tilted too far
 * downward" (YouCam judges the head angle from the whole frame).
 *
 * No face detector runs on the server: the crop is the capture guide's face region (the oval the recipient lines
 * their face up with, client/gift/recipient/CaptureStep.tsx), with the same 60% face share the client checks
 * (captureChecks.ts THRESHOLDS.cropFaceShare / minCropPx). Too small a photo keeps the full frame.
 */
import sharp from "sharp";
import type { ImageContentType } from "@/server/youcam/types";

export const ANALYSIS_CROP = {
  /** Centre of the guide's face oval, as a share of the frame. */
  centerX: 0.5,
  centerY: 0.37,
  /** Crop width as a share of the frame width (the oval's face is ~36% of the frame = 60% of the crop). */
  widthShare: 0.6,
  /** Crop height / width: forehead to chin with a little margin. */
  aspect: 1.15,
  /** Below this crop width the full frame is analysed instead (captureChecks THRESHOLDS.minCropPx). */
  minWidthPx: 320,
} as const;

export interface CropBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The analysis crop box for a frame, or null when the frame is too small to crop. */
export function analysisCropBox(width: number, height: number): CropBox | null {
  const w = Math.round(width * ANALYSIS_CROP.widthShare);
  if (w < ANALYSIS_CROP.minWidthPx) return null;
  const h = Math.min(height, Math.round(w * ANALYSIS_CROP.aspect));
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max, v));
  return {
    left: clamp(Math.round(width * ANALYSIS_CROP.centerX - w / 2), width - w),
    top: clamp(Math.round(height * ANALYSIS_CROP.centerY - h / 2), height - h),
    width: w,
    height: h,
  };
}

/** The selfie cropped for the analyses (JPEG), or null to analyse the full frame. */
export async function analysisCrop(photo: { bytes: Uint8Array }): Promise<{ bytes: Uint8Array; contentType: ImageContentType } | null> {
  const meta = await sharp(photo.bytes).metadata();
  if (!meta.width || !meta.height) return null;
  const box = analysisCropBox(meta.width, meta.height);
  if (!box) return null;
  const out = await sharp(photo.bytes).extract(box).jpeg({ quality: 92 }).toBuffer();
  return { bytes: new Uint8Array(out), contentType: "image/jpeg" };
}

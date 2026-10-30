/**
 * Browser image helpers for capture (owner: A4). Everything stays on the device until the
 * recipient taps "Use this photo". Re-encoding through a canvas also strips EXIF (GPS, device).
 */
import { type FaceBox, type FrameSize, type LumaStats, lumaStats, scaleToFit } from "./captureChecks";

interface DetectedFace {
  boundingBox: { x: number; y: number; width: number; height: number };
}
interface FaceDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedFace[]>;
}
type FaceDetectorCtor = new (opts?: { fastMode?: boolean; maxDetectedFaces?: number }) => FaceDetectorLike;

let detector: FaceDetectorLike | null | undefined;

/** The Shape Detection API's FaceDetector, when the browser has it (Chrome on Android/macOS, flags elsewhere). */
export function getFaceDetector(): FaceDetectorLike | null {
  if (detector !== undefined) return detector;
  const Ctor = (globalThis as unknown as { FaceDetector?: FaceDetectorCtor }).FaceDetector;
  try {
    detector = Ctor ? new Ctor({ fastMode: true, maxDetectedFaces: 1 }) : null;
  } catch {
    detector = null;
  }
  return detector;
}

/** Largest face in the source, in source pixels; null = none found; undefined = no detector or it failed. */
export async function detectFace(source: CanvasImageSource): Promise<FaceBox | null | undefined> {
  const d = getFaceDetector();
  if (!d) return undefined;
  try {
    const faces = await d.detect(source);
    if (!faces.length) return null;
    const b = faces.reduce((a, f) => (f.boundingBox.width > a.boundingBox.width ? f : a)).boundingBox;
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  } catch {
    return undefined;
  }
}

/** Luminance stats of any drawable, sampled on a small canvas. */
export function sampleStats(source: CanvasImageSource, w: number, h: number, sample = 96): LumaStats | null {
  const s = Math.min(1, sample / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * s));
  const ch = Math.max(1, Math.round(h * s));
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, cw, ch);
  return lumaStats(ctx.getImageData(0, 0, cw, ch).data, cw, ch);
}

export interface Still {
  blob: Blob;
  url: string;
  canvas: HTMLCanvasElement;
  frame: FrameSize;
}

function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode_failed"))), "image/jpeg", 0.9));
}

/** Draw a source into a canvas no larger than the upload limit and encode it as JPEG. */
export async function toStill(source: CanvasImageSource, w: number, h: number): Promise<Still> {
  const frame = scaleToFit(w, h);
  const canvas = document.createElement("canvas");
  canvas.width = frame.width;
  canvas.height = frame.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no_canvas");
  ctx.drawImage(source, 0, 0, frame.width, frame.height);
  const blob = await canvasToJpeg(canvas);
  return { blob, url: URL.createObjectURL(blob), canvas, frame };
}

/** Decode a picked file (JPEG, PNG, HEIC where the browser can) with EXIF orientation applied. */
export async function fileToStill(file: File): Promise<Still> {
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      try {
        return await toStill(bmp, bmp.width, bmp.height);
      } finally {
        bmp.close();
      }
    } catch {
      /* fall through to <img> decoding */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return await toStill(img, img.naturalWidth, img.naturalHeight);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Label vocabulary for recipient-derived words (owner: A5). Client-safe (no node imports), so
 * A3 (giver report) and A4 (UI) use the same strings.
 *
 * Gender-neutral throughout (ADR-022): "they" / "their", no gendered pronouns.
 *
 * Giver side (server/contracts/api.ts GiverReportStatus.recipientLabels, MASTER_PLAN §3.3 step 6):
 * the giver guard allows `$.recipientLabels.undertone` and `$.recipientLabels.faceShape` ONLY when
 * the value is one of GIVER_UNDERTONE_LABELS / GIVER_FACE_SHAPE_LABELS. Anything else under those
 * keys (hex, numbers, LAB, confidence, free text) is a leak.
 */
import { FACE_SHAPES, type FaceShape, type RecipientProfile, type Undertone } from "@/server/contracts/giftfit";

const UNDERTONES: readonly Undertone[] = ["warm", "neutral", "cool"];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Display words per face shape (InvTriangle reads as heart-shaped, as in server/fit/labels.ts). */
export const FACE_SHAPE_WORDS: Record<Exclude<FaceShape, "Unknown">, string> = {
  Oval: "Oval",
  Round: "Round",
  Square: "Square",
  Heart: "Heart-shaped",
  InvTriangle: "Heart-shaped",
  Oblong: "Oblong",
  Diamond: "Diamond-shaped",
  Triangle: "Triangle-shaped",
};

/**
 * "Warm undertone estimate", "Warm undertone estimate (low confidence)", or, when the recipient
 * corrected it, "Warm undertone (their choice)". `undertone` is the override when `override` is true.
 */
export function giverUndertoneLabel(undertone: Undertone, opts: { override?: boolean; lowConfidence?: boolean } = {}): string {
  const tone = cap(undertone);
  if (opts.override) return `${tone} undertone (their choice)`;
  return `${tone} undertone estimate${opts.lowConfidence ? " (low confidence)" : ""}`;
}

/** "Oval face shape estimate"; undefined for Unknown (omit the label). */
export function giverFaceShapeLabel(shape: FaceShape): string | undefined {
  return shape === "Unknown" ? undefined : `${FACE_SHAPE_WORDS[shape]} face shape estimate`;
}

export const GIVER_UNDERTONE_LABELS: ReadonlySet<string> = new Set(
  UNDERTONES.flatMap((u) => [giverUndertoneLabel(u), giverUndertoneLabel(u, { lowConfidence: true }), giverUndertoneLabel(u, { override: true })]),
);

export const GIVER_FACE_SHAPE_LABELS: ReadonlySet<string> = new Set(
  FACE_SHAPES.map((s) => giverFaceShapeLabel(s)).filter((s): s is string => Boolean(s)),
);

/** Same threshold as server/fit FIT_PARAMS.lowConfidence. */
export const LOW_CONFIDENCE_LABEL_THRESHOLD = 0.5;

/**
 * GiverReportStatus.recipientLabels from a RecipientProfile (contract types only). Drop-in for
 * server/fit `recipientLabels()` with gender-neutral wording: the override wins ("(their choice)"); an
 * estimate with confidence 0 is omitted; Unknown face shape is omitted.
 */
export function giverRecipientLabels(
  profile: RecipientProfile | null,
  opts: { lowConfidence?: number } = {},
): { undertone?: string; faceShape?: string } | undefined {
  if (!profile) return undefined;
  const labels: { undertone?: string; faceShape?: string } = {};
  const low = opts.lowConfidence ?? LOW_CONFIDENCE_LABEL_THRESHOLD;
  if (profile.undertoneOverride) labels.undertone = giverUndertoneLabel(profile.undertoneOverride, { override: true });
  else if (profile.undertoneConfidence > 0) labels.undertone = giverUndertoneLabel(profile.undertoneEstimate, { lowConfidence: profile.undertoneConfidence < low });
  const face = giverFaceShapeLabel(profile.faceShape);
  if (face) labels.faceShape = face;
  return Object.keys(labels).length ? labels : undefined;
}

/** Recipient side (CaptureResponse): "Warm undertone (estimate)" or "Cool undertone (your choice)". */
export function recipientUndertoneLabel(estimate: Undertone, override: Undertone | null): string {
  return override ? `${cap(override)} undertone (your choice)` : `${cap(estimate)} undertone (estimate)`;
}

/** Recipient side: "Oval face shape (estimate)" or "Face shape not detected". */
export function recipientFaceShapeLabel(shape: FaceShape | null): string {
  return shape && shape !== "Unknown" ? `${FACE_SHAPE_WORDS[shape]} face shape (estimate)` : "Face shape not detected";
}

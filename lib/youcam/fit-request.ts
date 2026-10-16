/**
 * GiftFit critical path on top of the client: analyse the recipient (Facial Color Tones
 * + Face Attributes, 30 units) and render jewelry try-ons (1 unit each, stacked 2).
 * One full Fit Request = 20 + 10 + 6 x 1 = 36 units.
 *
 * Returns raw API values only. Undertone is NOT derived here (A10 owns it in
 * lib/verticals/jewelry.ts). Hex colors and face attributes are recipient data: callers
 * must keep them server-side and never return them on a giver route (MASTER_PLAN v2 4.4).
 */
import type { PlanItem, RunResult, YoucamClient } from "./client";
import type { JewelryBodyVariant } from "./config";
import { CostGuardError, YoucamApiError, YoucamTaskError, YoucamTimeoutError } from "./errors";
import { GIFT_FACE_FEATURES, HAND_JEWELRY } from "./features";
import type {
  FaceAngleStrictness,
  FaceAttrFeature,
  FaceAttributesResult,
  FaceColors,
  FaceQuality,
  FaceShape,
  ImageInput,
  JewelryKind,
  JewelryVtoParams,
} from "./types";

export interface RecipientAnalysis {
  /** Raw hex colors from Facial Color Tones. Server-side only; never persist or show to the giver. */
  colors: FaceColors & { skin_color: string };
  faceShape?: FaceShape;
  faceAttributes: FaceAttributesResult;
  faceQuality?: FaceQuality;
  units: { expected: number; charged: number };
  taskIds: { tones: string; faceAttributes: string };
  /** SHA-256 result-cache keys, for client.purge() on delete (A5). */
  cacheKeys: { tones: string; faceAttributes: string };
  source: { mock: boolean; synthetic: boolean };
}

/** Runs Facial Color Tones and Face Attributes (5 features) in parallel. */
export async function analyzeRecipient(
  client: YoucamClient,
  selfie: ImageInput,
  opts: { features?: readonly FaceAttrFeature[]; faceAngleStrictness?: FaceAngleStrictness } = {},
): Promise<RecipientAnalysis> {
  const [tones, attrs] = await Promise.all([
    client.facialColorTones(selfie, { faceAngleStrictness: opts.faceAngleStrictness ?? "high" }),
    client.faceAttributes(selfie, { features: opts.features ?? GIFT_FACE_FEATURES }),
  ]);
  const results: RunResult<unknown>[] = [tones, attrs];
  return {
    colors: tones.result.color,
    faceShape: attrs.result.faceshape,
    faceAttributes: attrs.result,
    faceQuality: tones.result.face_quality ?? attrs.result.face_quality,
    units: {
      expected: results.reduce((a, r) => a + (r.unitsExpected ?? 0), 0),
      charged: results.reduce((a, r) => a + r.unitsCharged, 0),
    },
    taskIds: { tones: tones.taskId, faceAttributes: attrs.taskId },
    cacheKeys: { tones: tones.cacheKey, faceAttributes: attrs.cacheKey },
    source: { mock: results.every((r) => r.mock), synthetic: results.some((r) => r.synthetic) },
  };
}

export interface TryOnItem extends Omit<JewelryVtoParams, "products"> {
  /** Caller's id for the item (catalog id). */
  id: string;
  kind: JewelryKind;
  /** Product image(s); a public catalog URL is fine. More than one = stacked. */
  product: ImageInput | readonly ImageInput[];
}

export type TryOnResult =
  | {
      id: string;
      kind: JewelryKind;
      ok: true;
      url: string;
      taskId: string;
      /** SHA-256 result-cache key, for client.purge() on delete (A5). */
      cacheKey: string;
      unitsCharged: number;
      cached: boolean;
      mock: boolean;
    }
  | {
      id: string;
      kind: JewelryKind;
      ok: false;
      error: string;
      code?: string;
      /** Set when a YouCam task exists (engine error, timeout): delete it on purge. */
      taskId?: string;
    };

export interface TryOnPhotos {
  /** Front selfie (earring, necklace). */
  face: ImageInput;
  /** Back of the hand / wrist, all five fingers visible (ring, bracelet, watch). Optional. */
  hand?: ImageInput;
}

/**
 * Renders try-ons with bounded concurrency. Failures are per item (the carousel shows
 * the rest); hand jewelry without a hand photo is skipped without a call.
 */
export async function runTryOns(
  client: YoucamClient,
  photos: TryOnPhotos,
  items: readonly TryOnItem[],
  opts: { concurrency?: number; jewelryBodyVariant?: JewelryBodyVariant } = {},
): Promise<TryOnResult[]> {
  const out: TryOnResult[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await tryOne(client, photos, items[i], opts.jewelryBodyVariant);
    }
  };
  const n = Math.max(1, Math.min(opts.concurrency ?? 3, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

async function tryOne(
  client: YoucamClient,
  photos: TryOnPhotos,
  item: TryOnItem,
  variant: JewelryBodyVariant | undefined,
): Promise<TryOnResult> {
  const { id, kind, product, ...rest } = item;
  const src = HAND_JEWELRY.includes(kind) ? photos.hand : photos.face;
  if (!src) return { id, kind, ok: false, error: "a back-of-hand photo is required for this item", code: "hand_photo_required" };
  const products = Array.isArray(product) ? (product as readonly ImageInput[]) : [product as ImageInput];
  try {
    const r = await client.jewelryVto(kind, src, { ...rest, products }, { jewelryBodyVariant: variant });
    return {
      id,
      kind,
      ok: true,
      url: r.result.url,
      taskId: r.taskId,
      cacheKey: r.cacheKey,
      unitsCharged: r.unitsCharged,
      cached: r.cached,
      mock: r.mock,
    };
  } catch (err) {
    if (err instanceof YoucamTaskError) {
      return { id, kind, ok: false, error: err.message, code: err.engineError ?? undefined, taskId: err.taskId };
    }
    if (err instanceof CostGuardError) return { id, kind, ok: false, error: err.message, code: err.reason };
    if (err instanceof YoucamTimeoutError) return { id, kind, ok: false, error: err.message, code: "timeout", taskId: err.taskId };
    if (err instanceof YoucamApiError) return { id, kind, ok: false, error: err.message, code: err.code ?? String(err.status) };
    throw err;
  }
}

/** Tasks of one Fit Request, for client.preflight() and cost estimates. */
export function fitRequestPlan(items: ReadonlyArray<Pick<TryOnItem, "kind" | "product">>): PlanItem[] {
  return [
    { feature: "skin-tone-analysis", params: { faceAngleStrictness: "high" } },
    { feature: "face-attr-analysis", params: { features: GIFT_FACE_FEATURES } },
    ...items.map(
      (i): PlanItem => ({
        feature: `2d-vto/${i.kind}`,
        params: { products: Array.isArray(i.product) ? (i.product as readonly ImageInput[]) : [i.product as ImageInput] },
      }),
    ),
  ];
}

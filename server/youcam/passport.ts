/**
 * v1 (TrueShelf) LEFTOVER, kept off the GiftFit critical path (MASTER_PLAN v2 A1 brief).
 *
 * Skin Passport: the numeric profile TrueShelf built from one selfie with
 * AI Skin Analysis (HD), AI Fitzpatrick Skin Type and AI Facial Color Tones.
 * Full = 22 + 10 + 20 = 52 units; lean = 16 + 10 + 20 = 46 units.
 * Educational, not medical advice: scores are passed through from YouCam unchanged.
 */
import { sha256Hex } from "./cache";
import type { RunResult, YoucamClient } from "./client";
import type {
  FaceColors,
  FaceQuality,
  FacialColorTonesResult,
  FitzpatrickResult,
  FitzpatrickType,
  HdSkinAction,
  ImageInput,
  SkinAnalysisResult,
} from "./types";
import { HD_SKIN_ACTIONS } from "./types";

/** 8 HD concerns (5-8 tier, 16 units) for the lean passport. */
export const LEAN_HD_ACTIONS: readonly HdSkinAction[] = [
  "hd_wrinkle",
  "hd_pore",
  "hd_texture",
  "hd_acne",
  "hd_redness",
  "hd_oiliness",
  "hd_moisture",
  "hd_age_spot",
];

export interface PassportConcern {
  /** Concern name without the hd_ prefix, e.g. "wrinkle". */
  key: string;
  /** Model score 1-100, higher = healthier (region "whole" or the only region). Use this for matching. */
  rawScore?: number;
  /** YouCam display score 1-100, inflated by design. Show only as a labelled friendly view. */
  uiScore?: number;
  /** Per-region raw scores when the concern is reported by region (pores, wrinkles). */
  regions: Record<string, number>;
  /** Per-region display (ui) scores. */
  uiRegions: Record<string, number>;
}

/**
 * Numbers only: no image, no image URL from the user's photo except YouCam mask URLs
 * inside the raw results (not copied here), which expire on YouCam's side.
 */
export interface SkinPassport {
  version: 1;
  createdAt: string;
  /** SHA-256 of the image bytes (or URL). The image itself is never stored. */
  imageSha256: string;
  source: { mock: boolean; synthetic: boolean; tier: "full" | "lean" };
  skinAge?: number;
  overallScore?: number;
  skinType?: { whole?: string; tZone?: string; uZone?: string };
  concerns: PassportConcern[];
  fitzpatrick?: FitzpatrickType;
  /** Hex colors from Facial Color Tones. No undertone here: A3's deriveUndertone() computes it. */
  colors: FaceColors & { skin_color?: string };
  faceQuality?: FaceQuality;
  units: { expected: number; charged: number };
  taskIds: Record<string, string>;
}

/** Pure mapping from the three API results to a passport. */
export function buildSkinPassport(input: {
  skin: SkinAnalysisResult;
  fitzpatrick?: FitzpatrickResult;
  tones: FacialColorTonesResult;
  imageSha256: string;
  createdAt?: string;
}): Omit<SkinPassport, "source" | "units" | "taskIds"> {
  const concerns = new Map<string, PassportConcern>();
  const skinType: NonNullable<SkinPassport["skinType"]> = {};
  let skinAge: number | undefined;
  let overallScore: number | undefined;

  for (const item of input.skin.output ?? []) {
    const type = item.type;
    if (type === "skin_age") {
      skinAge = item.score;
      continue;
    }
    if (type === "all") {
      overallScore = item.score;
      continue;
    }
    if ((type === "hd_skin_type" || type === "skin_type") && item.skin_type !== undefined) {
      // Docs sample: a skin_type label per region. The schema also allows scores; those
      // fall through and are kept as a "skin_type" concern.
      const region = item.region ?? "whole";
      if (region === "t_zone") skinType.tZone = item.skin_type;
      else if (region === "u_zone") skinType.uZone = item.skin_type;
      else skinType.whole = item.skin_type;
    }
    if (item.ui_score === undefined && item.raw_score === undefined) continue; // e.g. resize_image
    const key = type.replace(/^hd_/, "");
    const c = concerns.get(key) ?? { key, regions: {}, uiRegions: {} };
    const region = item.region ?? "whole";
    if (item.raw_score !== undefined) c.regions[region] = item.raw_score;
    if (item.ui_score !== undefined) c.uiRegions[region] = item.ui_score;
    if (region === "whole" || (c.rawScore === undefined && c.uiScore === undefined)) {
      c.uiScore = item.ui_score;
      c.rawScore = item.raw_score;
    }
    concerns.set(key, c);
  }

  return {
    version: 1,
    createdAt: input.createdAt ?? new Date().toISOString(),
    imageSha256: input.imageSha256,
    skinAge,
    overallScore,
    skinType: Object.keys(skinType).length ? skinType : undefined,
    concerns: [...concerns.values()],
    fitzpatrick: input.fitzpatrick?.fitzpatrick_scale,
    colors: { ...(input.tones.color ?? {}) },
    faceQuality: input.tones.face_quality,
  };
}

export interface RunSkinPassportOptions {
  /** "full" = 16 HD concerns (52 units total), "lean" = 8 HD concerns (46). */
  tier?: "full" | "lean";
  /** Skip Fitzpatrick (-10 units), a budget lever from ADR-006. */
  includeFitzpatrick?: boolean;
  /** Called after each API result (the smoke script saves them as fixtures). */
  onResult?: (result: RunResult<unknown>) => void | Promise<void>;
}

export function passportPlan(opts: Pick<RunSkinPassportOptions, "tier" | "includeFitzpatrick"> = {}) {
  const dstActions = opts.tier === "lean" ? LEAN_HD_ACTIONS : HD_SKIN_ACTIONS;
  const plan = [
    { feature: "skin-analysis" as const, params: { dstActions } },
    ...(opts.includeFitzpatrick === false ? [] : [{ feature: "fitzpatrick-scale-analyzer" as const, params: {} }]),
    { feature: "skin-tone-analysis" as const, params: {} },
  ];
  return plan;
}

/** Runs the three skin APIs sequentially (so the cost guard sees each charge) and builds the passport. */
export async function runSkinPassport(
  client: YoucamClient,
  image: ImageInput,
  opts: RunSkinPassportOptions = {},
): Promise<SkinPassport> {
  const tier = opts.tier ?? "full";
  const dstActions = tier === "lean" ? LEAN_HD_ACTIONS : HD_SKIN_ACTIONS;
  const results: RunResult<unknown>[] = [];
  const track = async <R>(p: Promise<RunResult<R>>) => {
    const r = await p;
    results.push(r as RunResult<unknown>);
    await opts.onResult?.(r as RunResult<unknown>);
    return r;
  };

  const skin = await track(client.skinAnalysis(image, { dstActions }));
  const fitz = opts.includeFitzpatrick === false ? undefined : await track(client.fitzpatrick(image));
  const tones = await track(client.facialColorTones(image));

  const imageSha256 = "bytes" in image ? sha256Hex(image.bytes) : sha256Hex(image.url);
  return {
    ...buildSkinPassport({ skin: skin.result, fitzpatrick: fitz?.result, tones: tones.result, imageSha256 }),
    source: { mock: results.every((r) => r.mock), synthetic: results.some((r) => r.synthetic), tier },
    units: {
      expected: results.reduce((a, r) => a + (r.unitsExpected ?? 0), 0),
      charged: results.reduce((a, r) => a + r.unitsCharged, 0),
    },
    taskIds: Object.fromEntries(results.map((r) => [r.feature, r.taskId])),
  };
}

/**
 * Request and result types for the YouCam S2S v2 API, written from the
 * docs.perfectcorp.com OpenAPI bundles and docs/research/api_matrix.md (2026-10-15).
 * Result types only declare the fields GiftFit reads; unknown extra fields are kept at runtime.
 *
 * GiftFit critical path: skin-tone-analysis, face-attr-analysis, 2d-vto/*.
 * v1 (TrueShelf) leftovers kept off the critical path: skin-analysis, fitzpatrick,
 * skin-simulation, makeup-vto, hair-color, cloth-v4.
 */

export type TaskStatus = "running" | "success" | "error";

/** `data` envelope of GET /task/<slug>/<task_id>. */
export interface TaskData<R = unknown> {
  task_status: TaskStatus;
  /** Engine error code. Free string: the docs list more codes than the OpenAPI enum, and jewelry uses UPPER_CASE codes. */
  error?: string | null;
  error_message?: string;
  results?: R;
}

// ---------- inputs ----------

export type ImageContentType = "image/jpeg" | "image/png";

/**
 * An image the client uploads (bytes) or passes by public URL.
 * Privacy (MASTER_PLAN 4.4): user photos (faces, hands) always go as bytes; use `url`
 * only for public catalog product images.
 */
export type ImageInput =
  | {
      bytes: Uint8Array;
      contentType: ImageContentType;
      fileName?: string;
      /** Set after client.uploadImages(): the bytes are already uploaded, reuse this file_id. */
      fileId?: string;
    }
  | { url: string };

export type FaceAngleStrictness = "strict" | "high" | "medium" | "low" | "flexible";

export const HD_SKIN_ACTIONS = [
  "hd_wrinkle",
  "hd_pore",
  "hd_texture",
  "hd_acne",
  "hd_moisture",
  "hd_oiliness",
  "hd_redness",
  "hd_radiance",
  "hd_age_spot",
  "hd_dark_circle",
  "hd_eye_bag",
  "hd_firmness",
  "hd_droopy_upper_eyelid",
  "hd_droopy_lower_eyelid",
  "hd_tear_trough",
  "hd_skin_type",
] as const;
export type HdSkinAction = (typeof HD_SKIN_ACTIONS)[number];

export const SD_SKIN_ACTIONS = [
  "wrinkle",
  "pore",
  "texture",
  "acne",
  "oiliness",
  "radiance",
  "eye_bag",
  "age_spot",
  "dark_circle_v2",
  "droopy_upper_eyelid",
  "droopy_lower_eyelid",
  "firmness",
  "moisture",
  "redness",
  "tear_trough",
  "skin_type",
] as const;
export type SdSkinAction = (typeof SD_SKIN_ACTIONS)[number];
export type SkinAction = HdSkinAction | SdSkinAction;

export interface SkinAnalysisParams {
  /** All HD or all SD (never mixed). Defaults to the 16 HD concerns (22 units). */
  dstActions?: readonly SkinAction[];
  /** true: blended overlay jpg masks; false (default): raw png masks. */
  maskOverlay?: boolean;
}

export type FitzpatrickParams = {
  /** Zero-based face index for multi-face images. Default 0. */
  index?: number;
};

export interface FacialColorTonesParams {
  faceAngleStrictness?: FaceAngleStrictness;
}

export const FACE_ATTR_FEATURES = [
  "eyeShape",
  "eyeSize",
  "eyeAngle",
  "eyeDistance",
  "eyelid",
  "eyebrowShape",
  "eyebrowThickness",
  "eyebrowDistance",
  "eyebrowShortness",
  "cheekbones",
  "faceShape",
  "lipShape",
  "noseWidth",
  "noseLength",
  "age",
  "gender",
  "eyeColor",
  "lipColor",
  "eyebrowColor",
  "hairColor",
  "horizontalThird",
  "verticalFifth",
  "faceAspectRatio",
  "eyeAspectRatio",
  "eyebrowPosition",
  "eyebrowArch",
  "eyeHeightToEyebrowDistance",
  "noseAspectRatio",
  "noseWidthToMouthWidth",
  "noseToLipToChin",
  "upperLipToLowerLip",
] as const;
export type FaceAttrFeature = (typeof FACE_ATTR_FEATURES)[number];

export interface FaceAttributesParams {
  /**
   * 1-5 features = 10 units, 6-14 = 20, 15-28 = 30. Defaults to GiftFit's 5:
   * faceShape, faceAspectRatio, cheekbones, eyeDistance, noseWidth.
   */
  features?: readonly FaceAttrFeature[];
  /** Required to request more than 5 features (20/30-unit tiers). */
  allowHigherTier?: boolean;
  faceAngleStrictness?: FaceAngleStrictness;
}

export const SKIN_SIMULATION_CONCERNS = [
  "wrinkle",
  "radiance",
  "oiliness",
  "acne",
  "eye_bags",
  "dark_circle",
  "spots",
  "pores",
  "texture",
  "redness",
] as const;
export type SkinSimulationConcern = (typeof SKIN_SIMULATION_CONCERNS)[number];

export interface SkinSimulationParams {
  /**
   * Intensity 0.0-1.0 per concern; at least one > 0. 1-4 concerns = 4 units, 5-10 = 6.
   * The docs disagree on the direction of `oiliness` (adds vs reduces shine): do not
   * expose it in the UI until a real call confirms it (api_matrix.md section 5).
   */
  concerns: Partial<Record<SkinSimulationConcern, number>>;
}

/** One makeup effect (skin_smooth, blush, lip_color, foundation, ...). See makeup_vto docs. */
export interface MakeupEffect {
  category: string;
  [key: string]: unknown;
}

export interface MakeupVtoParams {
  effects: readonly MakeupEffect[];
  version?: string;
}

export const HAIR_COLOR_PRESETS = [
  "Jet Black",
  "Chocolate Brown",
  "Honey Blonde",
  "Platinum Blonde",
  "Ash Gray",
  "Rose Gold",
  "Burgundy",
  "Copper Red",
  "Lavender",
  "Teal Blue",
  "Dark Brown/Caramel Blonde",
  "Jet Black/Silver Gray",
  "Ash Brown/Lavender",
  "Rose Gold/Peach Blonde",
  "Burgundy/Magenta Pink",
  "Deep Blue/Teal Green",
  "Plum Purple/Pastel Lilac",
  "Copper Red/Golden Blonde",
  "Dark Gray/Ice Blonde",
  "Midnight Blue/Denim Blue",
] as const;
export type HairColorPreset = (typeof HAIR_COLOR_PRESETS)[number];

export interface HairColorParams {
  preset?: HairColorPreset;
  pattern?: {
    name: "full" | "ombre";
    blend_strength?: number;
    line_offset?: number;
    coloring_section?: "top";
  };
  palettes?: ReadonlyArray<{ color: string; color_intensity?: number; shine_intensity?: number }>;
}

export type GarmentCategory = "upper_body" | "lower_body" | "full_body" | "outer" | "shoes" | "auto";

/**
 * Clothes VTO v4. The source image (the `img` argument) must be a single person,
 * standing, facing forward, filling >= 80% of the frame: full body for
 * lower_body / full_body / shoes, chest-up with shoulders for upper_body / outer.
 * A Skin Passport selfie is not a valid input.
 */
export interface ClothVtoParams {
  /** Garment product image (catalog image; a public URL is fine). */
  garment: ImageInput;
  garmentCategory: GarmentCategory;
  changeShoes?: boolean;
  filterMultiPerson?: "off" | "normal" | "strict";
}

export type JewelryKind = "earring" | "necklace" | "ring" | "bracelet" | "watch";

/**
 * Jewelry 2D VTO. Source image (the `img` argument) by kind:
 * - earring: face photo (side-facing works best); necklace: front selfie with the neck visible
 *   (neck width >= 15% of the image);
 * - ring: back of the hand, all five fingers visible; bracelet / watch: back of the wrist with
 *   all five fingers visible. A face selfie does not work for ring, bracelet or watch.
 *
 * TODO(verify with the first real call, 1 unit): the docs never print a full request. The
 * client sends body variant A (superset) by default; buildJewelryBody() in features.ts holds
 * variants A/B/C and YOUCAM_JEWELRY_BODY_VARIANT pins the one the API accepts.
 * "Stacked" (2 units) is assumed to mean several products in one task; also unverified.
 */
export interface JewelryVtoParams {
  /** Product images (white background is fine). More than one = "Stacked" tier (2 units) where offered. */
  products: readonly ImageInput[];
  /** 0-1. Sent explicitly on every task (defaults in JEWELRY_LIGHT_DEFAULTS, features.ts). */
  shadowIntensity?: number;
  /** 0-1. Sent explicitly on every task (default 1.0). */
  ambientLightIntensity?: number;
  /**
   * Per-object engine parameters, applied to every object, e.g. { earring_is_right_ear: true,
   * earring_shadow_intensity: 0.2, earring_ambient_light_intensity: 1 }. Loosely typed on purpose
   * (keys are prefixed by kind; docs and OpenAPI disagree on defaults, so send shadow/ambient explicitly).
   */
  parameter?: Record<string, unknown>;
}

// ---------- results ----------

export interface SkinAnalysisOutputItem {
  /** e.g. "hd_wrinkle", "hd_skin_type", "skin_age", "all", "resize_image". */
  type: string;
  region?: string;
  /**
   * Model score, 1-100 float, higher = healthier. **Use this one for matching and
   * the Transparency Card.**
   */
  raw_score?: number;
  /** 1-100 int, deliberately inflated by YouCam for display ("more favorable results"). Show only as a labelled friendly view. */
  ui_score?: number;
  score?: number;
  skin_type?: string;
  mask_urls?: string[];
}

/** format=json result of AI Skin Analysis v2.1. */
export interface SkinAnalysisResult {
  output: SkinAnalysisOutputItem[];
}

export type FitzpatrickType = "I" | "II" | "III" | "IV" | "V" | "VI";

export interface FitzpatrickResult {
  fitzpatrick_scale: FitzpatrickType;
  /** Engine processing time, seconds. */
  timed?: number;
}

export interface FaceQuality {
  has_face?: boolean;
  area?: string;
  frontal?: string;
  lighting?: string;
  faceangle?: string;
}

export interface FaceColors {
  skin_color?: string;
  eye_color?: string;
  eye_color_name?: string;
  lip_color?: string;
  eyebrow_color?: string;
  hair_color?: string;
  hair_color_name?: string;
}

/**
 * AI Facial Color Tones Analyzer (slug skin-tone-analysis). Returns hex colors only:
 * there is no undertone in the API, and this client deliberately adds none.
 * A3 owns deriveUndertone(skin_color).
 */
export interface FacialColorTonesResult {
  face_quality?: FaceQuality;
  color: FaceColors & { skin_color: string };
}

export type FaceShape =
  | "Triangle"
  | "Diamond"
  | "Heart"
  | "InvTriangle"
  | "Oblong"
  | "Oval"
  | "Round"
  | "Square"
  | "Unknown";

/** AI Face Attributes & Ratio Analyzer. Only requested features are present. */
export interface FaceAttributesResult {
  face_quality?: FaceQuality;
  faceshape?: FaceShape;
  agegender?: { age?: number; gender?: string };
  eyelid?: Record<string, string>;
  eyebrow?: Record<string, string>;
  lipshape?: string[];
  nose?: { width?: string; length?: string };
  /** The live API spells the summary key `overrall` (verified on the first real call, ADR-026). */
  cheekbone?: { left?: string; right?: string; overall?: string; overrall?: string };
  color?: FaceColors;
  facialratio?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Image-producing tasks (VTO, simulation): one result image URL (valid ~24 h). */
export interface ImageResult {
  url: string;
  dst_id?: string;
  [key: string]: unknown;
}

// ---------- account ----------

export interface CreditBatch {
  id?: number;
  type?: string;
  amount?: number;
  amount_dec?: number;
  expiry?: number;
}

export interface Balance {
  /** Sum of API-spendable batches (types starting with "Api"). */
  units: number;
  byType: Record<string, number>;
}

export interface FeatureCostSku {
  description?: string;
  amount: number;
  unit?: string;
  proc_unit?: number;
  /** Task slug derived from run_task_url, e.g. "skin-analysis" or "2d-vto/earring". */
  feature: string;
  run_task_url?: string;
}

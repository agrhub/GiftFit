/**
 * Feature registry: task paths, request-body builders, local validation and the
 * pricing tier each request falls into. Endpoints and tiers confirmed live on
 * 2026-10-15 (docs/hackathon/feature_costs.md).
 */
import type { JewelryBodyVariant } from "./config";
import { YoucamValidationError } from "./errors";
import {
  FACE_ATTR_FEATURES,
  HD_SKIN_ACTIONS,
  HAIR_COLOR_PRESETS,
  SD_SKIN_ACTIONS,
  SKIN_SIMULATION_CONCERNS,
  type ClothVtoParams,
  type FaceAttributesParams,
  type FaceAttributesResult,
  type FacialColorTonesParams,
  type FacialColorTonesResult,
  type FitzpatrickParams,
  type FitzpatrickResult,
  type HairColorParams,
  type ImageInput,
  type ImageResult,
  type JewelryKind,
  type JewelryVtoParams,
  type MakeupVtoParams,
  type SkinAnalysisParams,
  type SkinAnalysisResult,
  type SkinSimulationParams,
} from "./types";

export const JEWELRY_KINDS: readonly JewelryKind[] = ["earring", "necklace", "ring", "bracelet", "watch"];

/** Maps every task slug to its params and result types. */
export interface FeatureMap {
  "skin-analysis": { params: SkinAnalysisParams; result: SkinAnalysisResult };
  "fitzpatrick-scale-analyzer": { params: FitzpatrickParams; result: FitzpatrickResult };
  "skin-tone-analysis": { params: FacialColorTonesParams; result: FacialColorTonesResult };
  "face-attr-analysis": { params: FaceAttributesParams; result: FaceAttributesResult };
  "skin-simulation": { params: SkinSimulationParams; result: ImageResult };
  "makeup-vto": { params: MakeupVtoParams; result: ImageResult };
  "hair-color": { params: HairColorParams; result: ImageResult };
  "cloth-v4": { params: ClothVtoParams; result: ImageResult };
  "2d-vto/earring": { params: JewelryVtoParams; result: ImageResult };
  "2d-vto/necklace": { params: JewelryVtoParams; result: ImageResult };
  "2d-vto/ring": { params: JewelryVtoParams; result: ImageResult };
  "2d-vto/bracelet": { params: JewelryVtoParams; result: ImageResult };
  "2d-vto/watch": { params: JewelryVtoParams; result: ImageResult };
}

export type FeatureSlug = keyof FeatureMap;
export type ParamsOf<F extends FeatureSlug> = FeatureMap[F]["params"];
export type ResultOf<F extends FeatureSlug> = FeatureMap[F]["result"];

/** What part of a SKU description a request must match to find its price. */
export interface TierSelector {
  /** e.g. "V2.1" (skin analysis prices are listed per API version). */
  versionLabel?: string;
  quality?: "HD" | "SD";
  /** Matched against "(a-b concerns)" / "(a-b features)" ranges. */
  count?: number;
  /** Matched against "(Single)", "(Stacked)", "(Full)", "(Ombre)". */
  variant?: string;
}

export type RefMode = "none" | "single" | "multi";

export interface FeatureSpec<F extends FeatureSlug> {
  slug: F;
  /** Path version segment, e.g. "v2.1". */
  version: string;
  label: string;
  docUrl: string;
  /** How reference images (garment, jewelry products) are attached. */
  refMode: RefMode;
  /** Validates params and returns the JSON body without file references. */
  buildBody(params: ParamsOf<F>): Record<string, unknown>;
  tier(params: ParamsOf<F>): TierSelector;
  refs(params: ParamsOf<F>): readonly ImageInput[];
  /** Per-object engine parameters (jewelry): validated, with explicit defaults filled in. */
  objectParameter?(params: ParamsOf<F>): Record<string, unknown>;
  /** Upload endpoint override (the ring VTO has its own file endpoint). */
  uploadPath?: string;
}

export const DEFAULT_UPLOAD_PATH = "/s2s/v2.0/file";

export function taskPath(spec: { slug: string; version: string }): string {
  return `/s2s/${spec.version}/task/${spec.slug}`;
}

function invalid(message: string): never {
  throw new YoucamValidationError(message);
}

const noRefs = () => [] as const;

export const DEFAULT_HD_ACTIONS = HD_SKIN_ACTIONS;

const skinAnalysis: FeatureSpec<"skin-analysis"> = {
  slug: "skin-analysis",
  version: "v2.1",
  label: "AI Skin Analysis",
  docUrl: "https://docs.perfectcorp.com/reference/ai_skin_analysis",
  refMode: "none",
  buildBody(p) {
    const actions = [...(p.dstActions ?? DEFAULT_HD_ACTIONS)];
    if (actions.length === 0) invalid("skin-analysis: dstActions must not be empty");
    if (new Set(actions).size !== actions.length) invalid("skin-analysis: dstActions has duplicates");
    const hd = actions.filter((a) => (HD_SKIN_ACTIONS as readonly string[]).includes(a));
    const sd = actions.filter((a) => (SD_SKIN_ACTIONS as readonly string[]).includes(a));
    if (hd.length + sd.length !== actions.length) invalid("skin-analysis: unknown action in dstActions");
    if (hd.length > 0 && sd.length > 0) invalid("skin-analysis: HD and SD actions cannot be mixed");
    return {
      dst_actions: actions,
      format: "json",
      miniserver_args: { enable_mask_overlay: p.maskOverlay ?? false },
    };
  },
  tier(p) {
    const actions = p.dstActions ?? DEFAULT_HD_ACTIONS;
    const quality = actions.every((a) => a.startsWith("hd_")) ? "HD" : "SD";
    return { versionLabel: "V2.1", quality, count: actions.length };
  },
  refs: noRefs,
};

const fitzpatrick: FeatureSpec<"fitzpatrick-scale-analyzer"> = {
  slug: "fitzpatrick-scale-analyzer",
  version: "v2.0",
  label: "AI Fitzpatrick Skin Type",
  docUrl: "https://docs.perfectcorp.com/reference/ai_fitzpatrick_skin_type",
  refMode: "none",
  buildBody(p) {
    const index = p.index ?? 0;
    if (!Number.isInteger(index) || index < 0) invalid("fitzpatrick: index must be a non-negative integer");
    return { version: "1.0", index };
  },
  tier: () => ({}),
  refs: noRefs,
};

const strictness = (level: string | undefined) => (level ? { face_angle_strictness_level: level } : {});

const facialColorTones: FeatureSpec<"skin-tone-analysis"> = {
  slug: "skin-tone-analysis",
  version: "v2.0",
  label: "AI Facial Color Tones",
  docUrl: "https://docs.perfectcorp.com/reference/ai_skin_tone_analysis",
  refMode: "none",
  buildBody: (p) => ({ ...strictness(p.faceAngleStrictness) }),
  tier: () => ({}),
  refs: noRefs,
};

/** GiftFit's face-attribute set (5 features = 10 units), api_matrix.md section 4. */
export const GIFT_FACE_FEATURES = ["faceShape", "faceAspectRatio", "cheekbones", "eyeDistance", "noseWidth"] as const;

const faceAttributes: FeatureSpec<"face-attr-analysis"> = {
  slug: "face-attr-analysis",
  version: "v2.0",
  label: "AI Face Attributes & Ratio",
  docUrl: "https://docs.perfectcorp.com/reference/ai_face_analyzer",
  refMode: "none",
  buildBody(p) {
    const features = [...(p.features ?? GIFT_FACE_FEATURES)];
    if (features.length === 0) invalid("face-attr-analysis: features must not be empty");
    if (features.length > 5 && !p.allowHigherTier) {
      invalid("face-attr-analysis: more than 5 features moves to the 20/30-unit tier; pass allowHigherTier: true");
    }
    if (features.some((f) => !(FACE_ATTR_FEATURES as readonly string[]).includes(f))) {
      invalid("face-attr-analysis: unknown feature");
    }
    if (new Set(features).size !== features.length) invalid("face-attr-analysis: duplicate features");
    return { features, ...strictness(p.faceAngleStrictness) };
  },
  tier: (p) => ({ count: (p.features ?? GIFT_FACE_FEATURES).length }),
  refs: noRefs,
};

const skinSimulation: FeatureSpec<"skin-simulation"> = {
  slug: "skin-simulation",
  version: "v2.0",
  label: "AI Skin Simulation",
  docUrl: "https://docs.perfectcorp.com/reference/ai_skin_simulation",
  refMode: "none",
  buildBody(p) {
    const body: Record<string, number> = {};
    for (const [k, v] of Object.entries(p.concerns ?? {})) {
      if (!(SKIN_SIMULATION_CONCERNS as readonly string[]).includes(k)) invalid(`skin-simulation: unknown concern ${k}`);
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
        invalid(`skin-simulation: ${k} intensity must be within 0.0-1.0`);
      }
      if (v > 0) body[k] = v;
    }
    if (Object.keys(body).length === 0) invalid("skin-simulation: at least one concern intensity must be > 0");
    return body;
  },
  tier: (p) => ({ count: Object.values(p.concerns).filter((v) => typeof v === "number" && v > 0).length }),
  refs: noRefs,
};

const makeupVto: FeatureSpec<"makeup-vto"> = {
  slug: "makeup-vto",
  version: "v2.0",
  label: "AI Makeup VTO",
  docUrl: "https://docs.perfectcorp.com/reference/makeup_vto",
  refMode: "none",
  buildBody(p) {
    if (!p.effects?.length) invalid("makeup-vto: effects must not be empty");
    if (p.effects.some((e) => typeof e?.category !== "string" || !e.category)) {
      invalid("makeup-vto: every effect needs a category");
    }
    return { version: p.version ?? "1.0", effects: p.effects };
  },
  tier: () => ({}),
  refs: noRefs,
};

const HEX = /^#[0-9A-Fa-f]{6}$/;

const hairColor: FeatureSpec<"hair-color"> = {
  slug: "hair-color",
  version: "v2.0",
  label: "AI Hair Color VTO",
  docUrl: "https://docs.perfectcorp.com/reference/ai_hair_color",
  refMode: "none",
  buildBody(p) {
    if (p.preset) {
      if (!(HAIR_COLOR_PRESETS as readonly string[]).includes(p.preset)) invalid("hair-color: unknown preset");
      return { preset: p.preset };
    }
    if (!p.pattern || !p.palettes?.length) invalid("hair-color: give a preset, or a pattern plus palettes");
    const expected = p.pattern.name === "ombre" ? 2 : 1;
    if (p.palettes.length !== expected) invalid(`hair-color: ${p.pattern.name} mode needs ${expected} palette(s)`);
    if (p.palettes.some((c) => !HEX.test(c.color))) invalid("hair-color: palette colors must be #RRGGBB");
    return { pattern: p.pattern, palettes: p.palettes };
  },
  tier: (p) => ({
    variant: p.preset ? (p.preset.includes("/") ? "Ombre" : "Full") : p.pattern?.name === "ombre" ? "Ombre" : "Full",
  }),
  refs: noRefs,
};

const GARMENTS = ["upper_body", "lower_body", "full_body", "outer", "shoes", "auto"];

const clothVto: FeatureSpec<"cloth-v4"> = {
  slug: "cloth-v4",
  version: "v2.0",
  label: "AI Clothes VTO v4",
  docUrl: "https://docs.perfectcorp.com/reference/ai_clothes",
  refMode: "single",
  buildBody(p) {
    if (!p.garment) invalid("cloth-v4: garment image is required");
    if (!GARMENTS.includes(p.garmentCategory)) invalid("cloth-v4: unknown garmentCategory");
    const body: Record<string, unknown> = { garment_category: p.garmentCategory };
    if (p.changeShoes !== undefined) body.change_shoes = p.changeShoes;
    if (p.filterMultiPerson !== undefined) body.filter_multi_person = p.filterMultiPerson;
    return body;
  },
  tier: () => ({}),
  refs: (p) => [p.garment],
};

/** Kinds priced Single (1 unit) vs Stacked (2 units). Necklace and watch have one tier. */
const STACKABLE: readonly JewelryKind[] = ["earring", "ring", "bracelet"];

/**
 * Explicit shadow/ambient values sent with every jewelry task: docs prose and OpenAPI
 * disagree on the defaults (api_matrix.md section 9), so never rely on the server's.
 */
export const JEWELRY_LIGHT_DEFAULTS: Record<JewelryKind, { shadow: number; ambient: number }> = {
  earring: { shadow: 0.2, ambient: 1 },
  necklace: { shadow: 0.2, ambient: 1 },
  ring: { shadow: 0.15, ambient: 1 },
  bracelet: { shadow: 0.3, ambient: 1 },
  watch: { shadow: 0.3, ambient: 1 },
};

/** Jewelry kinds whose source photo is the back of the hand / wrist, not a selfie. */
export const HAND_JEWELRY: readonly JewelryKind[] = ["ring", "bracelet", "watch"];

function jewelry<K extends JewelryKind>(kind: K, docSlug: string): FeatureSpec<`2d-vto/${K}`> {
  return {
    slug: `2d-vto/${kind}`,
    version: "v2.0",
    label: `AI ${kind[0].toUpperCase()}${kind.slice(1)} VTO`,
    docUrl: `https://docs.perfectcorp.com/reference/${docSlug}`,
    refMode: "multi",
    // The ring OpenAPI also declares POST /s2s/v2.0/file/2d-vto/ring, but the ring prose says to use
    // the generic file endpoint. TODO(verify): if ring file_ids from /s2s/v2.0/file are rejected,
    // set uploadPath to "/s2s/v2.0/file/2d-vto/ring" here.
    uploadPath: undefined,
    buildBody(p) {
      if (!p.products?.length) invalid(`2d-vto/${kind}: at least one product image is required`);
      if (!STACKABLE.includes(kind) && p.products.length > 1) invalid(`2d-vto/${kind}: only one product per task`);
      for (const [name, v] of [
        ["shadowIntensity", p.shadowIntensity],
        ["ambientLightIntensity", p.ambientLightIntensity],
      ] as const) {
        if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1)) {
          invalid(`2d-vto/${kind}: ${name} must be within 0-1`);
        }
      }
      return {};
    },
    objectParameter(p) {
      const shadowKey = `${kind}_shadow_intensity`;
      const ambientKey = `${kind}_ambient_light_intensity`;
      return {
        [`${kind}_need_remove_background`]: true,
        ...(kind === "earring" ? { earring_is_right_ear: true } : {}),
        [shadowKey]: JEWELRY_LIGHT_DEFAULTS[kind].shadow,
        [ambientKey]: JEWELRY_LIGHT_DEFAULTS[kind].ambient,
        ...(p.parameter ?? {}),
        ...(p.shadowIntensity !== undefined ? { [shadowKey]: p.shadowIntensity } : {}),
        ...(p.ambientLightIntensity !== undefined ? { [ambientKey]: p.ambientLightIntensity } : {}),
      };
    },
    tier: (p) => (STACKABLE.includes(kind) ? { variant: p.products.length > 1 ? "Stacked" : "Single" } : {}),
    refs: (p) => p.products,
  } as FeatureSpec<`2d-vto/${K}`>;
}

export const FEATURES: { [F in FeatureSlug]: FeatureSpec<F> } = {
  "skin-analysis": skinAnalysis,
  "fitzpatrick-scale-analyzer": fitzpatrick,
  "skin-tone-analysis": facialColorTones,
  "face-attr-analysis": faceAttributes,
  "skin-simulation": skinSimulation,
  "makeup-vto": makeupVto,
  "hair-color": hairColor,
  "cloth-v4": clothVto,
  "2d-vto/earring": jewelry("earring", "ai_earrings"),
  "2d-vto/necklace": jewelry("necklace", "ai_necklace"),
  "2d-vto/ring": jewelry("ring", "ring_vto"),
  "2d-vto/bracelet": jewelry("bracelet", "ai_bracelet"),
  "2d-vto/watch": jewelry("watch", "ai_watch"),
};

export function getFeature<F extends FeatureSlug>(slug: F): FeatureSpec<F> {
  const spec = FEATURES[slug];
  if (!spec) throw new YoucamValidationError(`unknown YouCam feature: ${slug}`);
  return spec;
}

const HOUR = 60 * 60 * 1000;
const ANALYSIS: readonly string[] = ["skin-analysis", "fitzpatrick-scale-analyzer", "skin-tone-analysis", "face-attr-analysis"];

/**
 * How long a cached result may be reused. Image results carry a YouCam download URL
 * that expires after 2 h, so they are cached for 90 min. Analysis results (numbers and
 * hex colors) live as long as a Fit Request link (72 h) and are deleted with it.
 */
export function resultCacheTtlMs(slug: string): number {
  return ANALYSIS.includes(slug) ? 72 * HOUR : 1.5 * HOUR;
}

/** File-name-safe form of a slug: "2d-vto/earring" -> "2d-vto-earring". */
export function fixtureName(slug: string): string {
  return slug.replace(/\//g, "-");
}

/** A file the API can read: an uploaded file_id or a public URL. */
export type FileRef = { kind: "id"; value: string } | { kind: "url"; value: string };

/**
 * The one builder for jewelry 2d-vto bodies (docs/hackathon/first_real_calls.md). The docs
 * never print a full request, so three variants exist until the first real call decides:
 *   A (superset, default): src/ref file fields AND source_info + object_infos (name + parameter)
 *   B: source_info + object_infos only (no src_* / ref_* fields)
 *   C: src/ref file fields + object_infos with parameter only (no source_info, no names)
 * TODO(verify with the first real call): pin the winner with YOUCAM_JEWELRY_BODY_VARIANT.
 */
export function buildJewelryBody(
  variant: JewelryBodyVariant,
  src: FileRef,
  refs: readonly FileRef[],
  parameter?: Record<string, unknown>,
): Record<string, unknown> {
  if (refs.length === 0) invalid("at least one reference image is required");
  if (new Set(refs.map((r) => r.kind)).size > 1) invalid("reference images must be all uploads or all URLs, not mixed");
  const out: Record<string, unknown> = {};
  if (variant !== "B") {
    out[src.kind === "id" ? "src_file_id" : "src_file_url"] = src.value;
    out[refs[0].kind === "id" ? "ref_file_ids" : "ref_file_urls"] = refs.map((r) => r.value);
  }
  if (variant !== "C") out.source_info = { name: src.value };
  out.object_infos = refs.map((r) => ({
    ...(variant !== "C" ? { name: r.value } : {}),
    ...(parameter ? { parameter } : {}),
  }));
  return out;
}

/** Adds src/ref file fields to a task body; jewelry (multi-ref) goes through buildJewelryBody. */
export function attachFiles(
  refMode: RefMode,
  body: Record<string, unknown>,
  src: FileRef,
  refs: readonly FileRef[],
  objectParameter?: Record<string, unknown>,
  variant: JewelryBodyVariant = "A",
): Record<string, unknown> {
  if (refMode === "multi") return { ...body, ...buildJewelryBody(variant, src, refs, objectParameter) };
  const out: Record<string, unknown> = { ...body };
  out[src.kind === "id" ? "src_file_id" : "src_file_url"] = src.value;
  if (refMode === "single") {
    if (refs.length !== 1) invalid("exactly one reference image is required");
    out[refs[0].kind === "id" ? "ref_file_id" : "ref_file_url"] = refs[0].value;
  }
  return out;
}

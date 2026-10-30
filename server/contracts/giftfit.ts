/**
 * Shared GiftFit contracts (owner: R0). Types and vocabularies only — no runtime logic.
 *
 * P2 agents build in parallel against these: A2 tags the catalog with these tokens, A10 implements
 * `JewelryRules` in server/verticals/jewelry.ts, A3 scores with an injected `JewelryRules`, A5 checks
 * fairness and privacy against the same shapes. Vocabulary comes from docs/research/jewelry_rules.md
 * (ADR-013) and the `faceshape` strings returned by face-attr-analysis (docs/research/api_matrix.md §4).
 * Change requests go to R0 (docs/DECISIONS.md), not ad-hoc edits.
 */
import type { JewelryAttributes, JewelryCategory, MetalTone, Undertone } from "@/server/db/schema";

export type { JewelryCategory, MetalTone, Undertone };

/** Exact `faceshape` values from face-attr-analysis. `Unknown` gets no style rules. */
export const FACE_SHAPES = [
  "Oval",
  "Round",
  "Square",
  "Heart",
  "InvTriangle",
  "Oblong",
  "Diamond",
  "Triangle",
  "Unknown",
] as const;
export type FaceShape = (typeof FACE_SHAPES)[number];

/** Canonical metal keys (jewelry_rules.md Table 1). */
export const METALS = ["yellow_gold", "rose_gold", "white_gold", "silver", "platinum", "mixed_two_tone"] as const;
export type Metal = (typeof METALS)[number];

/** Earring shape tokens (jewelry_rules.md Table 2a). Every earring SKU carries exactly one. */
export const EARRING_SHAPES = [
  "stud_small",
  "stud_statement",
  "hoop_round_large",
  "hoop_small_medium",
  "hoop_oval_curved",
  "drop_long_narrow",
  "drop_teardrop",
  "drop_wide_bottom",
  "chandelier",
  "chandelier_short",
  "geometric_angular",
] as const;
export type EarringShape = (typeof EARRING_SHAPES)[number];

/** Necklace style tokens (jewelry_rules.md Table 2b). Length is a separate number in inches. */
export const NECKLACE_STYLES = [
  "pendant_v_y",
  "pendant_curved",
  "choker",
  "choker_heavy",
  "collar_bib_horizontal",
  "long_vertical",
  "thin_chain",
  "large_stone",
  "geometric_angular",
] as const;
export type NecklaceStyle = (typeof NECKLACE_STYLES)[number];

/** Rule strength from the sourced tables; weights per jewelry_rules.md (avoid only where ≥ 2 sources agree). */
export type RuleStrength = "recommended" | "acceptable" | "avoid" | "none";

export const OCCASIONS = ["anniversary", "birthday", "wedding", "holiday", "graduation", "thank_you", "just_because"] as const;
export type Occasion = (typeof OCCASIONS)[number];

/** catalog.attributes for GiftFit SKUs: the schema's JewelryAttributes narrowed to the shared vocabulary. */
export interface GiftFitAttributes extends JewelryAttributes {
  category: JewelryCategory;
  metal: Metal;
  metal_tone: MetalTone;
  /** Design-language style shown to shoppers, e.g. "minimal", "classic", "statement", "boho". */
  style: string;
  stone?: string;
  /** Required for earrings. */
  earring_shape?: EarringShape;
  /** Required for necklaces. */
  necklace_style?: NecklaceStyle;
  necklace_length_in?: number;
  /** Watches/unisex pieces for gifts to men. */
  gender_presentation?: "feminine" | "masculine" | "unisex";
  occasions: Occasion[];
  vto_spec_ok: boolean;
  /** Path under public/catalog/ of the spec-compliant try-on image. */
  vto_image: string;
  /**
   * Store-URL preview pieces only (A16): false when the store's photo can't be used for YouCam try-on
   * (server/ingest/tryon-eligibility.ts). The piece stays in the gift as hearts-only and is scored without
   * undertone or face-shape factors. Absent = try-on capable (the Aurum catalog).
   */
  tryon_eligible?: boolean;
}

/**
 * A metal variant of a design (ADR-032). Shoppers pick the design first, then the metal; each
 * variant has its own price and images. Only metals the store actually sells.
 */
export interface MetalVariant {
  /** Stable id, unique in the catalog (e.g. "<skuId>:<metal>"). */
  variantId: string;
  metal: Metal;
  metal_tone: MetalTone;
  price: number;
  images: string[];
  /** Spec-compliant try-on image for this metal (api_matrix.md §9). */
  vto_image: string;
  vto_spec_ok: boolean;
  /** Real material shown to shoppers, e.g. "14k yellow gold", "925 sterling silver" (A2). */
  material?: string;
  price_band?: string;
  /** "photo" | "vector" | "photo-edit": how the image was made (licensing, A2). */
  image_source?: string;
  /** Vector render kept as a try-on fallback. */
  vto_image_fallback?: string;
}

/** A catalog row as A3/A4/A6 consume it (seeded by A2, ingested by A10). */
export interface CatalogSku {
  id: string;
  storeId: string;
  title: string;
  category: JewelryCategory;
  price: number;
  currency: string;
  images: string[];
  attributes: GiftFitAttributes;
  sourceUrl?: string;
  /**
   * Metal variants of this design (ADR-032). A2 fills it for every SKU (length ≥ 1); the
   * top-level price / attributes.metal / images describe variants[0], the default listing.
   */
  variants?: MetalVariant[];
}

/** Raw colors from Facial Color Tones (hex only; the API returns no undertone). */
export interface FacialColors {
  skin_color: string;
  lip_color?: string;
  eyebrow_color?: string;
  eye_color?: string;
  hair_color?: string;
}

export interface UndertoneEstimate {
  undertone: Undertone;
  /** 0..1; low confidence should push the UI to ask for an override. */
  confidence: number;
  /** CIELAB of skin_color, for audits only — never sent to the giver. */
  lab: { L: number; a: number; b: number };
  /** Hue angle in degrees, used by the documented thresholds. */
  hueDeg: number;
}

export interface RuleScore {
  strength: RuleStrength;
  /** Numeric weight from jewelry_rules.md. */
  weight: number;
  /** Source ids from jewelry_rules.md; `single_source` rows are flagged. */
  sources: string[];
  singleSource: boolean;
}

/** Implemented by A10 in server/verticals/jewelry.ts as `export const jewelryRules: JewelryRules`. */
export interface JewelryRules {
  estimateUndertone(colors: FacialColors): UndertoneEstimate;
  metalFit(metal: Metal, undertone: Undertone): RuleScore;
  styleFit(attributes: GiftFitAttributes, faceShape: FaceShape): RuleScore;
}

/**
 * What the Fit Engine knows about the recipient. Numbers and labels only: no images, no hex values.
 * Stored in recipient_profiles; never returned on a giver route (A5 enforces).
 */
export interface RecipientProfile {
  undertoneEstimate: Undertone;
  undertoneConfidence: number;
  /** Recipient's own correction, which wins over the estimate. */
  undertoneOverride?: Undertone;
  faceShape: FaceShape;
  /** SKU (design) ids the recipient hearted. Dominant weight in fitScore. */
  heartedSkuIds: string[];
  /** Variant ids the recipient hearted (ADR-032); a hearted variant implies its design is hearted. */
  heartedVariantIds?: string[];
  /** Designs where the recipient tapped "Love the style, wish it came in another metal". */
  wishOtherMetalSkuIds?: string[];
}

export interface FitRequestInput {
  occasion: Occasion;
  /** Optional floor (legacy, ADR-032); only scored as a soft preference. The cap is what limits eligible variants. */
  budgetMin?: number;
  /** Budget cap: only variants priced ≤ budgetMax are ever shown to the recipient (ADR-032). */
  budgetMax: number;
  currency: string;
  /** 1–4 designs (SKU ids) the giver picked. */
  shortlistIds: string[];
  /** Optional metal lock, e.g. ["yellow_gold", "rose_gold"] for "gold only". */
  metalLock?: Metal[];
}

export interface FitBreakdown {
  hearts: number;
  /**
   * Absent when the factor was not used: a request without a try-on (store-URL previews, or the
   * recipient never took a photo) has no undertone or face-shape estimate, so only hearts and
   * budget/occasion are scored (server/fit/WEIGHTS.md "Without a try-on").
   */
  metal?: number;
  style?: number;
  budgetOccasion: number;
}

/** Giver-facing result per SKU: scores and short reasons only. */
export interface FitResult {
  skuId: string;
  /** The variant this result is about (the hearted one, else the best-scoring eligible one). */
  variantId?: string;
  metal?: Metal;
  /** Price of that variant. */
  price?: number;
  /** The recipient asked for this design in another metal. */
  wishOtherMetal?: boolean;
  /**
   * A16: false for a piece in a MIXED report that was not tried on (its store photo can't be used for try-on):
   * scored like a request without a try-on (hearts + budget/occasion, FIT_WEIGHTS_NO_TRYON), with no undertone
   * or face-shape claim. Absent on tried pieces and on reports where nothing was tried (report-level tryOn false).
   */
  tryOn?: false;
  score: number;
  breakdown: FitBreakdown;
  reasons: string[];
  caution?: string;
}

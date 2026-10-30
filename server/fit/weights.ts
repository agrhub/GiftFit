/**
 * Published Fit Score weights (MASTER_PLAN v2 G6, §3.2b). Human-readable version: server/fit/WEIGHTS.md.
 * Any change here must bump FIT_WEIGHTS_VERSION and update WEIGHTS.md and the golden tests.
 *
 * fit-v1.1 (ADR-031/032): scores are per metal variant; hearts attach to a variant and weigh 60;
 * the camera-based undertone factor drops to 10 (it reads "neutral, low confidence" on real faces).
 */
export const FIT_WEIGHTS_VERSION = "fit-v1.1";

export const FIT_WEIGHTS = {
  /** Points for the recipient's own hearts (per variant). The dominant weight: more than the rest combined. */
  hearts: 60,
  /** Points for metal ↔ undertone (jewelry_rules.md Table 1), shrunk by undertone confidence. Low weight (ADR-031). */
  metal: 10,
  /** Points for style ↔ face shape (jewelry_rules.md Tables 2a/2b). */
  style: 15,
  /** Points for budget and occasion fit. */
  budgetOccasion: 15,
} as const;

export const FIT_PARAMS = {
  /** Share of budgetOccasion points that come from budget (the rest from occasion). */
  budgetShare: 0.6,
  /** Price outside the budget loses all budget credit at this relative distance (25%). */
  budgetFalloff: 0.25,
  /** Occasion credit when the SKU is not tagged with the requested occasion. */
  occasionMissCredit: 0.4,
  /** Heart credit for another metal of a design whose other variant was hearted. */
  otherMetalHeartFactor: 0.6,
  /** Heart credit for "love the style, wish it came in another metal" (no variant hearted). */
  wishOtherMetalFactor: 0.5,
  /** Heart credit for a SKU that was not hearted but resembles a hearted SKU (× similarity). */
  similarHeartFactor: 0.4,
  /** Minimum similarity before a hearted look-alike earns any credit. */
  similarHeartMin: 0.5,
  /** Undertone confidence below this is called out to the giver as "low confidence". */
  lowConfidence: 0.5,
} as const;

/**
 * Without a try-on (store-URL previews, or the recipient never took a photo) there is no undertone and
 * no face shape: the metal and style factors are dropped, not defaulted, and hearts + budget/occasion
 * are renormalised to 100 in their published ratio (60 : 15 → 80 : 20).
 */
export const FIT_WEIGHTS_NO_TRYON = {
  hearts: 80,
  budgetOccasion: 20,
} as const;

/** Sum of all weights; the score is clamped to [0, FIT_MAX]. */
export const FIT_MAX = FIT_WEIGHTS.hearts + FIT_WEIGHTS.metal + FIT_WEIGHTS.style + FIT_WEIGHTS.budgetOccasion;

/** Plain-English formula, served by GET /api/fit/weights and mirrored in WEIGHTS.md. */
export const FIT_FORMULA = [
  "Each design is scored per eligible metal variant (price ≤ budget cap, inside the metal lock); the report shows the hearted variant, else the best-scoring one",
  "score = round(hearts + metal + style + budgetOccasion), clamped to 0..100",
  "hearts = 60 × h; h = 1 for a hearted variant (or a hearted design with no variant recorded), 0.6 for another metal of a design with a hearted variant, 0.5 if they wished the design came in another metal, else 0.4 × similarity to their most similar hearted piece in the same category (if ≥ 0.5), else 0",
  "metal = 10 × (0.5 + c × (m − 0.5)); m = (rule weight + 1) / 2 for the variant's metal; c = 1 if they set their undertone themselves, else the estimate's confidence",
  "style = 15 × (rule weight + 1) / 2; no rule (unknown face shape, rings, bracelets, watches) gives the midpoint",
  "budgetOccasion = 15 × (0.6 × b + 0.4 × o); b = 1 at or under the cap (and at or above the optional floor), falling linearly to 0 at 25% outside it; o = 1 if tagged for the occasion, else 0.4",
  "Without a try-on (store previews, or no photo taken) there is no undertone or face-shape estimate: metal and style are dropped and score = round(80 × h + 20 × (0.6 × b + 0.4 × o))",
] as const;

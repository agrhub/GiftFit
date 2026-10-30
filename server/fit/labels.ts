/**
 * Giver-safe display labels. Everything here is a category word, never a measurement: no hex,
 * no CIELAB numbers, no face-attribute values, no confidence numbers (MASTER_PLAN v2 rule 1).
 */
import type {
  CatalogSku,
  EarringShape,
  FaceShape,
  JewelryCategory,
  Metal,
  NecklaceStyle,
  Occasion,
  Undertone,
} from "@/server/contracts/giftfit";

export const METAL_LABEL: Record<Metal, string> = {
  yellow_gold: "yellow gold",
  rose_gold: "rose gold",
  white_gold: "white gold",
  silver: "silver",
  platinum: "platinum",
  mixed_two_tone: "two-tone metal",
};

export const UNDERTONE_LABEL: Record<Undertone, string> = { warm: "warm", neutral: "neutral", cool: "cool" };

export const FACE_SHAPE_LABEL: Record<FaceShape, string> = {
  Oval: "oval",
  Round: "round",
  Square: "square",
  Heart: "heart-shaped",
  InvTriangle: "heart-shaped",
  Oblong: "oblong",
  Diamond: "diamond-shaped",
  Triangle: "triangle-shaped",
  Unknown: "unknown",
};

export const EARRING_SHAPE_LABEL: Record<EarringShape, string> = {
  stud_small: "small studs",
  stud_statement: "statement studs",
  hoop_round_large: "large round hoops",
  hoop_small_medium: "small hoops",
  hoop_oval_curved: "oval hoops",
  drop_long_narrow: "long drop earrings",
  drop_teardrop: "teardrop earrings",
  drop_wide_bottom: "wide drop earrings",
  chandelier: "chandelier earrings",
  chandelier_short: "short chandelier earrings",
  geometric_angular: "geometric earrings",
};

export const NECKLACE_STYLE_LABEL: Record<NecklaceStyle, string> = {
  pendant_v_y: "V-shaped pendants",
  pendant_curved: "curved pendants",
  choker: "chokers",
  choker_heavy: "heavy chokers",
  collar_bib_horizontal: "collar necklaces",
  long_vertical: "long necklaces",
  thin_chain: "thin chains",
  large_stone: "large-stone necklaces",
  geometric_angular: "geometric pendants",
};

export const CATEGORY_LABEL: Record<JewelryCategory, string> = {
  earring: "earrings",
  necklace: "necklaces",
  ring: "rings",
  bracelet: "bracelets",
  watch: "watches",
};

export const OCCASION_LABEL: Record<Occasion, string> = {
  anniversary: "an anniversary",
  birthday: "a birthday",
  wedding: "a wedding",
  holiday: "the holidays",
  graduation: "a graduation",
  thank_you: "a thank-you gift",
  just_because: "a just-because gift",
};

/** "drop earrings", "curved pendants", or the category word when no shape token exists. */
export function styleLabel(sku: CatalogSku): string {
  const a = sku.attributes;
  if (a.earring_shape) return EARRING_SHAPE_LABEL[a.earring_shape];
  if (a.necklace_style) return NECKLACE_STYLE_LABEL[a.necklace_style];
  return CATEGORY_LABEL[sku.category];
}

/** Lower-case style words plus the shape token; used for similarity (decoys and look-alike hearts). */
export function styleTokens(sku: CatalogSku): Set<string> {
  const a = sku.attributes;
  const tokens = new Set(
    String(a.style ?? "")
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter(Boolean),
  );
  const shape = a.earring_shape ?? a.necklace_style;
  if (shape) tokens.add(`shape:${shape}`);
  return tokens;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Similarity of two SKUs in [0, 1]: 0 across categories, else
 * 0.5 × Jaccard(style tokens) + 0.5 × [same metal].
 */
export function skuSimilarity(a: CatalogSku, b: CatalogSku): number {
  if (a.category !== b.category) return 0;
  const style = jaccard(styleTokens(a), styleTokens(b));
  const metal = a.attributes.metal === b.attributes.metal ? 1 : 0;
  return 0.5 * style + 0.5 * metal;
}

export function formatMoney(amount: number, currency: string): string {
  const symbol = currency === "USD" ? "$" : currency === "EUR" ? "€" : currency === "GBP" ? "£" : "";
  const n = Math.round(amount);
  return symbol ? `${symbol}${n}` : `${n} ${currency}`;
}

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

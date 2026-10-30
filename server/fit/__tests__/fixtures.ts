/**
 * Test fixtures for the Fit Engine: a fake `JewelryRules` that follows docs/research/jewelry_rules.md
 * (A10's real implementation is injected in P3) and a synthetic, seeded catalog generator.
 */
import type {
  CatalogSku,
  EarringShape,
  FaceShape,
  FitRequestInput,
  GiftFitAttributes,
  JewelryCategory,
  JewelryRules,
  Metal,
  NecklaceStyle,
  Occasion,
  RecipientProfile,
  RuleScore,
  RuleStrength,
  Undertone,
} from "@/server/contracts/giftfit";
import { seededRandom } from "../rng";

const WEIGHT: Record<RuleStrength, number> = { recommended: 1, acceptable: 0.4, avoid: -1, none: 0 };

const rule = (strength: RuleStrength, singleSource = false): RuleScore => ({
  strength,
  weight: WEIGHT[strength] * (singleSource ? 0.5 : 1),
  sources: singleSource ? ["E-single"] : ["fake-1", "fake-2"],
  singleSource,
});

// jewelry_rules.md Table 1
const METAL_UNDERTONE: Record<Metal, Record<Undertone, RuleStrength>> = {
  yellow_gold: { warm: "recommended", neutral: "recommended", cool: "acceptable" },
  rose_gold: { warm: "recommended", neutral: "recommended", cool: "acceptable" },
  white_gold: { cool: "recommended", neutral: "recommended", warm: "acceptable" },
  silver: { cool: "recommended", neutral: "recommended", warm: "acceptable" },
  platinum: { cool: "recommended", neutral: "recommended", warm: "acceptable" },
  mixed_two_tone: { neutral: "recommended", warm: "acceptable", cool: "acceptable" },
};

type EarringRow = Partial<Record<EarringShape | "*", [RuleStrength, boolean?]>>;
// jewelry_rules.md Table 2a (single_source flags carried as `true`)
const HEART: EarringRow = {
  drop_teardrop: ["recommended"],
  drop_wide_bottom: ["recommended"],
  chandelier: ["recommended"],
  hoop_small_medium: ["acceptable", true],
  stud_statement: ["avoid"],
};
const EARRING_FACE: Record<FaceShape, EarringRow> = {
  Round: {
    drop_long_narrow: ["recommended"],
    drop_teardrop: ["recommended"],
    chandelier: ["acceptable", true],
    geometric_angular: ["acceptable"],
    hoop_round_large: ["avoid"],
    stud_statement: ["avoid"],
  },
  Oval: { "*": ["recommended"], drop_long_narrow: ["avoid"] },
  Square: {
    hoop_round_large: ["recommended"],
    hoop_oval_curved: ["recommended"],
    drop_teardrop: ["recommended"],
    drop_long_narrow: ["acceptable"],
    stud_small: ["acceptable"],
    geometric_angular: ["avoid"],
  },
  Heart: HEART,
  InvTriangle: { ...HEART, stud_small: ["acceptable"], hoop_oval_curved: ["acceptable"] },
  Oblong: {
    hoop_round_large: ["recommended"],
    stud_statement: ["recommended"],
    chandelier_short: ["acceptable"],
    stud_small: ["acceptable", true],
    drop_long_narrow: ["avoid"],
  },
  Diamond: {
    stud_small: ["recommended"],
    hoop_small_medium: ["recommended"],
    drop_teardrop: ["recommended"],
    chandelier: ["acceptable", true],
    geometric_angular: ["avoid"],
    drop_long_narrow: ["avoid", true],
  },
  Triangle: { drop_long_narrow: ["acceptable", true], stud_statement: ["acceptable", true], drop_wide_bottom: ["avoid"] },
  Unknown: {},
};

// jewelry_rules.md Table 2b, simplified: style token first, then length.
function necklaceFit(style: NecklaceStyle | undefined, len: number | undefined, face: FaceShape): RuleScore {
  const L = len ?? 18;
  switch (face) {
    case "Round":
      if (L <= 16) return rule("avoid");
      if (style === "pendant_v_y" || L >= 20) return rule("recommended");
      return rule("none");
    case "Oval":
      return style === "choker" ? rule("acceptable") : rule("recommended");
    case "Square":
      if (style === "geometric_angular" || style === "large_stone" || style === "thin_chain") return rule("avoid");
      return style === "pendant_curved" ? rule("recommended") : rule("none");
    case "Heart":
    case "InvTriangle":
      if (style === "pendant_v_y" && L >= 20) return rule("avoid", true);
      if (style === "choker_heavy") return rule("acceptable");
      return L >= 16 && L <= 19 ? rule("recommended") : rule("none");
    case "Oblong":
      if (style === "long_vertical" || style === "thin_chain") return rule("avoid");
      return L <= 18 || style === "collar_bib_horizontal" ? rule("recommended") : rule("none");
    case "Diamond":
      return L <= 18 || style === "collar_bib_horizontal" ? rule("acceptable", true) : rule("none");
    case "Triangle":
      return L >= 22 || style === "pendant_v_y" || style === "thin_chain" ? rule("acceptable", true) : rule("none");
    default:
      return rule("none");
  }
}

export const fakeRules: JewelryRules = {
  estimateUndertone: () => ({ undertone: "neutral", confidence: 0.3, lab: { L: 0, a: 0, b: 0 }, hueDeg: 0 }),
  metalFit: (metal, undertone) => rule(METAL_UNDERTONE[metal][undertone]),
  styleFit: (a: GiftFitAttributes, face: FaceShape) => {
    if (face === "Unknown") return rule("none");
    if (a.category === "earring" && a.earring_shape) {
      const row = EARRING_FACE[face];
      const hit = row[a.earring_shape] ?? row["*"];
      return hit ? rule(hit[0], hit[1] ?? false) : rule("none");
    }
    if (a.category === "necklace") return necklaceFit(a.necklace_style, a.necklace_length_in, face);
    return rule("none");
  },
};

// ---------------------------------------------------------------- builders

export function sku(id: string, over: Partial<Omit<CatalogSku, "attributes">> & { attributes?: Partial<GiftFitAttributes> } = {}): CatalogSku {
  const category: JewelryCategory = over.category ?? over.attributes?.category ?? "earring";
  const attributes: GiftFitAttributes = {
    category,
    metal: "yellow_gold",
    metal_tone: "warm",
    style: "classic",
    earring_shape: category === "earring" ? "drop_teardrop" : undefined,
    necklace_style: category === "necklace" ? "pendant_curved" : undefined,
    necklace_length_in: category === "necklace" ? 18 : undefined,
    occasions: ["anniversary", "birthday"],
    vto_spec_ok: true,
    vto_image: `catalog/${id}.png`,
    ...over.attributes,
  };
  return {
    id,
    storeId: "aurum",
    title: over.title ?? `Test ${id} Piece`,
    category,
    price: over.price ?? 200,
    currency: over.currency ?? "USD",
    images: over.images ?? [`catalog/${id}.png`],
    attributes,
  };
}

export const request = (over: Partial<FitRequestInput> = {}): FitRequestInput => ({
  occasion: "anniversary",
  budgetMin: 150,
  budgetMax: 300,
  currency: "USD",
  shortlistIds: [],
  ...over,
});

export const profile = (over: Partial<RecipientProfile> = {}): RecipientProfile => ({
  undertoneEstimate: "warm",
  undertoneConfidence: 1,
  faceShape: "Oval",
  heartedSkuIds: [],
  ...over,
});

const EARRING_SHAPES: EarringShape[] = [
  "stud_small",
  "stud_statement",
  "hoop_round_large",
  "hoop_small_medium",
  "hoop_oval_curved",
  "drop_long_narrow",
  "drop_teardrop",
  "drop_wide_bottom",
  "chandelier",
  "geometric_angular",
];
const NECKLACE_STYLES: NecklaceStyle[] = ["pendant_v_y", "pendant_curved", "choker", "collar_bib_horizontal", "long_vertical", "thin_chain", "large_stone"];
const METALS: Metal[] = ["yellow_gold", "rose_gold", "white_gold", "silver", "platinum", "mixed_two_tone"];
const TONE: Record<Metal, Undertone> = {
  yellow_gold: "warm",
  rose_gold: "warm",
  white_gold: "cool",
  silver: "cool",
  platinum: "cool",
  mixed_two_tone: "neutral",
};
const STYLES = ["minimal", "classic", "statement", "boho", "vintage", "modern"];
const OCCASIONS: Occasion[] = ["anniversary", "birthday", "wedding", "holiday", "graduation", "thank_you", "just_because"];
const ADJ = ["Halo", "Aurora", "Luna", "Sol", "Ember", "Willow", "Iris", "Nova", "Coral", "Sage", "Vega", "Opal"];
const NOUN = ["Drop", "Loop", "Arc", "Bloom", "Line", "Crest", "Wave", "Knot", "Leaf", "Star"];
const CAT_NOUN: Record<JewelryCategory, string> = { earring: "Earrings", necklace: "Necklace", ring: "Ring", bracelet: "Bracelet", watch: "Watch" };
const CATEGORIES: JewelryCategory[] = ["earring", "earring", "necklace", "necklace", "ring", "bracelet", "watch"];

/** Deterministic synthetic catalog shaped like A2's Aurum catalog (titles "Adj Noun Category"). */
export function makeCatalog(n = 200, seed = "catalog"): CatalogSku[] {
  const r = seededRandom(seed);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const out: CatalogSku[] = [];
  for (let i = 0; i < n; i++) {
    const category = pick(CATEGORIES);
    const metal = pick(METALS);
    const price = Math.round(Math.exp(Math.log(60) + r() * (Math.log(900) - Math.log(60))) / 5) * 5;
    const styleWords = [pick(STYLES), ...(r() < 0.5 ? [pick(STYLES)] : [])];
    const occasions = OCCASIONS.filter(() => r() < 0.45);
    const id = `aur-${String(i + 1).padStart(3, "0")}`;
    out.push(
      sku(id, {
        title: `${pick(ADJ)} ${pick(NOUN)} ${CAT_NOUN[category]}`,
        category,
        price,
        attributes: {
          category,
          metal,
          metal_tone: TONE[metal],
          style: [...new Set(styleWords)].join(" "),
          earring_shape: category === "earring" ? pick(EARRING_SHAPES) : undefined,
          necklace_style: category === "necklace" ? pick(NECKLACE_STYLES) : undefined,
          necklace_length_in: category === "necklace" ? pick([14, 16, 18, 20, 24, 30]) : undefined,
          occasions: occasions.length ? occasions : ["just_because"],
          vto_spec_ok: r() > 0.05,
        },
      }),
    );
  }
  return out;
}

const OTHER_METALS: Record<Metal, Metal[]> = {
  yellow_gold: ["white_gold", "rose_gold"],
  rose_gold: ["yellow_gold", "white_gold"],
  white_gold: ["yellow_gold", "rose_gold"],
  silver: ["yellow_gold", "white_gold"],
  platinum: ["white_gold", "yellow_gold"],
  mixed_two_tone: ["yellow_gold", "white_gold"],
};

/** Gives `share` of the earrings and necklaces 2–3 metal variants (ADR-032), deterministically. */
export function withVariants(catalog: CatalogSku[], share = 0.15, seed = "variants"): CatalogSku[] {
  const r = seededRandom(seed);
  return catalog.map((s) => {
    if ((s.category !== "earring" && s.category !== "necklace") || r() >= share) return s;
    const base = s.attributes.metal;
    const extra = OTHER_METALS[base].slice(0, r() < 0.5 ? 1 : 2);
    const variant = (metal: Metal, price: number) => ({
      variantId: `${s.id}:${metal}`,
      metal,
      metal_tone: TONE[metal],
      price,
      images: s.images,
      vto_image: `catalog/${s.id}-${metal}.png`,
      vto_spec_ok: true,
    });
    return { ...s, variants: [variant(base, s.price), ...extra.map((m) => variant(m, Math.round((s.price * (0.9 + r() * 0.5)) / 5) * 5))] };
  });
}

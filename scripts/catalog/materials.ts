/** Price bands, metal and stone assignment rules for the Aurum catalog (all deterministic). */
import type { JewelryCategory, Metal, MetalTone } from "@/lib/contracts/giftfit";
import type { PearlTone, StoneColor } from "./svg";

export type Band = 0 | 1 | 2 | 3;

/** Price bands A3 uses for decoys (USD). Prices never sit on a boundary. */
export const PRICE_BANDS = [
  { id: "under_100", label: "< $100", min: 0, max: 100 },
  { id: "100_300", label: "$100–300", min: 100, max: 300 },
  { id: "300_800", label: "$300–800", min: 300, max: 800 },
  { id: "over_800", label: "> $800", min: 800, max: Number.POSITIVE_INFINITY },
] as const;
export type PriceBandId = (typeof PRICE_BANDS)[number]["id"];

export function priceBand(price: number): PriceBandId {
  for (const b of PRICE_BANDS) if (price >= b.min && price < b.max) return b.id;
  return "over_800";
}

const LADDERS: Record<Band, number[]> = {
  0: [39, 45, 49, 55, 59, 65, 69, 75, 79, 85, 89, 95],
  1: [119, 129, 145, 159, 175, 189, 198, 215, 229, 245, 259, 275, 289],
  2: [325, 345, 365, 389, 415, 445, 475, 495, 525, 565, 595, 645, 695, 745, 785],
  3: [850, 895, 950, 1050, 1150, 1290, 1450, 1650, 1850, 2100, 2450, 2900, 3400, 3950],
};

export const priceFor = (band: Band, h: number) => LADDERS[band][h % LADDERS[band].length];

/** Metal tone is derived from the metal (jewelry_rules.md Table 1). No exceptions in this catalog. */
export function toneOf(metal: Metal): MetalTone {
  if (metal === "yellow_gold" || metal === "rose_gold") return "warm";
  if (metal === "mixed_two_tone") return "neutral";
  return "cool";
}

/** Per-band metal rotation: every band carries warm, cool and neutral metals. */
const METALS_BY_BAND: Record<Band, Metal[]> = {
  0: ["silver", "yellow_gold", "rose_gold", "silver", "mixed_two_tone", "yellow_gold"],
  1: ["yellow_gold", "silver", "rose_gold", "white_gold", "mixed_two_tone", "yellow_gold", "silver"],
  2: ["yellow_gold", "white_gold", "rose_gold", "platinum", "silver", "mixed_two_tone"],
  3: ["yellow_gold", "platinum", "white_gold", "rose_gold", "mixed_two_tone", "yellow_gold"],
};

const WATCH_METALS_BY_BAND: Record<Band, Metal[]> = {
  0: ["silver", "yellow_gold", "mixed_two_tone", "rose_gold", "silver"],
  1: ["silver", "yellow_gold", "rose_gold", "mixed_two_tone", "silver"],
  2: ["silver", "mixed_two_tone", "yellow_gold", "rose_gold", "silver"],
  3: ["yellow_gold", "platinum", "white_gold", "rose_gold", "mixed_two_tone"],
};

export function metalFor(category: JewelryCategory, band: Band, n: number): Metal {
  const list = category === "watch" ? WATCH_METALS_BY_BAND[band] : METALS_BY_BAND[band];
  return list[n % list.length];
}

/** Human-readable material; honest about vermeil and steel, which still map to a canonical metal colour. */
export function materialFor(category: JewelryCategory, metal: Metal, band: Band): { material: string; finish: "solid" | "vermeil" | "sterling" | "steel" | "platinum" } {
  if (category === "watch" && band < 3) {
    const steel: Record<Metal, string> = {
      silver: "stainless steel",
      yellow_gold: "gold-tone stainless steel (PVD)",
      rose_gold: "rose-gold-tone stainless steel (PVD)",
      mixed_two_tone: "two-tone stainless steel",
      white_gold: "stainless steel",
      platinum: "stainless steel",
    };
    return { material: steel[metal], finish: "steel" };
  }
  const k = band === 1 ? "10k" : band === 2 ? "14k" : "18k";
  switch (metal) {
    case "silver":
      return { material: "sterling silver", finish: "sterling" };
    case "platinum":
      return { material: "950 platinum", finish: "platinum" };
    case "yellow_gold":
    case "rose_gold":
    case "white_gold": {
      const c = metal.split("_")[0];
      if (band === 0) return { material: `18k ${c} gold vermeil over sterling silver`, finish: "vermeil" };
      return { material: `${k} ${c} gold`, finish: "solid" };
    }
    case "mixed_two_tone":
      if (band === 0) return { material: "sterling silver with 18k gold vermeil accents", finish: "vermeil" };
      return { material: `${k} yellow and white gold`, finish: "solid" };
  }
}

export type Slot = "none" | "gem" | "pearl" | "pave" | "gem_pave";

export interface StoneInfo {
  color?: StoneColor;
  pearl?: PearlTone;
  label: string;
}

export const STONES: Record<string, StoneInfo> = {
  none: { label: "no stone" },
  diamond: { color: "clear", label: "diamond" },
  lab_grown_diamond: { color: "clear", label: "lab-grown diamond" },
  moissanite: { color: "clear", label: "moissanite" },
  white_topaz: { color: "clear", label: "white topaz" },
  cubic_zirconia: { color: "clear", label: "cubic zirconia" },
  crystal: { color: "clear", label: "glass crystal" },
  sapphire: { color: "blue", label: "sapphire" },
  emerald: { color: "green", label: "emerald" },
  ruby: { color: "red", label: "ruby" },
  amethyst: { color: "purple", label: "amethyst" },
  blue_topaz: { color: "sky", label: "blue topaz" },
  citrine: { color: "yellow", label: "citrine" },
  garnet: { color: "garnet", label: "garnet" },
  morganite: { color: "peach", label: "morganite" },
  pink_tourmaline: { color: "pink", label: "pink tourmaline" },
  aquamarine: { color: "aqua", label: "aquamarine" },
  peridot: { color: "lime", label: "peridot" },
  opal: { color: "opal", label: "opal" },
  onyx: { color: "black", label: "black onyx" },
  freshwater_pearl: { pearl: "cream", label: "freshwater pearl" },
  akoya_pearl: { pearl: "white", label: "Akoya pearl" },
  south_sea_pearl: { pearl: "cream", label: "South Sea pearl" },
  tahitian_pearl: { pearl: "dark", label: "Tahitian pearl" },
};

const GEMS: Record<Band, string[]> = {
  0: ["cubic_zirconia", "amethyst", "crystal", "garnet", "cubic_zirconia", "onyx"],
  1: ["white_topaz", "blue_topaz", "amethyst", "lab_grown_diamond", "citrine", "garnet", "moissanite", "peridot"],
  2: ["diamond", "sapphire", "morganite", "emerald", "lab_grown_diamond", "opal", "pink_tourmaline", "aquamarine"],
  3: ["diamond", "sapphire", "emerald", "ruby", "diamond", "aquamarine"],
};
const PEARLS: Record<Band, string[]> = {
  0: ["freshwater_pearl"],
  1: ["freshwater_pearl", "freshwater_pearl", "akoya_pearl"],
  2: ["akoya_pearl", "freshwater_pearl", "tahitian_pearl"],
  3: ["south_sea_pearl", "tahitian_pearl", "akoya_pearl"],
};
const PAVE: Record<Band, string> = { 0: "cubic_zirconia", 1: "white_topaz", 2: "diamond", 3: "diamond" };
/** Masculine pieces with a gem slot draw from a restrained set. */
const MASC_GEMS = ["onyx", "sapphire", "onyx", "diamond"];

export function stoneFor(slot: Slot, band: Band, n: number, masculine = false): { main: string; pave?: string } {
  switch (slot) {
    case "none":
      return { main: "none" };
    case "pave":
      return { main: PAVE[band], pave: PAVE[band] };
    case "pearl":
      return { main: PEARLS[band][n % PEARLS[band].length] };
    case "gem":
    case "gem_pave": {
      let main = masculine ? MASC_GEMS[n % MASC_GEMS.length] : GEMS[band][n % GEMS[band].length];
      if (masculine && band < 2 && (main === "diamond" || main === "sapphire")) main = "onyx";
      return { main, pave: slot === "gem_pave" ? PAVE[band] : undefined };
    }
  }
}

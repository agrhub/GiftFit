/** Ring, bracelet and watch design tables (invented names; no real brands or watch model names). */
import type { Design } from "./design";
import type { Entry, Gender } from "./entries-face";
import type { Slot } from "./materials";

const r = (variant: string, name: string, noun: string, slot: Slot, style: string, gender: Gender = "feminine"): Entry => ({ variant, name, noun, slot, style, gender });

export const RINGS: Entry[] = [
  r("solitaire", "Promise", "Solitaire Ring", "gem", "classic"),
  r("solitaire", "Clarity", "Solitaire Ring", "gem", "minimal"),
  r("solitaire", "Beacon", "Raised Solitaire", "gem", "classic"),
  r("halo", "Aureole", "Cushion Halo Ring", "gem_pave", "classic"),
  r("halo", "Radiance", "Halo Ring", "gem_pave", "statement"),
  r("three_stone", "Trilogy", "Three-Stone Ring", "gem_pave", "classic"),
  r("three_stone", "Past Present", "Three-Stone Ring", "gem_pave", "vintage"),
  r("band_plain", "Comfort", "Polished Band", "none", "minimal", "unisex"),
  r("band_plain", "Duo", "Two-Tone Band", "none", "classic", "unisex"),
  r("band_plain", "Everly", "Classic Band", "none", "classic", "unisex"),
  r("band_wide", "Forge", "Brushed Wide Band", "none", "modern", "masculine"),
  r("band_wide", "Summit", "Wide Band", "none", "classic", "masculine"),
  r("eternity", "Infinity Line", "Eternity Band", "pave", "classic"),
  r("eternity", "Rainbow Row", "Gemstone Eternity Band", "gem_pave", "statement"),
  r("signet", "Heritage", "Oval Signet Ring", "none", "classic", "masculine"),
  { ...r("signet", "Monarch", "Onyx Signet Ring", "gem", "classic", "masculine"), stone: "onyx" },
  r("signet", "Crest", "Petite Signet Ring", "none", "vintage", "unisex"),
  r("cocktail", "Soirée", "Cocktail Ring", "gem_pave", "statement"),
  r("cocktail", "Gala", "Oval Cocktail Ring", "gem_pave", "statement"),
  r("cocktail", "Duchess", "Halo Cocktail Ring", "gem_pave", "vintage"),
  r("pearl_ring", "Tide", "Pearl Ring", "pearl", "classic"),
  r("pearl_ring", "Moonlit", "Pearl Solitaire Ring", "pearl", "minimal"),
  r("bypass", "Embrace", "Bypass Ring", "gem", "boho"),
  r("bypass", "Open Sky", "Open Ring", "gem", "boho", "unisex"),
  r("stack_thin", "Whisper", "Stacking Ring", "gem", "minimal"),
  r("stack_thin", "Spark", "Stacking Ring", "gem", "minimal"),
];

export const BRACELETS: Entry[] = [
  r("tennis", "Riviera", "Tennis Bracelet", "pave", "classic"),
  r("tennis", "Starlight", "Tennis Bracelet", "pave", "statement"),
  r("tennis", "Prism Line", "Gemstone Tennis Bracelet", "gem", "statement"),
  r("bangle", "Halcyon", "Polished Bangle", "none", "minimal"),
  r("bangle", "Sol", "Slim Bangle", "none", "minimal", "unisex"),
  r("bangle_pave", "Lumière", "Pavé Bangle", "pave", "classic"),
  r("bangle_station", "Keystone", "Gem Station Bangle", "gem", "classic"),
  r("cuff", "Atlas", "Open Cuff", "none", "modern", "unisex"),
  r("cuff_gem", "Oasis", "Gem Cuff", "gem", "boho"),
  r("cuff_hammered", "Terra", "Hammered Cuff", "none", "boho", "unisex"),
  r("curb", "Harbor", "Curb Chain Bracelet", "none", "classic", "unisex"),
  r("curb_heavy", "Ironwood", "Heavy Curb Bracelet", "none", "statement", "masculine"),
  r("curb_heavy", "Granite", "Bold Curb Bracelet", "none", "modern", "masculine"),
  r("paperclip", "Linkline", "Paperclip Bracelet", "none", "modern"),
  r("paperclip", "Office Hours", "Paperclip Chain Bracelet", "none", "minimal", "unisex"),
  r("beaded", "Mantra", "Beaded Bracelet", "gem", "boho", "unisex"),
  r("beaded", "Pebble Path", "Bead Bracelet", "none", "boho", "unisex"),
  r("pearl_strand", "Shoreline", "Pearl Bracelet", "pearl", "classic"),
  r("station", "Glimmer", "Station Bracelet", "gem", "minimal"),
  r("station", "Trace", "Gem Station Chain Bracelet", "gem", "minimal"),
  r("rope", "Mariner", "Rope Chain Bracelet", "none", "classic", "masculine"),
  r("box_link", "Steelhead", "Box Link Bracelet", "none", "modern", "masculine"),
];

export interface WatchEntry extends Entry {
  strap: NonNullable<Design["strap"]>;
  dial: string;
  dialName: string;
}

const w = (variant: string, name: string, noun: string, style: string, gender: Gender, strap: WatchEntry["strap"], dial: string, dialName: string, slot: Slot = "none"): WatchEntry => ({
  variant,
  name,
  noun,
  slot,
  style,
  gender,
  strap,
  dial,
  dialName,
});

const IVORY = "#F3EFE6";
const NAVY = "#1D2A44";
const FOREST = "#163D30";
const BLACK = "#1C1D20";
const SLATE = "#4A5560";
const BLUSH = "#F3DED8";
const SILVERD = "#D9DCE0";
const GREEN = "#2F4A3A";

export const WATCHES: WatchEntry[] = [
  w("dress_round", "Ellery", "Dress Watch 38", "classic", "masculine", "leather_brown", IVORY, "ivory"),
  w("dress_round", "Ashford", "Dress Watch 40", "classic", "masculine", "leather_black", SILVERD, "silver"),
  w("dress_round", "Clement", "Small-Seconds Watch", "vintage", "unisex", "leather_tan", IVORY, "ivory"),
  w("minimal_round", "Nordlys", "Minimal Watch 39", "minimal", "unisex", "mesh", NAVY, "navy"),
  w("minimal_round", "Kestrel", "Minimal Watch 36", "minimal", "unisex", "leather_black", IVORY, "ivory"),
  w("minimal_round", "Fjord", "Mesh Watch 34", "minimal", "feminine", "mesh", BLUSH, "blush"),
  w("diver", "Deepwater", "Diver 42", "sport", "masculine", "link", BLACK, "black"),
  w("diver", "Reefline", "Diver 40", "sport", "masculine", "rubber", NAVY, "navy"),
  w("diver", "Kelp", "Diver 40", "sport", "masculine", "link", FOREST, "forest green"),
  w("chrono", "Paddock", "Chronograph 42", "sport", "masculine", "leather_brown", SILVERD, "silver"),
  w("chrono", "Velo", "Chronograph 41", "sport", "masculine", "link", BLACK, "black"),
  w("chrono", "Slipstream", "Chronograph 40", "sport", "unisex", "leather_black", NAVY, "navy"),
  w("field", "Trailhead", "Field Watch 38", "classic", "masculine", "canvas", BLACK, "black"),
  w("field", "Outpost", "Field Watch 36", "classic", "unisex", "leather_green", IVORY, "ivory"),
  w("square_case", "Plaza", "Square Watch", "modern", "masculine", "leather_brown", NAVY, "navy"),
  w("square_case", "Atrium", "Square Watch", "modern", "unisex", "mesh", SLATE, "slate"),
  w("rect_case", "Gallery", "Rectangular Watch", "classic", "feminine", "leather_black", IVORY, "ivory"),
  w("rect_case", "Mezzanine", "Rectangular Watch", "vintage", "feminine", "leather_tan", GREEN, "green"),
  w("tonneau", "Barrel", "Tonneau Watch", "modern", "masculine", "link", BLACK, "black"),
  w("tonneau", "Cask", "Tonneau Watch", "vintage", "unisex", "leather_brown", SILVERD, "silver"),
  w("petite_round", "Posy", "Petite Watch 28", "minimal", "feminine", "leather_black", BLUSH, "blush"),
  w("petite_round", "Wren", "Petite Watch 28", "classic", "feminine", "mesh", IVORY, "ivory"),
  w("petite_pave", "Sparrow", "Pavé Bezel Watch 30", "statement", "feminine", "link", IVORY, "ivory", "pave"),
  w("petite_pave", "Nightjar", "Pavé Bezel Watch 30", "statement", "feminine", "leather_black", NAVY, "navy", "pave"),
];

/** Earring and necklace design tables (invented names; no real brands, designers or model names). */
import type { EarringShape, Metal, NecklaceStyle, Occasion } from "@/lib/contracts/giftfit";
import type { Band, Slot } from "./materials";

export type Gender = "feminine" | "masculine" | "unisex";

export interface Entry {
  variant: string;
  name: string;
  noun: string;
  slot: Slot;
  style: string;
  gender: Gender;
  earringShape?: EarringShape;
  necklaceStyle?: NecklaceStyle;
  lengthIn?: number;
  /** Optional overrides (used sparingly, e.g. the demo's "Halo Drop"). */
  band?: Band;
  metal?: Metal;
  stone?: string;
  price?: number;
  occasions?: Occasion[];
  /** Product copy override, used where a photo shows details the template copy does not (ADR-018). */
  description?: string;
}

const e = (earringShape: EarringShape, variant: string, name: string, noun: string, slot: Slot, style: string, gender: Gender = "feminine", o: Partial<Entry> = {}): Entry => ({
  earringShape,
  variant,
  name,
  noun,
  slot,
  style,
  gender,
  ...o,
});

export const EARRINGS: Entry[] = [
  e("stud_small", "stud_prong", "Aster", "Solitaire Studs", "gem", "classic", "unisex"),
  e("stud_small", "stud_bezel", "Dot", "Bezel Studs", "gem", "minimal", "unisex"),
  e("stud_small", "stud_dome", "Pebble", "Dome Studs", "none", "minimal", "unisex"),
  e("stud_small", "stud_pearl", "Tide", "Pearl Studs", "pearl", "classic"),
  e("stud_small", "stud_flower", "Petal", "Mini Flower Studs", "gem_pave", "minimal"),
  e("stud_statement", "statement_cluster", "Bloom", "Cluster Studs", "gem_pave", "statement"),
  e("stud_statement", "statement_button", "Sunburst", "Button Earrings", "none", "statement"),
  e("stud_statement", "statement_halo", "Gala", "Halo Studs", "gem_pave", "classic"),
  e("stud_statement", "statement_bar", "Horizon", "Bar Studs", "pave", "modern", "unisex"),
  e("hoop_round_large", "hoop_plain_large", "Orbit", "Large Hoops", "none", "classic"),
  e("hoop_round_large", "hoop_twisted", "Coil", "Twisted Hoops", "none", "boho"),
  e("hoop_round_large", "hoop_pave_large", "Celeste", "Pavé Hoops", "pave", "statement"),
  e("hoop_round_large", "hoop_hammered", "Ripple", "Hammered Hoops", "none", "boho"),
  e("hoop_small_medium", "huggie", "Kindred", "Huggie Hoops", "none", "minimal", "unisex"),
  e("hoop_small_medium", "huggie_pave", "Lumen", "Pavé Huggies", "pave", "classic"),
  e("hoop_small_medium", "huggie_charm", "Charmed", "Gem Charm Huggies", "gem", "boho"),
  e("hoop_small_medium", "huggie_pearl", "Brook", "Pearl Huggies", "pearl", "classic"),
  e("hoop_small_medium", "hoop_thin", "Arc", "Mini Hoops", "none", "minimal", "unisex"),
  e("hoop_oval_curved", "oval_hoop", "Ellipse", "Oval Hoops", "none", "modern"),
  e("hoop_oval_curved", "wave_hoop", "Current", "Curved Hoops", "none", "modern"),
  e("hoop_oval_curved", "oval_pave", "Vesper", "Pavé Oval Hoops", "pave", "classic"),
  e("hoop_oval_curved", "crescent", "Crescent", "Moon Hoops", "none", "boho"),
  e("drop_long_narrow", "bar_drop", "Linea", "Bar Drop Earrings", "none", "minimal"),
  e("drop_long_narrow", "chain_drop", "Comet", "Chain Drop Earrings", "gem", "minimal"),
  e("drop_long_narrow", "linear_bezels", "Cascade", "Linear Drop Earrings", "gem_pave", "statement"),
  e("drop_long_narrow", "threader", "Willow", "Threader Earrings", "pave", "minimal"),
  e("drop_long_narrow", "pearl_drop", "Rain", "Pearl Drop Earrings", "pearl", "classic"),
  e("drop_teardrop", "halo_drop", "Halo", "Drop Earrings", "gem_pave", "classic", "feminine", { band: 1, metal: "yellow_gold", stone: "lab_grown_diamond", price: 245, occasions: ["anniversary", "wedding", "birthday", "holiday"] }),
  e("drop_teardrop", "dew_bezel", "Dewdrop", "Bezel Earrings", "gem", "minimal"),
  e("drop_teardrop", "teardrop_outline", "Opaline", "Teardrop Earrings", "none", "modern"),
  e("drop_teardrop", "pearl_teardrop", "Mira", "Pearl Teardrops", "pearl", "classic"),
  e("drop_teardrop", "pear_big", "Marlowe", "Pear Drop Earrings", "gem_pave", "statement"),
  e("drop_wide_bottom", "fan", "Delta", "Fan Drop Earrings", "none", "boho"),
  // ADR-018 photo adjustment: the photo shows an openwork filigree bell with a pavé rim
  // default metal is yellow gold (A3 demo-leak fix): rose gold and white gold are variants (scripts/catalog/variants.ts)
  e("drop_wide_bottom", "bell", "Chime", "Bell Drop Earrings", "gem", "vintage", "feminine", {
    metal: "yellow_gold",
    description: "A vintage pair of openwork filigree bell drop earrings in 10k yellow gold with a lab-grown diamond pavé rim. Sold as a pair; shown as a single earring.",
  }),
  e("drop_wide_bottom", "tassel", "Fringe Fall", "Tassel Earrings", "none", "boho"),
  e("drop_wide_bottom", "triangle_pave", "Gleam", "Triangle Drop Earrings", "pave", "statement"),
  e("chandelier", "chandelier_gems", "Aurora", "Chandelier Earrings", "gem_pave", "statement"),
  e("chandelier", "chandelier_pearl", "Jubilee", "Pearl Chandeliers", "pearl", "vintage"),
  e("chandelier", "chandelier_filigree", "Fern", "Filigree Chandeliers", "none", "boho"),
  e("chandelier", "chandelier_classic", "Solstice", "Marquise Chandeliers", "gem_pave", "classic"),
  e("chandelier_short", "short_chandelier_gems", "Fable", "Short Chandelier Earrings", "gem_pave", "statement"),
  // ADR-018 photo adjustment: the photo is a long fringe (tall, tapering), so `chandelier`, not `chandelier_short`
  e("chandelier", "fringe", "Cove", "Fringe Earrings", "none", "boho", "feminine", {
    description: "A boho pair of long fringe earrings in 10k yellow gold: a polished half-moon top with a fan of fine beaded chains. Sold as a pair; shown as a single earring.",
  }),
  e("chandelier_short", "fan_chandelier", "Lyra", "Fan Chandeliers", "gem_pave", "vintage"),
  e("chandelier_short", "short_pearl", "Petite Bloom", "Pearl Chandeliers", "pearl", "classic"),
  e("geometric_angular", "geo_square_stud", "Quadra", "Square Studs", "gem", "modern", "unisex"),
  e("geometric_angular", "hex_drop", "Prism", "Hexagon Drops", "none", "modern", "unisex"),
  e("geometric_angular", "stacked_squares", "Facet", "Stacked Square Drops", "none", "modern"),
  e("geometric_angular", "kite", "Vertex", "Kite Drop Earrings", "gem", "modern"),
];

const n = (necklaceStyle: NecklaceStyle, lengthIn: number, variant: string, name: string, noun: string, slot: Slot, style: string, gender: Gender = "feminine"): Entry => ({
  necklaceStyle,
  lengthIn,
  variant,
  name,
  noun,
  slot,
  style,
  gender,
});

export const NECKLACES: Entry[] = [
  n("pendant_v_y", 20, "lariat_y", "Lariat", "Y Necklace", "gem", "minimal"),
  n("pendant_v_y", 18, "vee_bar", "Chevron", "V Bar Necklace", "none", "modern"),
  n("pendant_v_y", 22, "y_pearl", "Aria", "Pearl Y Necklace", "pearl", "classic"),
  n("pendant_v_y", 24, "plume_lariat", "Plume", "Lariat Necklace", "none", "boho"),
  n("pendant_v_y", 28, "vee_gem", "Tamsin", "Marquise V Pendant", "gem", "statement"),
  n("pendant_curved", 18, "disc", "Luna", "Disc Pendant", "none", "minimal", "unisex"),
  n("pendant_curved", 20, "locket", "Keepsake", "Oval Locket", "none", "vintage"),
  n("pendant_curved", 16, "halo_circle", "Eternal Circle", "Halo Pendant", "gem_pave", "classic"),
  // ADR-018 photo adjustment (v2 photo): the pendant is an upturned "horn" crescent
  {
    ...n("pendant_curved", 18, "crescent_moon", "Nightfall", "Crescent Pendant", "none", "boho"),
    description: "A boho upturned crescent (horn) pendant in polished 10k rose gold on a fine cable chain, 18 in long.",
  },
  n("pendant_curved", 22, "pearl_orb", "Orb", "Pearl Pendant", "pearl", "classic"),
  n("choker", 14, "ribbon_choker", "Ribbon", "Collar Choker", "none", "modern"),
  n("choker", 15, "pearl_choker", "Isle", "Pearl Choker", "pearl", "classic"),
  n("choker", 16, "bead_choker", "Seed", "Bead Choker", "none", "boho"),
  n("choker", 15, "gem_choker", "Glint", "Solitaire Choker", "gem", "minimal"),
  n("choker_heavy", 15, "torque", "Torque", "Rigid Collar", "none", "statement"),
  n("choker_heavy", 16, "chunky_curb", "Anchor", "Chunky Curb Choker", "none", "statement", "unisex"),
  n("choker_heavy", 14, "pave_choker", "Regal", "Pavé Choker", "pave", "statement"),
  n("choker_heavy", 16, "herringbone", "Silk", "Herringbone Choker", "none", "classic"),
  n("collar_bib_horizontal", 17, "leaf_bib", "Laurel", "Leaf Bib Necklace", "none", "statement"),
  n("collar_bib_horizontal", 16, "layered_trio", "Trio", "Layered Necklace", "none", "boho"),
  n("collar_bib_horizontal", 18, "starlit_bib", "Starlit", "Bib Collar", "gem_pave", "statement"),
  n("collar_bib_horizontal", 16, "bar_collar", "Horizon", "Bar Collar Necklace", "none", "minimal"),
  n("long_vertical", 30, "tassel_long", "Tassel", "Long Necklace", "none", "boho"),
  n("long_vertical", 28, "long_bar", "Drift", "Long Bar Necklace", "none", "minimal", "unisex"),
  n("long_vertical", 32, "pearl_rope", "Opera", "Pearl Rope", "pearl", "vintage"),
  n("long_vertical", 30, "medal", "Compass", "Medallion Necklace", "none", "classic", "unisex"),
  n("long_vertical", 34, "station_long", "Starline", "Long Station Chain", "gem", "boho"),
  n("thin_chain", 16, "fine_chain", "Whisper", "Fine Cable Chain", "none", "minimal"),
  n("thin_chain", 18, "bead_chain", "Solo", "Bead Chain", "none", "minimal"),
  n("thin_chain", 18, "station_fine", "Glimmer", "Station Necklace", "gem", "minimal"),
  n("thin_chain", 20, "rope_chain", "Twine", "Rope Chain", "none", "classic", "unisex"),
  n("thin_chain", 22, "curb_chain", "Everyday", "Curb Chain", "none", "classic", "masculine"),
  n("thin_chain", 24, "box_chain", "Strand", "Box Chain", "none", "minimal", "unisex"),
  n("large_stone", 18, "grand_oval", "Grand", "Oval Gem Pendant", "gem", "statement"),
  n("large_stone", 20, "regent_halo", "Regent", "Halo Pendant", "gem_pave", "statement"),
  n("large_stone", 18, "step_cut", "Gallery", "Step-Cut Pendant", "gem", "classic"),
  n("large_stone", 22, "statement_pear", "Reverie", "Pear Pendant", "gem", "statement"),
  n("geometric_angular", 18, "square_pendant", "Quadra", "Square Pendant", "gem", "modern"),
  n("geometric_angular", 20, "triangle_pendant", "Apex", "Triangle Pendant", "none", "modern", "unisex"),
  n("geometric_angular", 22, "hex_pendant", "Hive", "Hexagon Pendant", "none", "modern", "unisex"),
  n("geometric_angular", 24, "kite_bar", "Kite", "Bar Pendant", "none", "modern"),
];

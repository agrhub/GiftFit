import type { JewelryCategory } from "@/lib/contracts/giftfit";
import type { Design, RenderOut } from "../design";
import { renderEarring } from "./earring";
import { renderNecklace } from "./necklace";
import { renderRing } from "./ring";
import { renderBracelet } from "./bracelet";
import { renderWatch, WATCH_VARIANTS } from "./watch";

export const VARIANTS: Record<JewelryCategory, string[]> = {
  earring: [
    "stud_prong", "stud_bezel", "stud_dome", "stud_pearl", "stud_flower",
    "statement_cluster", "statement_button", "statement_halo", "statement_bar",
    "hoop_plain_large", "hoop_twisted", "hoop_pave_large", "hoop_hammered",
    "huggie", "huggie_pave", "huggie_charm", "huggie_pearl", "hoop_thin",
    "oval_hoop", "oval_pave", "wave_hoop", "crescent",
    "bar_drop", "chain_drop", "linear_bezels", "threader", "pearl_drop",
    "halo_drop", "dew_bezel", "teardrop_outline", "pearl_teardrop", "pear_big",
    "fan", "bell", "tassel", "triangle_pave",
    "chandelier_gems", "chandelier_pearl", "chandelier_filigree", "chandelier_classic",
    "short_chandelier_gems", "short_pearl", "fringe", "fan_chandelier",
    "geo_square_stud", "hex_drop", "stacked_squares", "kite",
  ],
  necklace: [
    "lariat_y", "vee_bar", "y_pearl", "plume_lariat", "vee_gem",
    "disc", "locket", "halo_circle", "crescent_moon", "pearl_orb",
    "ribbon_choker", "pearl_choker", "bead_choker", "gem_choker",
    "torque", "chunky_curb", "pave_choker", "herringbone",
    "leaf_bib", "layered_trio", "starlit_bib", "bar_collar",
    "tassel_long", "long_bar", "pearl_rope", "medal", "station_long",
    "fine_chain", "bead_chain", "station_fine", "rope_chain", "curb_chain", "box_chain",
    "grand_oval", "regent_halo", "step_cut", "statement_pear",
    "square_pendant", "triangle_pendant", "hex_pendant", "kite_bar",
  ],
  ring: ["solitaire", "halo", "three_stone", "band_plain", "band_wide", "eternity", "signet", "cocktail", "pearl_ring", "bypass", "stack_thin"],
  bracelet: [
    "tennis", "bangle", "bangle_pave", "bangle_station", "cuff", "cuff_gem", "cuff_hammered",
    "curb", "curb_heavy", "paperclip", "beaded", "pearl_strand", "station", "rope", "box_link",
  ],
  watch: WATCH_VARIANTS,
};

export function renderDesign(d: Design): RenderOut {
  switch (d.category) {
    case "earring":
      return renderEarring(d);
    case "necklace":
      return renderNecklace(d);
    case "ring":
      return renderRing(d);
    case "bracelet":
      return renderBracelet(d);
    case "watch":
      return renderWatch(d);
    default:
      throw new Error(`no renderer for ${d.category}`);
  }
}

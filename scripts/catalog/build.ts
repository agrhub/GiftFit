/**
 * Builds the Aurum Jewelry catalog rows (deterministic, no I/O). Image-dependent fields
 * (`vto_spec_ok`, `vto_params`) are filled by generate.ts after rendering.
 */
import type { CatalogSku, GiftFitAttributes, JewelryCategory, Occasion } from "@/lib/contracts/giftfit";
import type { Design } from "./design";
import { EARRINGS, NECKLACES, type Entry } from "./entries-face";
import { BRACELETS, RINGS, WATCHES, type WatchEntry } from "./entries-hand";
import { AURUM_STORE_ID, fnv1a, skuId } from "./ids";
import { STONES, materialFor, metalFor, priceBand, priceFor, stoneFor, toneOf, type Band } from "./materials";

export const STORE = {
  id: AURUM_STORE_ID,
  name: "Aurum Jewelry",
  /** Reserved .example domain: the demo storefront itself is served by the GiftFit app (A4). */
  url: "https://aurum-jewelry.example",
  platform: "render",
  vertical: "jewelry",
} as const;

const CODE: Record<JewelryCategory, string> = { earring: "EAR", necklace: "NEC", ring: "RNG", bracelet: "BRC", watch: "WCH" };
const BAND_OFFSET: Record<JewelryCategory, number> = { earring: 0, necklace: 1, ring: 2, bracelet: 3, watch: 1 };

export interface BuiltSku {
  sku: CatalogSku;
  design: Design;
  file: string;
}

export const slugify = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const ORDER: Occasion[] = ["anniversary", "wedding", "birthday", "holiday", "graduation", "thank_you", "just_because"];

export function occasionsFor(cat: JewelryCategory, e: Entry, band: Band, stone: string, h: number): Occasion[] {
  const o = new Set<Occasion>();
  const precious = ["diamond", "lab_grown_diamond", "sapphire", "emerald", "ruby", "moissanite"].includes(stone) || stone.endsWith("_pearl");
  const casual = ["minimal", "boho", "modern"].includes(e.style);
  if (band >= 2 || (cat === "ring" && e.slot !== "none" && band >= 1)) o.add("anniversary");
  if ((["classic", "statement", "vintage"].includes(e.style) && band >= 1 && (precious || stone === "none")) || e.variant.startsWith("band_")) o.add("wedding");
  if (casual || band <= 1) o.add("birthday");
  if (e.style === "statement" || ["ruby", "emerald", "garnet"].includes(stone) || h % 3 === 0) o.add("holiday");
  if (cat === "watch" || e.gender !== "feminine" || (e.style === "minimal" && band <= 2)) o.add("graduation");
  if (band === 0 || (band === 1 && e.style === "minimal")) o.add("thank_you");
  if (band <= 1 && (casual || h % 2 === 0)) o.add("just_because");
  for (const fill of ["birthday", "holiday"] as Occasion[]) if (o.size < 2) o.add(fill);
  return ORDER.filter((x) => o.has(x)).slice(0, 4);
}

function describe(cat: JewelryCategory, e: Entry, material: string, stoneLabel: string | undefined, lengthIn?: number, w?: WatchEntry): string {
  const withStone = stoneLabel ? ` with ${stoneLabel}` : "";
  switch (cat) {
    case "earring":
      return `A ${e.style} pair of ${e.noun.toLowerCase()} in ${material}${withStone}. Sold as a pair; shown as a single earring.`;
    case "necklace":
      return `A ${e.style} ${e.noun.toLowerCase()} in ${material}${withStone}, ${lengthIn} in long.`;
    case "ring":
      return `A ${e.style} ${e.noun.toLowerCase()} in ${material}${withStone}. Available in US sizes 4–12.`;
    case "bracelet":
      return `A ${e.style} ${e.noun.toLowerCase()} in ${material}${withStone}, 7 in long.`;
    case "watch":
      return `A ${e.style} ${e.noun.toLowerCase()} with ${/^[aeiou]/.test(w?.dialName ?? "") ? "an" : "a"} ${w?.dialName} dial, ${material} case${withStone} and ${w?.strap.replace("leather_", "").replace("_", " ")} ${w?.strap.startsWith("leather") ? "leather strap" : w?.strap === "link" ? "link bracelet" : "strap"}.`;
  }
}

function build(cat: JewelryCategory, entries: Entry[]): BuiltSku[] {
  const perBand = [0, 0, 0, 0];
  return entries.map((e, i) => {
    const code = `AUR-${CODE[cat]}-${String(i + 1).padStart(3, "0")}`;
    const h = fnv1a(code);
    const band = (e.band ?? ((i + BAND_OFFSET[cat]) % 4)) as Band;
    const nb = perBand[band]++;
    const metal = e.metal ?? metalFor(cat, band, nb + (h % 2));
    const { material, finish } = materialFor(cat, metal, band);
    const st = stoneFor(e.slot, band, nb + (h % 3), e.gender === "masculine");
    const stone = e.stone ?? st.main;
    const info = STONES[stone];
    const paveInfo = st.pave ? STONES[st.pave] : undefined;
    const price = e.price ?? priceFor(band, h);
    const title = `${e.name} ${e.noun}`;
    const file = `${code.toLowerCase()}.png`;
    const image = `/catalog/aurum/${file}`;
    const stoneLabel = stone === "none" ? undefined : info.label + (st.pave && st.pave !== stone && e.slot === "gem_pave" ? ` and ${paveInfo?.label} accents` : e.slot === "pave" ? " pavé" : "");
    const wEntry = cat === "watch" ? (e as WatchEntry) : undefined;
    const attributes: GiftFitAttributes = {
      category: cat,
      metal,
      metal_tone: toneOf(metal),
      stone,
      style: e.style,
      gender_presentation: e.gender,
      occasions: e.occasions ?? occasionsFor(cat, e, band, stone, h),
      vto_spec_ok: false,
      vto_image: image,
      sku: code,
      slug: slugify(title),
      material,
      metal_finish: finish,
      price_band: priceBand(price),
      description: e.description ?? describe(cat, e, material, stoneLabel, e.lengthIn, wEntry),
    };
    if (e.earringShape) attributes.earring_shape = e.earringShape;
    if (e.necklaceStyle) {
      attributes.necklace_style = e.necklaceStyle;
      attributes.necklace_length_in = e.lengthIn;
    }
    if (st.pave && e.slot === "gem_pave") attributes.accent_stone = st.pave;
    if (wEntry) {
      attributes.dial_color = wEntry.dialName;
      attributes.strap = wEntry.strap;
    }
    const design: Design = {
      category: cat,
      variant: e.variant,
      metal,
      stone: info.color ?? (paveInfo?.color as Design["stone"]),
      pearl: info.pearl,
      pave: paveInfo?.color ?? "clear",
      lengthIn: e.lengthIn,
      dial: wEntry?.dial,
      strap: wEntry?.strap,
      jitter: (h % 1000) / 1000,
    };
    if (e.slot === "pave" && cat !== "watch") design.stone = paveInfo?.color;
    const sku: CatalogSku = {
      id: skuId(code),
      storeId: STORE.id,
      title,
      category: cat,
      price,
      currency: "USD",
      images: [image],
      attributes,
    };
    return { sku, design, file };
  });
}

export function buildCatalog(): BuiltSku[] {
  return [
    ...build("earring", EARRINGS),
    ...build("necklace", NECKLACES),
    ...build("ring", RINGS),
    ...build("bracelet", BRACELETS),
    ...build("watch", WATCHES),
  ];
}

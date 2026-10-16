/** Shopper-facing labels and formatting (owner: A4). Pure, client- and server-safe. */
import type { JewelryCategory, Metal, Occasion } from "@/lib/contracts/giftfit";

export const CATEGORIES: ReadonlyArray<{ value: JewelryCategory; slug: string; label: string; singular: string; blurb: string }> = [
  { value: "earring", slug: "earrings", label: "Earrings", singular: "Earring", blurb: "Studs, drops and hoops that catch the light." },
  { value: "necklace", slug: "necklaces", label: "Necklaces", singular: "Necklace", blurb: "Pendants and chains to wear close." },
  { value: "ring", slug: "rings", label: "Rings", singular: "Ring", blurb: "Bands and solitaires for every day." },
  { value: "bracelet", slug: "bracelets", label: "Bracelets", singular: "Bracelet", blurb: "Tennis lines, cuffs and chains." },
  { value: "watch", slug: "watches", label: "Watches", singular: "Watch", blurb: "Quiet dials for every wrist." },
];

export function categoryBySlug(slug: string) {
  return CATEGORIES.find((c) => c.slug === slug);
}

export function categoryInfo(value: JewelryCategory) {
  return CATEGORIES.find((c) => c.value === value)!;
}

export const OCCASION_LABELS: Record<Occasion, string> = {
  anniversary: "Anniversary",
  birthday: "Birthday",
  wedding: "Wedding",
  holiday: "Holiday",
  graduation: "Graduation",
  thank_you: "Thank you",
  just_because: "Just because",
};

export const METAL_LABELS: Record<Metal, string> = {
  yellow_gold: "Yellow gold",
  rose_gold: "Rose gold",
  white_gold: "White gold",
  silver: "Silver tone",
  platinum: "Platinum",
  mixed_two_tone: "Two-tone",
};

/** Swatch colours for metals (product data, never recipient data). */
export const METAL_SWATCH: Record<Metal, string> = {
  yellow_gold: "linear-gradient(135deg,#e9cf8a,#b8913f)",
  rose_gold: "linear-gradient(135deg,#efc3b0,#b97a64)",
  white_gold: "linear-gradient(135deg,#f3f3f1,#bdbdb8)",
  silver: "linear-gradient(135deg,#ececec,#a9abad)",
  platinum: "linear-gradient(135deg,#f1f1f3,#b3b5bb)",
  mixed_two_tone: "linear-gradient(135deg,#e9cf8a 50%,#cfd0d2 50%)",
};

export function formatPrice(amount: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: amount % 1 === 0 ? 0 : 2 }).format(amount);
}

export function humanize(token: string): string {
  if (!token || token === "none") return "";
  const s = token.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function productPath(p: { slug: string }): string {
  return `/p/${p.slug}`;
}

export function formatExpiry(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

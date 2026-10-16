/**
 * Giver Panel rules (owner: A4). Pure functions so validation is unit-tested without a DOM.
 * ADR-032: the giver picks designs, a budget CAP and an optional metal lock; only variants
 * priced ≤ cap and inside the lock reach the recipient, so any choice they make is affordable.
 */
import type { CreateFitRequestBody } from "@/lib/contracts/api";
import type { JewelryCategory, Metal, Occasion } from "@/lib/contracts/giftfit";

export const MIN_SHORTLIST = 1;
export const MAX_SHORTLIST = 4;
export const MAX_BUDGET = 50_000;

/** A design as the panel shows it (product data only). */
export interface GiftPiece {
  id: string;
  slug: string;
  title: string;
  /** Default variant price (display). */
  price: number;
  currency: string;
  image: string;
  category: JewelryCategory;
  metal?: Metal;
  occasions?: readonly Occasion[];
  style?: string;
  isPhoto?: boolean;
  /** Metal variants the store sells; absent = a single variant at `price` in `metal`. */
  variants?: ReadonlyArray<{ metal: Metal; price: number }>;
}

export const BUDGET_PRESETS = [
  { id: "150", label: "Up to $150", max: 150 },
  { id: "300", label: "Up to $300", max: 300 },
  { id: "600", label: "Up to $600", max: 600 },
  { id: "1000", label: "Up to $1,000", max: 1000 },
  { id: "2500", label: "Up to $2,500", max: 2500 },
] as const;
export type BudgetPresetId = (typeof BUDGET_PRESETS)[number]["id"] | "custom";

/** Metal lock choices: Any, a family, or one metal. */
export const METAL_LOCKS = [
  { id: "any", label: "Any metal", metals: null },
  { id: "gold", label: "Gold tones", metals: ["yellow_gold", "rose_gold"] },
  {
    id: "white",
    label: "White metals",
    metals: ["white_gold", "silver", "platinum"],
  },
  { id: "yellow_gold", label: "Yellow gold", metals: ["yellow_gold"] },
  { id: "rose_gold", label: "Rose gold", metals: ["rose_gold"] },
  { id: "white_gold", label: "White gold", metals: ["white_gold"] },
  { id: "silver", label: "Silver", metals: ["silver"] },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  metals: readonly Metal[] | null;
}>;
export type MetalLockId = (typeof METAL_LOCKS)[number]["id"];

export function lockMetals(lock: MetalLockId): Metal[] | undefined {
  const m = METAL_LOCKS.find((l) => l.id === lock)?.metals;
  return m ? [...m] : undefined;
}

export interface GiverDraft {
  occasion: Occasion | null;
  budgetPreset: BudgetPresetId | null;
  customMax: string;
  metalLock: MetalLockId;
  shortlist: GiftPiece[];
}

export interface DraftErrors {
  occasion?: string;
  budget?: string;
  shortlist?: string;
}

export interface DraftCheck {
  ok: boolean;
  errors: DraftErrors;
  /** Shortlisted designs with no metal inside the cap and lock (blocks sending: the API answers 422). */
  ineligible: GiftPiece[];
  cap: number | null;
}

export function variantsOf(
  p: GiftPiece,
): ReadonlyArray<{ metal: Metal; price: number }> {
  return p.variants?.length
    ? p.variants
    : [{ metal: p.metal ?? "yellow_gold", price: p.price }];
}

/** Variants the recipient may see: priced ≤ cap (when set) and inside the lock. */
export function eligibleVariants(
  p: GiftPiece,
  cap: number | null,
  lock: MetalLockId = "any",
) {
  const metals = lockMetals(lock);
  return variantsOf(p).filter(
    (v) =>
      (cap === null || v.price <= cap) && (!metals || metals.includes(v.metal)),
  );
}

export function resolveCap(
  d: Pick<GiverDraft, "budgetPreset" | "customMax">,
): number | null | "invalid" {
  if (!d.budgetPreset) return null;
  if (d.budgetPreset !== "custom")
    return BUDGET_PRESETS.find((b) => b.id === d.budgetPreset)!.max;
  const max = d.customMax.trim() === "" ? NaN : Number(d.customMax);
  if (!Number.isFinite(max) || max <= 0 || max > MAX_BUDGET) return "invalid";
  return Math.round(max);
}

export function validateDraft(d: GiverDraft): DraftCheck {
  const errors: DraftErrors = {};
  if (!d.occasion) errors.occasion = "Choose the occasion.";
  const cap = resolveCap(d);
  if (cap === null) errors.budget = "Choose a budget cap.";
  else if (cap === "invalid")
    errors.budget = `Enter a maximum from $1 to $${MAX_BUDGET.toLocaleString("en-US")}.`;
  const capValue = typeof cap === "number" ? cap : null;
  const ids = new Set(d.shortlist.map((p) => p.id));
  const ineligible =
    capValue === null
      ? []
      : d.shortlist.filter(
          (p) => eligibleVariants(p, capValue, d.metalLock).length === 0,
        );
  if (d.shortlist.length < MIN_SHORTLIST)
    errors.shortlist = "Add at least one design to your shortlist.";
  else if (d.shortlist.length > MAX_SHORTLIST)
    errors.shortlist = `Your shortlist can have up to ${MAX_SHORTLIST} designs. Remove ${d.shortlist.length - MAX_SHORTLIST}.`;
  else if (ids.size !== d.shortlist.length)
    errors.shortlist = "Each design can be on your shortlist once.";
  else if (ineligible.length)
    errors.shortlist = `${ineligible.map((p) => p.title).join(", ")} ${ineligible.length === 1 ? "has" : "have"} no metal within your budget and metal choice. Raise the cap, change the metal or remove ${ineligible.length === 1 ? "it" : "them"}.`;
  return {
    ok: Object.keys(errors).length === 0,
    errors,
    ineligible,
    cap: capValue,
  };
}

export function toRequestBody(
  d: GiverDraft,
  storeId?: string,
): CreateFitRequestBody {
  const check = validateDraft(d);
  if (!check.ok || check.cap === null || !d.occasion)
    throw new Error("Draft is not valid");
  const metalLock = lockMetals(d.metalLock);
  return {
    ...(storeId ? { storeId } : {}),
    occasion: d.occasion,
    budgetMax: check.cap,
    ...(metalLock ? { metalLock } : {}),
    currency: d.shortlist[0]?.currency ?? "USD",
    shortlistIds: d.shortlist.map((p) => p.id),
  };
}

/** Smallest cap preset that covers a price, to pre-select something sensible. */
export function presetForPrice(price: number): BudgetPresetId {
  return (
    BUDGET_PRESETS.find((b) => price <= b.max) ??
    BUDGET_PRESETS[BUDGET_PRESETS.length - 1]
  ).id;
}

/**
 * Designs to suggest: not already picked, with at least one variant inside the cap and lock,
 * tagged for the occasion first, the same categories as the picks first, photo designs first.
 */
export function suggestPieces(
  catalog: readonly GiftPiece[],
  d: GiverDraft,
  query = "",
  limit = 6,
): GiftPiece[] {
  const picked = new Set(d.shortlist.map((p) => p.id));
  const cats = new Set(d.shortlist.map((p) => p.category));
  const cap = resolveCap(d);
  const capValue = typeof cap === "number" ? cap : null;
  const q = query.trim().toLowerCase();
  return catalog
    .filter((p) => !picked.has(p.id))
    .filter((p) =>
      q
        ? `${p.title} ${p.category} ${variantsOf(p)
            .map((v) => v.metal)
            .join(" ")}`
            .toLowerCase()
            .replace(/_/g, " ")
            .includes(q)
        : true,
    )
    .filter((p) => eligibleVariants(p, capValue, d.metalLock).length > 0)
    .map((p) => {
      let score = 0;
      if (d.occasion && p.occasions?.includes(d.occasion)) score += 4;
      if (cats.has(p.category)) score += 2;
      if (p.isPhoto) score += 3;
      score +=
        Math.min(2, eligibleVariants(p, capValue, d.metalLock).length - 1) *
        0.5;
      if (capValue)
        score -=
          (capValue -
            Math.max(
              ...eligibleVariants(p, capValue, d.metalLock).map((v) => v.price),
              0,
            )) /
          capValue;
      return { p, score };
    })
    .sort((a, b) => b.score - a.score || a.p.price - b.p.price)
    .slice(0, limit)
    .map((x) => x.p);
}

/**
 * Grounding and output rules for the Gift Concierge (owner: A7, ADR-040), enforced in code:
 *   - only catalog ids that a tool returned in THIS request may appear in a brief or a suggestion;
 *   - every suggestion has ≥ 1 metal variant within the budget cap and metal lock, and its prices
 *     come from the catalog (the model never supplies a price);
 *   - prose never carries ids, SKU codes, URLs or hex values (stripped while streaming);
 *   - briefs are validated against the shared contract (GiftBrief) and the store's currency.
 */
import { z } from "zod";
import { GIFT_MODES, STYLE_FAMILIES, type GiftBrief } from "@/lib/contracts/api";
import { METALS, OCCASIONS } from "@/lib/contracts/giftfit";
import { eligibleMetals, genderMatches, type ConciergeCatalog } from "./catalog";
import { CONCIERGE_LIMITS, type ConciergeSuggestion } from "./types";

const CATEGORIES = ["earring", "necklace", "ring", "bracelet", "watch"] as const;

/** Ids returned by a tool during the current request. */
export class GroundingLedger {
  private readonly ids = new Set<string>();
  add(ids: Iterable<string>): void {
    for (const id of ids) this.ids.add(id);
  }
  has(id: string): boolean {
    return this.ids.has(id);
  }
  get size(): number {
    return this.ids.size;
  }
}

// ---------------------------------------------------------------------------------------------
// Prose scrubbing
// ---------------------------------------------------------------------------------------------

const PROSE_PATTERNS: RegExp[] = [
  // catalog ids (UUIDs) and variant ids ("<uuid>:<metal>")
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?::[a-z_]+)?/gi,
  // store SKU codes, e.g. AUR-EAR-001
  /\b[A-Z]{2,5}-[A-Z]{2,5}-\d{2,5}\b/g,
  // URLs and app paths
  /\b(?:https?:\/\/|www\.)\S+/gi,
  /(?:^|(?<=\s))\/(?:catalog|api|r|g)\/\S*/gi,
  /\b(?:data|blob):\S+/gi,
  // hex colours
  /#[0-9a-f]{6}(?:[0-9a-f]{2})?\b/gi,
];

/** Removes ids, SKU codes, URLs and hex values from prose. */
export function scrubProse(text: string): string {
  let out = text;
  for (const re of PROSE_PATTERNS) out = out.replace(re, "");
  return out.replace(/\(\s*\)/g, "").replace(/[ \t]{2,}/g, " ");
}

/**
 * Streaming scrubber: holds back the trailing partial token so a pattern split across deltas is still
 * caught (none of the patterns contains whitespace). Long whitespace-free runs are flushed at 120 chars.
 */
export class ProseScrubber {
  private buffer = "";
  push(delta: string): string {
    this.buffer += delta;
    const cut = Math.max(this.buffer.lastIndexOf(" "), this.buffer.lastIndexOf("\n"), this.buffer.lastIndexOf("\t"));
    if (cut < 0) {
      if (this.buffer.length <= 120) return "";
      return this.flush();
    }
    const ready = this.buffer.slice(0, cut + 1);
    this.buffer = this.buffer.slice(cut + 1);
    return scrubProse(ready);
  }
  flush(): string {
    const out = scrubProse(this.buffer);
    this.buffer = "";
    return out;
  }
}

/** A suggestion reason: scrubbed, single paragraph, ≤ 220 chars. */
export function sanitizeReason(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const s = scrubProse(raw).replace(/\s+/g, " ").trim();
  return s.length > 220 ? `${s.slice(0, 217).trimEnd()}…` : s;
}

// ---------------------------------------------------------------------------------------------
// Brief validation
// ---------------------------------------------------------------------------------------------

const uniq = <T,>(a: readonly T[] | undefined) => (a ? [...new Set(a)] : undefined);

export const BriefInputSchema = z.object({
  mode: z.enum(GIFT_MODES).default("help_me_choose"),
  occasion: z.enum(OCCASIONS),
  budgetMax: z.number().finite().positive().max(1_000_000),
  currency: z.string().trim().min(3).max(3),
  categories: z.array(z.enum(CATEGORIES)).max(5).optional(),
  metalLock: z.array(z.enum(METALS)).max(6).optional(),
  styleHints: z.array(z.enum(STYLE_FAMILIES)).max(7).optional(),
  genderPresentation: z.enum(["feminine", "masculine", "unisex"]).optional(),
  shortlistIds: z.array(z.string().max(80)).max(8).optional(),
});

export type BriefValidation =
  | { ok: true; brief: GiftBrief; notes: string[] }
  | { ok: false; errors: string[] };

/** Designs with at least one eligible variant for the brief (category, gender, cap, lock). */
export function eligibleDesignIds(catalog: ConciergeCatalog, brief: Pick<GiftBrief, "budgetMax" | "currency" | "metalLock" | "categories" | "genderPresentation">): string[] {
  return catalog.skus
    .filter((s) => (!brief.categories?.length || brief.categories.includes(s.category)) && genderMatches(s, brief.genderPresentation))
    .filter((s) => eligibleMetals(s, brief.budgetMax, brief.metalLock, brief.currency).length > 0)
    .map((s) => s.id);
}

export function cheapestPrice(catalog: ConciergeCatalog, brief: Pick<GiftBrief, "metalLock" | "categories" | "genderPresentation">): number | undefined {
  let min: number | undefined;
  for (const s of catalog.skus) {
    if (brief.categories?.length && !brief.categories.includes(s.category)) continue;
    if (!genderMatches(s, brief.genderPresentation)) continue;
    const m = eligibleMetals(s, undefined, brief.metalLock, catalog.currency)[0];
    if (m && (min === undefined || m.price < min)) min = m.price;
  }
  return min;
}

/**
 * Validates a model- or fallback-produced brief. Unknown fields are dropped; the currency must be the
 * store's; "i_have_ideas" keeps only grounded, eligible shortlist ids (1–4) and otherwise becomes
 * "help_me_choose"; at least one design must be eligible.
 */
export function validateBrief(raw: unknown, catalog: ConciergeCatalog, ledger: GroundingLedger | null): BriefValidation {
  const parsed = BriefInputSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "brief"}: ${i.message}`) };
  }
  const p = parsed.data;
  const currency = p.currency.toUpperCase();
  if (currency !== catalog.currency) {
    return { ok: false, errors: [`currency: the store prices in ${catalog.currency}; convert the budget to ${catalog.currency} first`] };
  }
  const notes: string[] = [];
  const brief: GiftBrief = {
    mode: p.mode,
    occasion: p.occasion,
    budgetMax: Math.round(p.budgetMax * 100) / 100,
    currency,
    ...(p.categories?.length ? { categories: uniq(p.categories) } : {}),
    ...(p.metalLock?.length ? { metalLock: uniq(p.metalLock) } : {}),
    ...(p.styleHints?.length ? { styleHints: uniq(p.styleHints) } : {}),
    ...(p.genderPresentation ? { genderPresentation: p.genderPresentation } : {}),
  };
  const eligible = new Set(eligibleDesignIds(catalog, brief));
  if (eligible.size === 0) {
    const min = cheapestPrice(catalog, brief);
    return {
      ok: false,
      errors: [min === undefined ? "no design matches these categories and metals" : `no design is within ${brief.budgetMax} ${currency} for these filters; the cheapest starts at ${min} ${currency}`],
    };
  }
  if (p.mode === "i_have_ideas") {
    const kept = (uniq(p.shortlistIds) ?? []).filter((id) => (ledger ? ledger.has(id) : true) && eligible.has(id)).slice(0, 4);
    const dropped = (p.shortlistIds?.length ?? 0) - kept.length;
    if (dropped > 0) notes.push(`${dropped} shortlist id(s) were not grounded in a tool result or not eligible and were removed`);
    if (kept.length === 0) {
      brief.mode = "help_me_choose";
      notes.push('no valid shortlist ids, so the mode is "help_me_choose"');
    } else {
      brief.shortlistIds = kept;
    }
  }
  return { ok: true, brief, notes };
}

// ---------------------------------------------------------------------------------------------
// Suggestion validation
// ---------------------------------------------------------------------------------------------

export interface RawSuggestion {
  catalogId?: unknown;
  reason?: unknown;
}

/**
 * Keeps ≤ 3 suggestions whose id was returned by a tool in this request, exists in the catalog and has
 * ≥ 1 variant within the brief's cap, lock, category and gender filters. Prices are recomputed from the
 * catalog; anything else the model sent (prices, titles, images) is ignored.
 */
export function validateSuggestions(raw: unknown, brief: GiftBrief, catalog: ConciergeCatalog, ledger: GroundingLedger | null): { suggestions: ConciergeSuggestion[]; dropped: number } {
  const list = Array.isArray(raw) ? (raw as RawSuggestion[]) : [];
  const out: ConciergeSuggestion[] = [];
  let dropped = 0;
  const allowed = new Set(eligibleDesignIds(catalog, brief));
  for (const item of list) {
    const id = item && typeof item === "object" && typeof item.catalogId === "string" ? item.catalogId : undefined;
    const sku = id ? catalog.byId.get(id) : undefined;
    if (!id || !sku || (ledger && !ledger.has(id)) || !allowed.has(id) || out.some((s) => s.catalogId === id)) {
      dropped++;
      continue;
    }
    if (out.length >= CONCIERGE_LIMITS.maxSuggestions) {
      dropped++;
      continue;
    }
    const metals = eligibleMetals(sku, brief.budgetMax, brief.metalLock, brief.currency);
    out.push({
      catalogId: sku.id,
      title: sku.title,
      category: sku.category,
      style: sku.attributes.style,
      reason: sanitizeReason(item.reason) || defaultReason(sku.attributes.style, sku.category),
      eligibleMetals: metals,
      fromPrice: metals[0].price,
      currency: brief.currency,
      ...(sku.images[0] ? { image: sku.images[0] } : {}),
    });
  }
  return { suggestions: out, dropped };
}

function defaultReason(style: string, category: string): string {
  return `A ${style} ${category} within your budget.`;
}

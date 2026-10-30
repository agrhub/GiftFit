/**
 * The Gift Concierge's tools (owner: A7, ADR-040). All deterministic over the catalog: no recipient
 * data, no Fit Request access, no paid YouCam calls. Each executor receives only the model's tool input
 * (validated with zod; unknown fields are dropped) and the catalog.
 *
 * `create_fit_request` never creates anything: it validates and returns a DRAFT brief that the giver
 * confirms in the UI ("Use this brief"), which then goes through the normal POST /api/fit/requests.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { STYLE_FAMILIES, type GiftBrief } from "@/server/contracts/api";
import { METALS, OCCASIONS } from "@/server/contracts/giftfit";
import { allMetals, eligibleMetals, genderOf, searchCatalog, type ConciergeCatalog } from "./catalog";
import { BriefInputSchema, eligibleDesignIds, GroundingLedger, validateBrief, validateSuggestions } from "./grounding";
import type { ConciergeSuggestion, ConciergeToolName } from "./types";

const CATEGORIES = ["earring", "necklace", "ring", "bracelet", "watch"] as const;
const GENDERS = ["feminine", "masculine", "unisex"] as const;

const enumArray = (values: readonly string[], description: string) => ({ type: "array", items: { type: "string", enum: [...values] }, description });

/**
 * Tool definitions, in a fixed order (prompt-cache prefix). The last one carries the cache breakpoint,
 * so the system prompt + tools are cached together.
 */
export const CONCIERGE_TOOLS: Anthropic.Tool[] = [
  {
    name: "search_catalog",
    description:
      "Search this store's jewelry catalog. Returns compact rows: id, title, category, style, gender presentation and metals with USD prices (only metals within maxPrice/metal when given). category, style, metal, maxPrice and genderPresentation filter; occasion and text only rank. Use English keywords in text.",
    input_schema: {
      type: "object",
      properties: {
        category: enumArray(CATEGORIES, "Jewelry categories to include."),
        style: enumArray(STYLE_FAMILIES, "Style families to include."),
        metal: enumArray(METALS, "Only designs sold in one of these metals (and only those variants)."),
        maxPrice: { type: "number", description: "Budget cap in the store currency (USD)." },
        occasion: { type: "string", enum: [...OCCASIONS] },
        genderPresentation: { type: "string", enum: [...GENDERS], description: "feminine/masculine also include unisex designs." },
        text: { type: "string", description: "Free-text keywords, e.g. 'pearl drop' or 'tennis'." },
        limit: { type: "integer", minimum: 1, maximum: 12 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "fit_preview",
    description:
      "Catalog facts for up to 6 design ids: style family, category, every metal with its price and whether it is within budgetMax/metalLock, and the price range. Catalog only: there is no recipient or face data.",
    input_schema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, maxItems: 6 },
        budgetMax: { type: "number" },
        metalLock: enumArray(METALS, "Optional metal lock."),
      },
      required: ["ids"],
      additionalProperties: false,
    },
  },
  {
    name: "check_budget_and_metals",
    description:
      "Check a budget cap (USD) and optional metal lock: how many designs have an eligible variant (per category), the cheapest eligible price, and, for given ids, which variants are eligible.",
    input_schema: {
      type: "object",
      properties: {
        budgetMax: { type: "number" },
        metalLock: enumArray(METALS, "Optional metal lock."),
        ids: { type: "array", items: { type: "string" }, maxItems: 8 },
      },
      required: ["budgetMax"],
      additionalProperties: false,
    },
  },
  {
    name: "create_fit_request",
    description:
      'Validate a gift brief and return it as a DRAFT for the giver to confirm in the app. It does not create or send anything. mode "help_me_choose" (default: GiftFit picks 6-8 pieces within budget) unless the giver named specific pieces, then "i_have_ideas" with 1-4 shortlistIds. Include up to 3 suggestions (ids from earlier tool results) with a one-sentence reason each, in the shopper\'s language.',
    input_schema: {
      type: "object",
      properties: {
        brief: {
          type: "object",
          properties: {
            mode: { type: "string", enum: ["help_me_choose", "i_have_ideas"] },
            occasion: { type: "string", enum: [...OCCASIONS] },
            budgetMax: { type: "number", description: "Cap in USD." },
            currency: { type: "string", enum: ["USD"] },
            categories: enumArray(CATEGORIES, "Empty = all categories."),
            metalLock: enumArray(METALS, "Only if the giver insists on metals."),
            styleHints: enumArray(STYLE_FAMILIES, "Hints bias the selection; they never exclude."),
            genderPresentation: { type: "string", enum: [...GENDERS] },
            shortlistIds: { type: "array", items: { type: "string" }, maxItems: 4 },
          },
          required: ["mode", "occasion", "budgetMax", "currency"],
          additionalProperties: false,
        },
        suggestions: {
          type: "array",
          maxItems: 3,
          items: {
            type: "object",
            properties: { catalogId: { type: "string" }, reason: { type: "string" } },
            required: ["catalogId", "reason"],
            additionalProperties: false,
          },
        },
      },
      required: ["brief"],
      additionalProperties: false,
    },
    cache_control: { type: "ephemeral" },
  },
];

// ---------------------------------------------------------------------------------------------
// Input schemas (validated before running; the model's input is untrusted)
// ---------------------------------------------------------------------------------------------

const SearchInput = z.object({
  category: z.array(z.enum(CATEGORIES)).max(5).optional(),
  style: z.array(z.enum(STYLE_FAMILIES)).max(7).optional(),
  metal: z.array(z.enum(METALS)).max(6).optional(),
  maxPrice: z.number().finite().positive().max(1_000_000).optional(),
  occasion: z.enum(OCCASIONS).optional(),
  genderPresentation: z.enum(GENDERS).optional(),
  text: z.string().max(120).optional(),
  limit: z.number().int().min(1).max(12).optional(),
});

const PreviewInput = z.object({
  ids: z.array(z.string().max(80)).min(1).max(6),
  budgetMax: z.number().finite().positive().max(1_000_000).optional(),
  metalLock: z.array(z.enum(METALS)).max(6).optional(),
});

const BudgetInput = z.object({
  budgetMax: z.number().finite().positive().max(1_000_000),
  metalLock: z.array(z.enum(METALS)).max(6).optional(),
  ids: z.array(z.string().max(80)).max(8).optional(),
});

const CreateInput = z.object({
  brief: z.unknown(),
  suggestions: z.array(z.object({ catalogId: z.unknown(), reason: z.unknown() })).max(10).optional(),
});

export interface ToolOutcome {
  /** JSON sent back to the model as the tool_result. */
  result: unknown;
  isError: boolean;
  /** One short line for the shopper-visible transcript. */
  summary: string;
  /** Set by a successful create_fit_request. */
  draft?: { brief: GiftBrief; suggestions: ConciergeSuggestion[] };
}

const money = (n: number) => `$${Math.round(n * 100) / 100}`;

export function isConciergeTool(name: string): name is ConciergeToolName {
  return CONCIERGE_TOOLS.some((t) => t.name === name);
}

/** Runs one tool call. Records every id the tool returns in the ledger (grounding). Never throws. */
export function runConciergeTool(name: string, input: unknown, catalog: ConciergeCatalog, ledger: GroundingLedger): ToolOutcome {
  try {
    switch (name) {
      case "search_catalog": {
        const p = SearchInput.safeParse(input);
        if (!p.success) return invalid(name, p.error);
        const { rows, total } = searchCatalog(catalog, { ...p.data });
        ledger.add(rows.map((r) => r.id));
        const filters = [p.data.category?.join("/"), p.data.style?.join("/"), p.data.metal?.join("/"), p.data.maxPrice !== undefined ? `≤ ${money(p.data.maxPrice)}` : undefined, p.data.text ? `"${p.data.text}"` : undefined]
          .filter(Boolean)
          .join(", ");
        return { result: { total, rows }, isError: false, summary: `Searched the catalog${filters ? ` (${filters})` : ""}: ${total} match${total === 1 ? "" : "es"}` };
      }
      case "fit_preview": {
        const p = PreviewInput.safeParse(input);
        if (!p.success) return invalid(name, p.error);
        const items = [];
        const unknown: string[] = [];
        for (const id of p.data.ids) {
          const sku = catalog.byId.get(id);
          if (!sku) {
            unknown.push(id);
            continue;
          }
          const all = allMetals(sku);
          const ok = new Set(eligibleMetals(sku, p.data.budgetMax, p.data.metalLock, catalog.currency).map((m) => m.metal));
          items.push({
            id: sku.id,
            title: sku.title,
            category: sku.category,
            styleFamily: sku.attributes.style,
            genderPresentation: genderOf(sku),
            occasions: sku.attributes.occasions ?? [],
            metals: all.map((m) => ({ ...m, withinBudget: ok.has(m.metal) })),
            priceRange: { min: all[0].price, max: all[all.length - 1].price },
          });
        }
        ledger.add(items.map((i) => i.id));
        return { result: { currency: catalog.currency, items, ...(unknown.length ? { unknownIds: unknown } : {}) }, isError: false, summary: `Previewed ${items.length} design${items.length === 1 ? "" : "s"} (catalog facts only)` };
      }
      case "check_budget_and_metals": {
        const p = BudgetInput.safeParse(input);
        if (!p.success) return invalid(name, p.error);
        const { budgetMax, metalLock, ids } = p.data;
        const eligible = eligibleDesignIds(catalog, { budgetMax, currency: catalog.currency, metalLock });
        const byCategory: Record<string, number> = {};
        let cheapest: number | undefined;
        for (const id of eligible) {
          const sku = catalog.byId.get(id)!;
          byCategory[sku.category] = (byCategory[sku.category] ?? 0) + 1;
          const m = eligibleMetals(sku, budgetMax, metalLock, catalog.currency)[0];
          if (cheapest === undefined || m.price < cheapest) cheapest = m.price;
        }
        const checked = (ids ?? []).flatMap((id) => {
          const sku = catalog.byId.get(id);
          if (!sku) return [{ id, known: false }];
          const metals = eligibleMetals(sku, budgetMax, metalLock, catalog.currency);
          return [{ id, known: true, title: sku.title, eligibleMetals: metals, eligible: metals.length > 0 }];
        });
        ledger.add(checked.filter((c) => c.known).map((c) => c.id));
        return {
          result: { currency: catalog.currency, budgetMax, metalLock: metalLock ?? [], eligibleDesigns: eligible.length, byCategory, cheapestEligiblePrice: cheapest ?? null, ...(ids ? { checked } : {}) },
          isError: false,
          summary: `Checked ${money(budgetMax)}${metalLock?.length ? ` in ${metalLock.join("/")}` : ""}: ${eligible.length} eligible design${eligible.length === 1 ? "" : "s"}`,
        };
      }
      case "create_fit_request": {
        const p = CreateInput.safeParse(input);
        if (!p.success) return invalid(name, p.error);
        const v = validateBrief(p.data.brief, catalog, ledger);
        if (!v.ok) return { result: { ok: false, errors: v.errors }, isError: true, summary: "Draft brief needs a fix" };
        const s = validateSuggestions(p.data.suggestions ?? [], v.brief, catalog, ledger);
        const notes = [...v.notes, ...(s.dropped > 0 ? [`${s.dropped} suggestion(s) were removed: not from a tool result, unknown, or no variant within the budget/lock`] : [])];
        return {
          result: {
            ok: true,
            status: "draft",
            // The button is not named: its label is translated in the widget, and a quoted English name leaks into other languages.
            note: "Nothing was created. The giver reviews this brief in the panel and confirms it with the button below it to continue.",
            brief: v.brief,
            suggestions: s.suggestions.map((x) => ({ catalogId: x.catalogId, title: x.title, eligibleMetals: x.eligibleMetals })),
            ...(notes.length ? { notes } : {}),
          },
          isError: false,
          summary: `Drafted a ${v.brief.mode === "help_me_choose" ? '"Help me choose"' : '"I have ideas"'} brief: ${v.brief.occasion.replace("_", " ")}, up to ${money(v.brief.budgetMax)} (not sent)`,
          draft: { brief: v.brief, suggestions: s.suggestions },
        };
      }
      default:
        return { result: { error: `unknown tool ${name}` }, isError: true, summary: "Unknown tool refused" };
    }
  } catch (err) {
    console.error("[concierge] tool failed:", name, (err as Error).message);
    return { result: { error: "tool failed" }, isError: true, summary: `${name} failed` };
  }
}

function invalid(name: string, err: z.ZodError): ToolOutcome {
  return {
    result: { error: "invalid input", issues: err.issues.slice(0, 5).map((i) => `${i.path.join(".") || "input"}: ${i.message}`) },
    isError: true,
    summary: `${name}: invalid input refused`,
  };
}

/** Exposed for tests: the brief schema the create tool validates against. */
export { BriefInputSchema };

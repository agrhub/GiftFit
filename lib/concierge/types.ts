/**
 * Gift Concierge contract (owner: A7, ADR-040/045/046). UI-agnostic and safe to import from the
 * browser: types and constants only. The Giver Panel, the /concierge-demo page and the future
 * embeddable widget all speak this contract.
 *
 * POST /api/concierge  body: ConciergeRequestBody
 *   200  application/x-ndjson, one ConciergeEvent per line:
 *        start → (text | tool)* → final          (or start → … → error on an internal failure)
 *   400  {"error":"invalid_request" | "message_too_long"}
 *   429  {"error":"rate_limited"} + Retry-After (per-IP `concierge` scope)
 */
import type { GiftBrief } from "@/lib/contracts/api";
import type { JewelryCategory, Metal } from "@/lib/contracts/giftfit";

export interface ConciergeChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ConciergeRequestBody {
  messages: ConciergeChatMessage[];
}

/** History caps (enforced by the route and the engine). */
export const CONCIERGE_LIMITS = {
  /** Older messages beyond this are dropped (oldest first). */
  maxMessages: 12,
  /** A single message over this is rejected with 400 message_too_long. */
  maxMessageChars: 1_500,
  /** Total characters kept from the history (oldest dropped first). */
  maxTotalChars: 6_000,
  /** At most 3 suggested designs. */
  maxSuggestions: 3,
} as const;

export const CONCIERGE_TOOL_NAMES = ["search_catalog", "fit_preview", "check_budget_and_metals", "create_fit_request"] as const;
export type ConciergeToolName = (typeof CONCIERGE_TOOL_NAMES)[number];

/** One suggested design, grounded in the catalog; prices come from the catalog, never from the model. */
export interface ConciergeSuggestion {
  catalogId: string;
  title: string;
  category: JewelryCategory;
  style: string;
  /** Why it fits (model- or template-written, scrubbed of ids, URLs and hex values). */
  reason: string;
  /** Metal variants within the brief's budget cap and metal lock (≥ 1), cheapest first. */
  eligibleMetals: Array<{ metal: Metal; price: number }>;
  fromPrice: number;
  currency: string;
  /** Public catalog product image (never a try-on). */
  image?: string;
}

/** Where the answer came from. `fallback` = deterministic keyword/budget parsing + catalog filters. */
export type ConciergeSource = "claude" | "mock" | "fallback";

export type ConciergeDegradeReason = "no_key" | "spend_cap" | "api_error" | "refusal" | "disabled";

export type ConciergeEvent =
  | { type: "start"; source: ConciergeSource }
  | { type: "text"; delta: string }
  | { type: "tool"; name: ConciergeToolName; summary: string }
  | {
      type: "final";
      /** A DRAFT brief for the giver to confirm in the UI; absent when the concierge still needs input. */
      brief?: GiftBrief;
      suggestions: ConciergeSuggestion[];
      source: ConciergeSource;
      /** True when Claude could not be used (spend cap, API error) and the deterministic fallback answered. */
      degraded: boolean;
      degradeReason?: ConciergeDegradeReason;
      /** Short assumptions the fallback made (e.g. "Budget assumed: $250"). */
      notes?: string[];
    }
  | { type: "error"; error: "internal_error" };

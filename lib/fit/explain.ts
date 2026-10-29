/**
 * Fit Report explanations (MASTER_PLAN v2 G6, rule 2 "grounded").
 *
 * Claude (DEFAULT_CLAUDE_MODEL, lib/anthropic/budget.ts) rewrites the deterministic reasons into 2 reasons + 1 caution per SKU,
 * each ≤ 20 words, under a strict JSON schema whose `skuId` is an enum of the scored ids. The model
 * receives ONLY scored SKU ids, scores, category words and giver-safe signal labels such as
 * "hearted" or "warm undertone estimate → yellow gold: recommended": never titles, images, URLs,
 * hex values, CIELAB numbers, confidence numbers or face measurements.
 *
 * Every model output passes `validateExplanation`; anything ungrounded, leaky or too long is
 * replaced by the deterministic template text for that slot. Without ANTHROPIC_API_KEY (or on any
 * API error, or when the daily spend cap refuses the call) the template is used for everything, so
 * the app works with no key. Every call is reserve → call → settle (lib/fit/claude.ts).
 */
import { DEFAULT_CLAUDE_MODEL } from "@/lib/anthropic/budget";
import type { FitResult, JewelryCategory } from "@/lib/contracts/giftfit";
import type { Locale } from "@/lib/i18n";
import { reportLanguage } from "@/lib/i18n/report";
import { ClaudeSpendRefused, type MessagesLike, type ReserveFn, anthropicFromEnv, callClaudeJson } from "./claude";
import { NO_TRYON_WORDS_EN, mentionsBiometric, mentionsPhoto, mentionsTryOn, wordCount as countWords, wrongScript } from "./guardWords";
import { type ScoredSku, genericCaution, toFitResult } from "./score";

export const EXPLAIN_MODEL = DEFAULT_CLAUDE_MODEL;
export const MAX_WORDS = 20;

/** What the model sees for one SKU. Built only by `buildExplainInput`. */
export interface ExplainItem {
  skuId: string;
  score: number;
  category: JewelryCategory;
  breakdown: FitResult["breakdown"];
  signals: string[];
  /** A16 mixed set: this piece was not tried on (its signals have no undertone/face/try-on facts; neither may the text). */
  tryOn?: false;
}

export interface ExplainRequest {
  /**
   * false when no try-on happened (store previews, or no photo taken): the items carry only hearts and
   * budget/occasion signals, the no-try-on system prompt is used and outputs may not mention undertone,
   * face shape or a try-on.
   */
  tryOn?: false;
  items: ExplainItem[];
  /**
   * The giver's report language when it is not English (lib/i18n/report): the model writes every reason
   * and caution in it. The client puts it in the system prompt, not in the item JSON.
   */
  language?: { code: string; name: string };
}

export interface ExplainOutputItem {
  skuId: string;
  reason1: string;
  reason2: string;
  caution: string;
}

/** Narrow interface so tests can inject a mock and the app can run without a key. */
export interface ExplainClient {
  readonly model: string;
  explain(request: ExplainRequest, schema: Record<string, unknown>): Promise<unknown>;
}

export type ExplanationSource = "llm" | "llm_repaired" | "template";

export interface ExplainIssue {
  skuId?: string;
  field?: "reason1" | "reason2" | "caution" | "items";
  code:
    | "no_client"
    | "client_error"
    /** The daily Anthropic spend cap refused the call (lib/anthropic/budget.ts); nothing was sent. */
    | "spend_cap"
    | "bad_shape"
    | "unknown_sku"
    | "duplicate_sku"
    | "missing_sku"
    | "too_long"
    | "empty"
    | "leak_hex"
    | "leak_biometric"
    | "leak_photo"
    | "leak_url"
    | "foreign_reference"
    /** A request without a try-on: the text mentions undertone, skin, face shape, a try-on or estimates. */
    | "leak_tryon"
    /** Written in another script than the report language (e.g. English for a Japanese report). */
    | "wrong_language";
  detail?: string;
}

export interface ExplainResult {
  results: FitResult[];
  source: ExplanationSource;
  model?: string;
  issues: ExplainIssue[];
}

// ---------------------------------------------------------------- input side

const UNSAFE_INPUT = [/#[0-9a-f]{3,8}\b/i, /https?:\/\//i, /\bwww\./i, /\b[Lab]\*/, /\bdata:image/i, /\.(png|jpe?g|webp|gif)\b/i];

/** Builds the model input from scored SKUs. Throws if any label could carry recipient data. */
export function buildExplainInput(scored: readonly (ScoredSku & { category: JewelryCategory })[], opts: { noTryOn?: boolean } = {}): ExplainRequest {
  const items = scored.map((s) => ({
    skuId: s.skuId,
    score: s.score,
    category: s.category,
    breakdown: { ...s.breakdown },
    signals: s.signals.map((g) => g.label),
    ...(s.tryOn === false ? { tryOn: false as const } : {}),
  }));
  for (const it of items) {
    for (const label of it.signals) {
      if (UNSAFE_INPUT.some((re) => re.test(label))) throw new Error(`explain input label is not giver-safe: ${label}`);
    }
  }
  for (const it of items) {
    if (!opts.noTryOn && it.tryOn !== false) continue;
    for (const label of it.signals) if (NO_TRYON_WORDS.test(label)) throw new Error(`explain input label mentions a try-on: ${label}`);
  }
  if (opts.noTryOn) return { tryOn: false, items: items.map(({ tryOn: _t, ...it }) => it) }; // eslint-disable-line @typescript-eslint/no-unused-vars
  return { items };
}

/** Strict JSON schema for structured output; skuId is restricted to the scored ids. */
export function explainSchema(skuIds: readonly string[]): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["skuId", "reason1", "reason2", "caution"],
          properties: {
            skuId: { type: "string", enum: [...skuIds] },
            reason1: { type: "string", description: "Why this piece fits, at most 20 words, from the signals only." },
            reason2: { type: "string", description: "A second, different reason, at most 20 words, from the signals only." },
            caution: { type: "string", description: "One caution or caveat, at most 20 words, from the signals only." },
          },
        },
      },
    },
  };
}

export const EXPLAIN_SYSTEM = [
  "You write short Fit Report notes for someone choosing a jewelry gift for another person.",
  "For every item in the input, write two reasons and one caution, each at most 20 words, in plain English.",
  "Use only the facts in that item's `signals` and `score`. Refer to the item as 'this piece'; never name products, brands or ids.",
  "Never mention or speculate about photos, selfies, images, skin colour values, hex codes, colour numbers, measurements, ratios or confidence numbers.",
  "Undertone and face shape are estimates: say 'estimate' when you use them. Refer to the recipient as 'they' (gender-neutral); recipients can be anyone.",
  "If a signal says 'not hearted' or 'low-confidence', use it as the caution. Otherwise caution that the try-on is an AI preview.",
  "An item with `tryOn: false` was NOT tried on (only its product photo was seen): for that item never mention try-ons, previews, photos, undertone, skin, face shape or estimates, and caution to check the size before buying.",
].join(" ");

/** System prompt for a request without a try-on: no undertone, face shape or try-on exists to talk about. */
export const EXPLAIN_SYSTEM_NO_TRYON = [
  "You write short Fit Report notes for someone choosing a jewelry gift for another person.",
  "For every item in the input, write two reasons and one caution, each at most 20 words, in plain English.",
  "Use only the facts in that item's `signals` and `score`. Refer to the item as 'this piece'; never name products, brands or ids.",
  "The recipient only looked at the store's product photos and hearted favourites: there was no try-on, no photo of them and no estimate of their undertone, skin or face shape.",
  "Never mention try-ons, previews, photos, selfies, undertone, skin, complexion, face shape or estimates. A metal is a fact about the piece, never a recommendation for them.",
  "Refer to the recipient as 'they' (gender-neutral). If a signal says 'not hearted', use it as the caution; otherwise caution to check the size before buying.",
].join(" ");

/**
 * English words that must never appear in giver-facing text for a request without a try-on (reasons,
 * cautions, explanations, taste summary). Also the guard test's word list. Every other UI language has its
 * own list (./guardWords NO_TRYON_WORDS_BY_LOCALE); `checkText` applies all of them.
 */
export const NO_TRYON_WORDS = NO_TRYON_WORDS_EN;

/**
 * The system prompt for a report language other than English: same rules, written in that language,
 * JSON shape unchanged. Japanese, Chinese and Thai get a character budget for "20 words".
 */
export function localizeSystem(system: string, language?: { code: string; name: string }, maxWords = MAX_WORDS): string {
  if (!language || language.code === "en") return system;
  const perWord = language.code === "ja" || language.code === "zh" ? 2.5 : language.code === "th" ? 5 : 0;
  const chars = perWord ? ` (about ${Math.round(maxWords * perWord)} characters)` : "";
  return [
    system.replace("in plain English", `in plain ${language.name}`).replace("plain-English", `plain ${language.name}`),
    `Write all text in ${language.name} (BCP-47 "${language.code}"); each text at most ${maxWords} words${chars}.`,
    "The input labels are English: convey their meaning in that language, never copy English words.",
    "Keep the JSON keys and any id values exactly as given.",
  ].join(" ");
}

// ---------------------------------------------------------------- Anthropic client

/** Output budget: ~150 tokens per item (three ≤ 20-word strings plus JSON), no extended thinking. */
export const explainMaxTokens = (items: number) => Math.min(1600, 200 + 150 * Math.max(1, items));

/**
 * Real client: DEFAULT_CLAUDE_MODEL with structured outputs (forced tool_choice is not available on
 * Sonnet 5.5), the system prompt cached, and the daily spend cap around every call.
 */
export class AnthropicExplainClient implements ExplainClient {
  readonly model: string;

  constructor(
    private readonly client: MessagesLike,
    private readonly opts: { model?: string; reserve?: ReserveFn } = {},
  ) {
    this.model = opts.model ?? EXPLAIN_MODEL;
  }

  async explain(request: ExplainRequest, schema: Record<string, unknown>): Promise<unknown> {
    const { language, ...input } = request;
    const system = localizeSystem(request.tryOn === false ? EXPLAIN_SYSTEM_NO_TRYON : EXPLAIN_SYSTEM, language);
    const out = await callClaudeJson(
      this.client,
      // Non-Latin scripts take more tokens per word: a third more room for them.
      { system, user: JSON.stringify(input), schema, maxTokens: Math.round(explainMaxTokens(request.items.length) * (language && /^(ja|zh|ko|th)$/.test(language.code) ? 1.35 : 1)) },
      { model: this.model, reserve: this.opts.reserve },
    );
    return out.data;
  }
}

/** Returns the real client when ANTHROPIC_API_KEY is set, else null (template mode). */
export function createExplainClient(env: Record<string, string | undefined> = process.env): ExplainClient | null {
  const client = anthropicFromEnv(env);
  return client ? new AnthropicExplainClient(client) : null;
}

// ---------------------------------------------------------------- output validation

export const LEAKS: { code: ExplainIssue["code"]; re: RegExp }[] = [
  { code: "leak_hex", re: /#[0-9a-f]{3,8}\b/i },
  { code: "leak_hex", re: /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{6}\b/i },
  { code: "leak_hex", re: /\b(hex|rgb|hsl)\b/i },
  { code: "leak_biometric", re: /\bcie ?lab\b|\blab (values?|numbers?|colou?rs?)\b|\b[Lab]\s*\*|\b[Lab]\s*[=:]\s*-?\d/i },
  { code: "leak_biometric", re: /\bhue( angle)?\b|\bchroma\b|\bdegrees?\b|°/i },
  { code: "leak_biometric", re: /\b(ratio|cheekbones?|eye distance|nose width|jaw ?width|face width|landmarks?|biometric\w*)\b/i },
  { code: "leak_biometric", re: /\d+(\.\d+)?\s*%|\bconfidence (of|is|=|:)?\s*\d|\b0\.\d+\b/i },
  { code: "leak_biometric", re: /\bfitzpatrick\b|\bskin (colou?r|tone) (value|code|number)s?\b/i },
  { code: "leak_photo", re: /\b(photos?|photograph\w*|selfies?|images?|pictures?|pics?|camera|video|snapshot)\b/i },
  { code: "leak_url", re: /https?:\/\/|\bwww\.|\.(com|net|io|png|jpe?g|webp)\b/i },
];

/** Words in a text (whitespace tokens; Japanese, Chinese and Thai by characters: ./guardWords). */
export const wordCount = countWords;

/** The word limit as whitespace tokens: Vietnamese writes every syllable apart, so it gets half as many again. */
export const maxWordsFor = (words: number, locale?: Locale) => (locale === "vi" ? Math.round(words * 1.5) : words);

export interface ValidationContext {
  /** Ids that were scored and sent to the model. */
  allowedIds: readonly string[];
  /** Every catalog id and title known to the server, to catch references to other products. */
  catalog?: readonly { id: string; title: string }[];
  /** No try-on happened: reject any mention of undertone, face shape, skin, photos or a try-on. */
  noTryOn?: boolean;
  /** The report language the text must be written in (absent: not checked). */
  locale?: Locale;
}

/** Returns the issues for one text; empty when the text is safe, grounded and short enough. */
export function checkText(text: unknown, skuId: string, ctx: ValidationContext): ExplainIssue["code"][] {
  if (typeof text !== "string" || text.trim() === "") return ["empty"];
  const codes = new Set<ExplainIssue["code"]>();
  if (wordCount(text) > maxWordsFor(MAX_WORDS, ctx.locale)) codes.add("too_long");
  for (const { code, re } of LEAKS) if (re.test(text)) codes.add(code);
  // The same checks in every UI language (lib/fit/guardWords.ts).
  if (mentionsPhoto(text)) codes.add("leak_photo");
  if (mentionsBiometric(text)) codes.add("leak_biometric");
  if (ctx.noTryOn && mentionsTryOn(text)) codes.add("leak_tryon");
  if (ctx.locale && wrongScript(text, ctx.locale)) codes.add("wrong_language");
  const lower = text.toLowerCase();
  for (const id of ctx.allowedIds) if (id !== skuId && id.length >= 3 && lower.includes(id.toLowerCase())) codes.add("foreign_reference");
  for (const c of ctx.catalog ?? []) {
    if (c.id === skuId) continue;
    if (c.id.length >= 3 && lower.includes(c.id.toLowerCase())) codes.add("foreign_reference");
    if (c.title.length >= 4 && lower.includes(c.title.toLowerCase())) codes.add("foreign_reference");
  }
  // Generic id shapes (uuid, sku-123) that are not this SKU's own id.
  const idLike = text.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b[a-z]{2,}[-_]\d{2,}\b/gi) ?? [];
  if (idLike.some((m) => m.toLowerCase() !== skuId.toLowerCase())) codes.add("foreign_reference");
  return [...codes];
}

/**
 * Validates raw model output against the scored SKUs and repairs it: every slot that fails any
 * check is replaced by the deterministic template text. Ids the model invented are dropped;
 * missing SKUs fall back to the template entirely.
 */
export function validateExplanation(
  raw: unknown,
  scored: readonly ScoredSku[],
  ctx: Omit<ValidationContext, "allowedIds"> = {},
): { results: FitResult[]; issues: ExplainIssue[]; repaired: boolean } {
  const issues: ExplainIssue[] = [];
  const allowedIds = scored.map((s) => s.skuId);
  const vctx: ValidationContext = { allowedIds, catalog: ctx.catalog, noTryOn: ctx.noTryOn, ...(ctx.locale ? { locale: ctx.locale } : {}) };
  const items = (raw as { items?: unknown })?.items;
  const byId = new Map<string, Record<string, unknown>>();
  if (!Array.isArray(items)) {
    issues.push({ field: "items", code: "bad_shape" });
  } else {
    for (const it of items) {
      const rec = it as Record<string, unknown>;
      const id = typeof rec?.skuId === "string" ? rec.skuId : "";
      if (!allowedIds.includes(id)) {
        issues.push({ code: "unknown_sku", detail: id.slice(0, 64) });
        continue;
      }
      if (byId.has(id)) {
        issues.push({ skuId: id, code: "duplicate_sku" });
        continue;
      }
      byId.set(id, rec);
    }
  }

  const results = scored.map((s) => {
    const base = toFitResult(s);
    const rec = byId.get(s.skuId);
    if (!rec) {
      if (Array.isArray(items)) issues.push({ skuId: s.skuId, code: "missing_sku" });
      return base;
    }
    // A16 mixed set: a piece that was not tried on gets the no-try-on word guard on its own.
    const itemNoTryOn = Boolean(ctx.noTryOn) || s.tryOn === false;
    const ictx = itemNoTryOn === Boolean(vctx.noTryOn) ? vctx : { ...vctx, noTryOn: itemNoTryOn };
    // The template is already in the report language (scored with FitContext.locale).
    const fallback = { reason1: base.reasons[0], reason2: base.reasons[1], caution: base.caution ?? genericCaution(ctx.locale, itemNoTryOn) };
    const out: Record<"reason1" | "reason2" | "caution", string> = { ...fallback };
    for (const field of ["reason1", "reason2", "caution"] as const) {
      const codes = checkText(rec[field], s.skuId, ictx);
      if (codes.length === 0) out[field] = (rec[field] as string).trim();
      else for (const code of codes) issues.push({ skuId: s.skuId, field, code });
    }
    return { ...base, reasons: [out.reason1, out.reason2], caution: out.caution };
  });
  return { results, issues, repaired: issues.length > 0 };
}

/** Template-only explanation (no model). */
export function templateExplanation(scored: readonly ScoredSku[]): FitResult[] {
  return scored.map(toFitResult);
}

/**
 * Explains scored SKUs. Uses the client when given, validates and repairs its output, and falls
 * back to templates on any error. Never throws for model failures.
 */
export async function explainFit(
  scored: readonly (ScoredSku & { category: JewelryCategory })[],
  {
    client,
    catalog,
    noTryOn = false,
    locale,
  }: {
    client: ExplainClient | null;
    catalog?: readonly { id: string; title: string }[];
    noTryOn?: boolean;
    /** The giver's report language; `scored` must have been scored with the same FitContext.locale. */
    locale?: Locale;
  },
): Promise<ExplainResult> {
  if (!client) return { results: templateExplanation(scored), source: "template", issues: [{ code: "no_client" }] };
  if (scored.length === 0) return { results: [], source: "template", issues: [] };
  const input = buildExplainInput(scored, { noTryOn });
  if (locale && locale !== "en") input.language = reportLanguage(locale);
  let raw: unknown;
  try {
    raw = await client.explain(input, explainSchema(input.items.map((i) => i.skuId)));
  } catch (err) {
    return {
      results: templateExplanation(scored),
      source: "template",
      model: client.model,
      issues: [err instanceof ClaudeSpendRefused ? { code: "spend_cap", detail: err.reason } : { code: "client_error", detail: (err as Error).message.slice(0, 200) }],
    };
  }
  const v = validateExplanation(raw, scored, { catalog, noTryOn, ...(locale ? { locale } : {}) });
  const usable = !v.issues.some((i) => i.code === "bad_shape");
  return {
    results: v.results,
    source: !usable ? "template" : v.repaired ? "llm_repaired" : "llm",
    model: client.model,
    issues: v.issues,
  };
}

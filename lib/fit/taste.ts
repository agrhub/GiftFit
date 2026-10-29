/**
 * "Help me choose" Fit Report extras (ADR-045): a taste summary from the hearts and 2–3 similar
 * catalog designs the recipient did NOT see ("not tried on"), so the giver can buy something that
 * matches their taste and still surprise them.
 *
 * Privacy: both are built from CATALOG attributes of the hearted designs (style family, category,
 * silhouette bucket, hearted metal) and coarse counts (hearted k of n, wished count). Nothing about
 * the recipient's face, photo, colours, undertone or confidence enters either the template or the
 * Claude prompt (`buildTasteInput` is the only input builder; tests pin its keys).
 */
import { type GiverReportStatus, STYLE_FAMILIES, type StyleFamily } from "@/lib/contracts/api";
import type { CatalogSku, JewelryCategory, Metal } from "@/lib/contracts/giftfit";
import { type MessagesLike, type ReserveFn, ClaudeSpendRefused, anthropicFromEnv, callClaudeJson } from "./claude";
import { SILHOUETTE_LABEL, allowedGenders, bucketsOf, priceFit, styleFamilyOf } from "./curate";
import { type GenderPresentation, genderOf } from "./decoys";
import { DEFAULT_CLAUDE_MODEL } from "@/lib/anthropic/budget";
import type { Locale } from "@/lib/i18n";
import { type ReportMessageKey, joinSentences, listOf, reportLanguage, rs, rt } from "@/lib/i18n/report";
import { LEAKS, localizeSystem, maxWordsFor, wordCount } from "./explain";
import { mentionsBiometric, mentionsPhoto, mentionsTryOn, wrongScript } from "./guardWords";
import { seededKey } from "./rng";
import { type VariantRequest, defaultVariant, eligibleVariants } from "./variants";

export type TasteSummary = NonNullable<GiverReportStatus["tasteSummary"]>;
export type NotTriedPick = NonNullable<GiverReportStatus["similarNotTried"]>[number];

/** One hearted design as the taste summary sees it: catalog attributes only. */
export interface TasteItem {
  category: JewelryCategory;
  style: string;
  silhouette: string;
  metal: Metal;
}

/** Everything the taste summary (template or Claude) may use. */
export interface TasteInput {
  shownCount: number;
  heartedCount: number;
  wishedCount: number;
  hearted: TasteItem[];
}

/** A hearted design in the metal it was hearted in. */
export interface HeartedDesign {
  sku: CatalogSku;
  metal: Metal;
}

export function buildTasteInput(hearted: readonly HeartedDesign[], shownCount: number, wishedCount: number): TasteInput {
  return {
    shownCount,
    heartedCount: hearted.length,
    wishedCount,
    hearted: hearted.map(({ sku, metal }) => {
      const b = bucketsOf(sku, { metal });
      return { category: b.category, style: b.style, silhouette: b.silhouette, metal };
    }),
  };
}

/** Values by frequency (ties in first-seen order), at most `n`. */
function top<T>(xs: readonly T[], n: number): T[] {
  const counts = new Map<T, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([x]) => x);
}

/** A silhouette bucket's words in the report language (SILHOUETTE_LABEL keys), else the category word. */
function silhouetteText(locale: Locale, h: TasteItem): string {
  const key = `silhouette.${h.silhouette}` as ReportMessageKey;
  return h.silhouette in SILHOUETTE_LABEL ? rt(locale, key) : rt(locale, `category.${h.category}`);
}

/** A style family word in the report language (a free-form style word stays as the catalog wrote it). */
function styleWord(locale: Locale, style: string): string {
  return (STYLE_FAMILIES as readonly string[]).includes(style) ? rt(locale, `styleFamily.${style as StyleFamily}`) : style;
}

/** Deterministic taste summary (≤ ~45 words), in the giver's report language (English when absent). */
export function templateTasteSummary(t: TasteInput, opts: { noTryOn?: boolean; locale?: Locale } = {}): string {
  const loc = opts.locale ?? "en";
  if (t.heartedCount === 0) {
    return joinSentences(loc, [
      rs(loc, "taste.none", { shown: t.shownCount }),
      ...(t.wishedCount > 0 ? [rs(loc, "taste.noneWish")] : []),
      rs(loc, opts.noTryOn ? "taste.restBudget" : "taste.restRules"),
    ]);
  }
  const styles = top(
    t.hearted.map((h) => h.style).filter((s) => s !== "other"),
    2,
  ).map((s) => styleWord(loc, s));
  const metals = top(
    t.hearted.map((h) => rt(loc, `metalText.${h.metal}`)),
    2,
  );
  const shapes = top(
    t.hearted.map((h) => silhouetteText(loc, h)),
    2,
  );
  const vars = { styles: listOf(loc, styles), metals: listOf(loc, metals), shapes: listOf(loc, shapes) };
  const parts = [rs(loc, "taste.count", { hearted: t.heartedCount, shown: t.shownCount }), rs(loc, styles.length ? "taste.lean" : "taste.leanNoStyle", vars)];
  if (t.wishedCount > 0) parts.push(rs(loc, "taste.wish"));
  return joinSentences(loc, parts);
}

// ---------------------------------------------------------------- Claude

export const TASTE_MAX_WORDS = 45;
export const TASTE_MAX_TOKENS = 220;

export const TASTE_SYSTEM = [
  "You write a short taste summary for someone choosing a jewelry gift for another person.",
  "The input lists only catalog attributes (category, style family, silhouette, metal) of the pieces the recipient hearted, and how many pieces they saw, hearted and wished came in another metal.",
  `Write one or two plain-English sentences, at most ${TASTE_MAX_WORDS} words, describing the style, metal and shapes their hearts lean towards.`,
  "Use only the input. Refer to the recipient as 'they' (gender-neutral). Never name products, brands or ids.",
  "Never mention or speculate about photos, images, faces, skin, undertone, colouring, measurements, numbers other than the counts, or confidence.",
  "If they hearted nothing, say there is no clear taste signal yet.",
].join(" ");

export const TASTE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["summary"],
  properties: { summary: { type: "string", description: `Taste summary, at most ${TASTE_MAX_WORDS} words.` } },
};

export interface TasteClient {
  readonly model: string;
  /** `language`: the giver's report language when not English (the summary is written in it). */
  summarize(input: TasteInput, language?: { code: string; name: string }): Promise<unknown>;
}

export class AnthropicTasteClient implements TasteClient {
  readonly model: string;

  constructor(
    private readonly client: MessagesLike,
    private readonly opts: { model?: string; reserve?: ReserveFn } = {},
  ) {
    this.model = opts.model ?? DEFAULT_CLAUDE_MODEL;
  }

  async summarize(input: TasteInput, language?: { code: string; name: string }): Promise<unknown> {
    const system = localizeSystem(TASTE_SYSTEM, language, TASTE_MAX_WORDS);
    const maxTokens = language && /^(ja|zh|ko|th)$/.test(language.code) ? Math.round(TASTE_MAX_TOKENS * 1.35) : TASTE_MAX_TOKENS;
    const out = await callClaudeJson(this.client, { system, user: JSON.stringify(input), schema: TASTE_SCHEMA, maxTokens }, { model: this.model, reserve: this.opts.reserve });
    return out.data;
  }
}

export function createTasteClient(env: Record<string, string | undefined> = process.env): TasteClient | null {
  const client = anthropicFromEnv(env);
  return client ? new AnthropicTasteClient(client) : null;
}

/** Recipient-side words a taste summary must never contain (the input never carries them). */
const TASTE_EXTRA = /\b(undertones?|skin|complexion|face|faces|facial|selfie|warm|cool|tan|pale|try[- ]?ons?|tried (it |them )?on|trying on|estimates?d?)\b/i;

/**
 * Issues with a model-written summary; empty = usable. The undertone, skin, face, estimate, try-on, photo
 * and measurement words are checked in every UI language (lib/fit/guardWords.ts); warm / cool / tan / pale
 * only in English, since their translations are ordinary metal words elsewhere.
 */
export function checkTasteText(text: unknown, catalog: readonly { id: string; title: string }[] = [], locale?: Locale): string[] {
  if (typeof text !== "string" || text.trim() === "") return ["empty"];
  const codes = new Set<string>();
  if (wordCount(text) > maxWordsFor(TASTE_MAX_WORDS, locale)) codes.add("too_long");
  for (const { code, re } of LEAKS) if (re.test(text)) codes.add(code);
  if (mentionsPhoto(text)) codes.add("leak_photo");
  if (mentionsBiometric(text)) codes.add("leak_biometric");
  if (TASTE_EXTRA.test(text) || mentionsTryOn(text)) codes.add("leak_recipient");
  if (locale && wrongScript(text, locale)) codes.add("wrong_language");
  const lower = text.toLowerCase();
  for (const c of catalog) {
    if ((c.id.length >= 3 && lower.includes(c.id.toLowerCase())) || (c.title.length >= 4 && lower.includes(c.title.toLowerCase()))) {
      codes.add("foreign_reference");
      break;
    }
  }
  return [...codes];
}

export interface TasteSummaryResult {
  summary: TasteSummary;
  model?: string;
  issue?: string;
}

/** Claude when a client is given and its output passes the checks; the template otherwise. Never throws. */
export async function tasteSummary(
  input: TasteInput,
  {
    client,
    catalog,
    noTryOn = false,
    locale,
  }: { client: TasteClient | null; catalog?: readonly { id: string; title: string }[]; noTryOn?: boolean; /** The giver's report language (absent = English). */ locale?: Locale },
): Promise<TasteSummaryResult> {
  const template: TasteSummary = { text: templateTasteSummary(input, { noTryOn, locale }), source: "template" };
  if (!client) return { summary: template, issue: "no_client" };
  if (input.heartedCount === 0) return { summary: template, issue: "no_hearts" };
  let raw: unknown;
  try {
    raw = await (locale && locale !== "en" ? client.summarize(input, reportLanguage(locale)) : client.summarize(input));
  } catch (err) {
    return { summary: template, model: client.model, issue: err instanceof ClaudeSpendRefused ? "spend_cap" : "client_error" };
  }
  const text = (raw as { summary?: unknown })?.summary;
  const issues = checkTasteText(text, catalog, locale);
  if (issues.length > 0) return { summary: template, model: client.model, issue: issues.join(",") };
  return { summary: { text: (text as string).trim(), source: "claude" }, model: client.model };
}

// ---------------------------------------------------------------- similar, not tried on

export interface SimilarOptions {
  request: VariantRequest;
  /** Every design the recipient saw (never suggested again). */
  shownIds: readonly string[];
  genderPresentation?: GenderPresentation;
  seed: string;
  /** 2–3. */
  count?: number;
}

/**
 * Up to `count` (3) catalog designs the recipient did NOT see that match the hearted taste, within the
 * cap and lock (an eligible variant exists) and the gender presentation. Score per design:
 *   2·[style family hearted] + 2·[silhouette hearted] + 1·[category hearted] + 1·[a hearted metal is eligible]
 *   + 0.5·price fit + 0.1·seeded key, minus 1.5 per already-chosen design with the same silhouette.
 * A design needs ≥ 3 points (e.g. same silhouette and category); if fewer than 2 qualify, ≥ 2.
 * The variant offered is a hearted metal when eligible, else the default eligible variant.
 */
export function similarNotTried(catalog: readonly CatalogSku[], hearted: readonly HeartedDesign[], opts: SimilarOptions): NotTriedPick[] {
  if (hearted.length === 0) return [];
  const count = opts.count ?? 3;
  const shown = new Set(opts.shownIds);
  const styles = new Set(hearted.map((h) => styleFamilyOf(h.sku)));
  const silhouettes = new Set(hearted.map((h) => bucketsOf(h.sku, h).silhouette));
  const cats = new Set(hearted.map((h) => h.sku.category));
  const metals = new Set(hearted.map((h) => h.metal));
  const allowed = allowedGenders(opts.genderPresentation);

  const cands = catalog.flatMap((sku) => {
    if (shown.has(sku.id)) return [];
    if (allowed && !allowed.has(genderOf(sku))) return [];
    const eligible = eligibleVariants(sku, opts.request);
    if (eligible.length === 0) return [];
    const metalMatch = eligible.find((v) => metals.has(v.metal));
    const variant = metalMatch ?? defaultVariant(sku, opts.request)!;
    const silhouette = bucketsOf(sku, variant).silhouette;
    const base =
      2 * Number(styles.has(styleFamilyOf(sku))) + 2 * Number(silhouettes.has(silhouette)) + Number(cats.has(sku.category)) + Number(Boolean(metalMatch));
    return [{ sku, variant, silhouette, base, tie: 0.5 * priceFit(variant.price, opts.request.budgetMax) + 0.1 * seededKey(`${opts.seed}:similar`, sku.id) }];
  });

  const pickWith = (min: number) => {
    const out: typeof cands = [];
    const pool = cands.filter((c) => c.base >= min);
    while (out.length < count && pool.length > 0) {
      const score = (c: (typeof cands)[number]) => c.base + c.tie - 1.5 * out.filter((o) => o.silhouette === c.silhouette).length;
      let best = pool[0];
      for (const c of pool) if (score(c) > score(best) + 1e-12 || (Math.abs(score(c) - score(best)) <= 1e-12 && c.sku.id < best.sku.id)) best = c;
      out.push(best);
      pool.splice(pool.indexOf(best), 1);
    }
    return out;
  };
  let chosen = pickWith(3);
  if (chosen.length < 2) chosen = pickWith(2);
  return chosen.map((c) => ({ catalogId: c.sku.id, variantId: c.variant.variantId, price: c.variant.price, currency: c.sku.currency, label: "not tried on" as const }));
}

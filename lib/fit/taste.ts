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
import type { GiverReportStatus } from "@/lib/contracts/api";
import type { CatalogSku, JewelryCategory, Metal } from "@/lib/contracts/giftfit";
import { type MessagesLike, type ReserveFn, ClaudeSpendRefused, anthropicFromEnv, callClaudeJson } from "./claude";
import { SILHOUETTE_LABEL, allowedGenders, bucketsOf, priceFit, styleFamilyOf } from "./curate";
import { type GenderPresentation, genderOf } from "./decoys";
import { DEFAULT_CLAUDE_MODEL } from "@/lib/anthropic/budget";
import { CATEGORY_LABEL, METAL_LABEL } from "./labels";
import { LEAKS, wordCount } from "./explain";
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

const list = (xs: readonly string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** Deterministic taste summary (≤ ~45 words). */
export function templateTasteSummary(t: TasteInput): string {
  if (t.heartedCount === 0) {
    const wish = t.wishedCount > 0 ? " They did love a style but wished it came in another metal." : "";
    return `They didn't heart any of the ${t.shownCount} pieces, so there is no clear taste signal yet.${wish} The ranking below rests on styling rules.`;
  }
  const styles = top(
    t.hearted.map((h) => h.style).filter((s) => s !== "other"),
    2,
  );
  const metals = top(
    t.hearted.map((h) => METAL_LABEL[h.metal]),
    2,
  );
  const shapes = top(
    t.hearted.map((h) => SILHOUETTE_LABEL[h.silhouette] ?? CATEGORY_LABEL[h.category]),
    2,
  );
  const parts = [`They hearted ${t.heartedCount} of ${t.shownCount} pieces.`];
  const lean = styles.length ? `Their hearts lean ${list(styles)}` : "Their hearts";
  parts.push(`${lean}, mostly in ${list(metals)}, with a liking for ${list(shapes)}.`);
  if (t.wishedCount > 0) parts.push("They also loved a style but wished for another metal.");
  return parts.join(" ");
}

// ---------------------------------------------------------------- Claude

export const TASTE_MAX_WORDS = 45;
export const TASTE_MAX_TOKENS = 220;

export const TASTE_SYSTEM = [
  "You write a short taste summary for someone choosing a jewelry gift for another person.",
  "The input lists only catalog attributes (category, style family, silhouette, metal) of the pieces the recipient hearted during a private try-on, and how many pieces they saw, hearted and wished came in another metal.",
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
  summarize(input: TasteInput): Promise<unknown>;
}

export class AnthropicTasteClient implements TasteClient {
  readonly model: string;

  constructor(
    private readonly client: MessagesLike,
    private readonly opts: { model?: string; reserve?: ReserveFn } = {},
  ) {
    this.model = opts.model ?? DEFAULT_CLAUDE_MODEL;
  }

  async summarize(input: TasteInput): Promise<unknown> {
    const out = await callClaudeJson(this.client, { system: TASTE_SYSTEM, user: JSON.stringify(input), schema: TASTE_SCHEMA, maxTokens: TASTE_MAX_TOKENS }, { model: this.model, reserve: this.opts.reserve });
    return out.data;
  }
}

export function createTasteClient(env: Record<string, string | undefined> = process.env): TasteClient | null {
  const client = anthropicFromEnv(env);
  return client ? new AnthropicTasteClient(client) : null;
}

/** Recipient-side words a taste summary must never contain (the input never carries them). */
const TASTE_EXTRA = /\b(undertones?|skin|complexion|face|faces|facial|selfie|warm|cool|tan|pale)\b/i;

/** Issues with a model-written summary; empty = usable. */
export function checkTasteText(text: unknown, catalog: readonly { id: string; title: string }[] = []): string[] {
  if (typeof text !== "string" || text.trim() === "") return ["empty"];
  const codes = new Set<string>();
  if (wordCount(text) > TASTE_MAX_WORDS) codes.add("too_long");
  for (const { code, re } of LEAKS) if (re.test(text)) codes.add(code);
  if (TASTE_EXTRA.test(text)) codes.add("leak_recipient");
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
export async function tasteSummary(input: TasteInput, { client, catalog }: { client: TasteClient | null; catalog?: readonly { id: string; title: string }[] }): Promise<TasteSummaryResult> {
  const template: TasteSummary = { text: templateTasteSummary(input), source: "template" };
  if (!client) return { summary: template, issue: "no_client" };
  if (input.heartedCount === 0) return { summary: template, issue: "no_hearts" };
  let raw: unknown;
  try {
    raw = await client.summarize(input);
  } catch (err) {
    return { summary: template, model: client.model, issue: err instanceof ClaudeSpendRefused ? "spend_cap" : "client_error" };
  }
  const text = (raw as { summary?: unknown })?.summary;
  const issues = checkTasteText(text, catalog);
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

/**
 * One budgeted Claude call for the Fit Engine (ADR-040): explanations (explain.ts) and the taste
 * summary (taste.ts). Every call goes reserveClaudeSpend → messages.create → settle(usage), so the
 * shared daily cap (server/anthropic/budget.ts) holds; a refusal throws `ClaudeSpendRefused` and the
 * caller falls back to its template.
 *
 * Request shape (claude-api reference, Sonnet 5.5): structured output (`output_config.format`),
 * effort "low", thinking `between_tools` (no extended thinking, so max_tokens can stay tight), the
 * stable system prompt as a text block with `cache_control: {type: "ephemeral"}` (it caches only
 * once the prefix passes the model's minimum, 512 tokens on Sonnet 5.5), and server-side refusal
 * fallback (`fallbacks: "default"`).
 */
import Anthropic from "@anthropic-ai/sdk";
import { type ClaudeUsage, DEFAULT_CLAUDE_MODEL, type SpendDecision, reserveClaudeSpend } from "@/server/anthropic/budget";

/** The daily spend cap (or a disabled/unreachable counter) refused the call; nothing was sent. */
export class ClaudeSpendRefused extends Error {
  constructor(readonly reason: string) {
    super(`claude call refused by the spend cap: ${reason}`);
    this.name = "ClaudeSpendRefused";
  }
}

export type ReserveFn = (input: { model: string; inputTokens: number; maxTokens: number }) => Promise<SpendDecision>;

/** The slice of the SDK client we use (tests inject a fake). */
export interface MessagesLike {
  beta: { messages: { create(body: Anthropic.Beta.MessageCreateParamsNonStreaming): Promise<Anthropic.Beta.BetaMessage> } };
}

export interface ClaudeJsonCall {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  maxTokens: number;
}

export interface ClaudeJsonResult {
  data: unknown;
  usage: ClaudeUsage;
  /** The model that answered (a refusal fallback may differ from the requested one). */
  model: string;
}

/** Rough token estimate for the reservation (≈ 3 characters per token; errs high). */
export const estimateTokens = (text: string) => Math.ceil(text.length / 3) + 16;

export function requestBody(model: string, call: ClaudeJsonCall): Anthropic.Beta.MessageCreateParamsNonStreaming {
  return {
    model,
    max_tokens: call.maxTokens,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    // `between_tools` (no extended thinking) is Sonnet 5.5 only; other models run adaptive at low effort.
    ...(model.startsWith("claude-sonnet-5-5") ? { thinking: { type: "between_tools" as const } } : {}),
    output_config: { effort: "low", format: { type: "json_schema", schema: call.schema } },
    system: [{ type: "text", text: call.system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: call.user }],
  };
}

/**
 * Reserve → call → settle. Throws ClaudeSpendRefused (no call made), or an Error on refusal,
 * truncation, bad JSON or API failure (the reservation is settled with whatever usage came back).
 */
export async function callClaudeJson(client: MessagesLike, call: ClaudeJsonCall, opts: { model?: string; reserve?: ReserveFn } = {}): Promise<ClaudeJsonResult> {
  const model = opts.model ?? DEFAULT_CLAUDE_MODEL;
  const inputTokens = estimateTokens(call.system + call.user + JSON.stringify(call.schema));
  const spend = await (opts.reserve ?? ((i) => reserveClaudeSpend(i)))({ model, inputTokens, maxTokens: call.maxTokens });
  if (!spend.ok) throw new ClaudeSpendRefused(spend.reason);
  let usage: ClaudeUsage | null = null;
  try {
    const response = await client.beta.messages.create(requestBody(model, call));
    usage = response.usage;
    if (response.stop_reason === "refusal") throw new Error("model declined");
    if (response.stop_reason === "max_tokens") throw new Error("model output truncated");
    const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    return { data: JSON.parse(text), usage: response.usage, model: response.model };
  } finally {
    await spend.settle(usage);
  }
}

/** SDK client when ANTHROPIC_API_KEY is set, else null (template mode, CI stays keyless). */
export function anthropicFromEnv(env: Record<string, string | undefined> = process.env): Anthropic | null {
  return env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }) : null;
}

/**
 * Gift Concierge engine (owner: A7, ADR-040/046). A Claude tool-use loop that turns a natural-language
 * request (any language) into a grounded DRAFT GiftBrief plus ≤ 3 suggested designs, as a stream of
 * UI-agnostic ConciergeEvents. Server-only.
 *
 *   - Model DEFAULT_CLAUDE_MODEL, thinking only between tools, effort low, max_tokens 600, ≤ 4 calls.
 *   - Prompt caching: system prompt + tool definitions (stable prefix) and the growing tool loop.
 *   - Every call: reserveClaudeSpend → call → settle(usage). Spend cap refused, API error, refusal, or
 *     no key with CONCIERGE_MOCK=0 → deterministic fallback, flagged degraded.
 *   - Mock mode (no key, or CONCIERGE_MOCK=1): replays a recorded fixture through the same loop, tools
 *     and grounding, with no network and no spend.
 */
import Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_CLAUDE_MODEL, reserveClaudeSpend, type ClaudeUsage, type SpendDecision } from "@/lib/anthropic/budget";
import type { GiftBrief } from "@/lib/contracts/api";
import { defaultConciergeCatalog, type ConciergeCatalog } from "./catalog";
import { detectLang, fallbackAnswer, isOffTopic, refusalText } from "./fallback";
import { GroundingLedger, ProseScrubber, scrubProse } from "./grounding";
import { loadFixtures, pickFixture, FixtureClient, type ConciergeFixture } from "./mock";
import { CONCIERGE_SYSTEM_PROMPT } from "./prompt";
import { CONCIERGE_TOOLS, isConciergeTool, runConciergeTool } from "./tools";
import { CONCIERGE_LIMITS, type ConciergeChatMessage, type ConciergeDegradeReason, type ConciergeEvent, type ConciergeSource, type ConciergeSuggestion } from "./types";

type Env = Record<string, string | undefined>;

export const CONCIERGE_MAX_TOKENS = 600;
/** Claude calls per user message (tool iterations + the closing reply). */
export const CONCIERGE_MAX_CALLS = 4;

/** The subset of the SDK's MessageStream the engine uses (the mock implements the same). */
export interface ConciergeLlmStream extends AsyncIterable<Anthropic.MessageStreamEvent> {
  finalMessage(): Promise<Anthropic.Message>;
}

export interface ConciergeLlm {
  stream(params: Anthropic.MessageCreateParamsNonStreaming, opts?: { signal?: AbortSignal }): ConciergeLlmStream;
}

export type Reserve = (input: { model: string; inputTokens: number; maxTokens: number }) => Promise<SpendDecision>;

export interface ConciergeDeps {
  env?: Env;
  catalog?: ConciergeCatalog;
  /** Overrides the client (tests, recording). With `llm` set, mock-mode detection is skipped. */
  llm?: ConciergeLlm;
  /** Source label when `llm` is injected (default "claude"). */
  llmSource?: Exclude<ConciergeSource, "fallback">;
  reserve?: Reserve;
  fixtures?: ConciergeFixture[];
  model?: string;
  maxCalls?: number;
  /** Observes every completed Claude turn (recording script, cost reports). */
  onTurn?: (message: Anthropic.Message) => void;
  signal?: AbortSignal;
}

/** "mock" when CONCIERGE_MOCK=1, or no key unless CONCIERGE_MOCK=0 (then the degraded fallback answers). */
export function conciergeMode(env: Env = process.env): "claude" | "mock" | "no_key" {
  if (env.CONCIERGE_MOCK === "1") return "mock";
  if (!env.ANTHROPIC_API_KEY?.trim()) return env.CONCIERGE_MOCK === "0" ? "no_key" : "mock";
  return "claude";
}

/** Applies the history caps: drops leading assistant turns, keeps the newest ≤ 12 messages and ≤ 6000 chars. */
export function capHistory(messages: readonly ConciergeChatMessage[]): ConciergeChatMessage[] {
  const out: ConciergeChatMessage[] = [];
  let total = 0;
  for (let i = messages.length - 1; i >= 0 && out.length < CONCIERGE_LIMITS.maxMessages; i--) {
    const m = messages[i];
    const content = m.content.slice(0, CONCIERGE_LIMITS.maxMessageChars);
    if (total + content.length > CONCIERGE_LIMITS.maxTotalChars && out.length > 0) break;
    total += content.length;
    out.unshift({ role: m.role, content });
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

function realClient(env: Env): ConciergeLlm {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 25_000 });
  return { stream: (params, opts) => client.messages.stream(params, { signal: opts?.signal }) };
}

const SYSTEM: Anthropic.TextBlockParam[] = [{ type: "text", text: CONCIERGE_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }];

/** Rough token estimate (≈ 3 chars per token, conservative) for the spend reservation. */
export function estimateInputTokens(messages: readonly Anthropic.MessageParam[]): number {
  return Math.ceil((CONCIERGE_SYSTEM_PROMPT.length + JSON.stringify(CONCIERGE_TOOLS).length + JSON.stringify(messages).length) / 3);
}

function closingText(lang: "en" | "vi", hasBrief: boolean): string {
  if (lang === "vi") return hasBrief ? 'Mình đã soạn sẵn yêu cầu quà. Bạn xem lại rồi bấm "Dùng yêu cầu này" nhé.' : "Bạn muốn tặng ai, dịp gì và ngân sách khoảng bao nhiêu?";
  return hasBrief ? 'I\'ve drafted a gift brief. Review it and tap "Use this brief".' : "Who is the gift for, what's the occasion, and what's your budget?";
}

/**
 * Runs one concierge turn. Never throws: failures end in a degraded `final` (or `error` when even the
 * fallback fails). The caller streams the events as NDJSON.
 */
export async function* runConcierge(input: readonly ConciergeChatMessage[], deps: ConciergeDeps = {}): AsyncGenerator<ConciergeEvent> {
  const env = deps.env ?? process.env;
  const catalog = deps.catalog ?? defaultConciergeCatalog();
  const history = capHistory(input);
  const lastUser = [...history].reverse().find((m) => m.role === "user")?.content ?? "";
  const lang = detectLang(lastUser);

  const fallback = function* (reason: ConciergeDegradeReason | undefined, alreadyText: boolean): Generator<ConciergeEvent> {
    const a = fallbackAnswer(history, catalog);
    yield { type: "text", delta: (alreadyText ? "\n\n" : "") + a.text };
    yield {
      type: "final",
      ...(a.brief ? { brief: a.brief } : {}),
      suggestions: a.suggestions,
      source: "fallback",
      degraded: reason !== undefined,
      ...(reason ? { degradeReason: reason } : {}),
      ...(a.notes.length ? { notes: a.notes } : {}),
    };
  };

  try {
    // Code-enforced refusal: obviously off-topic or prompt-steering input never reaches the model.
    if (history.length === 0 || isOffTopic(lastUser)) {
      yield { type: "start", source: "fallback" };
      yield { type: "text", delta: refusalText(lang) };
      yield { type: "final", suggestions: [], source: "fallback", degraded: false };
      return;
    }

    let llm = deps.llm;
    let source: Exclude<ConciergeSource, "fallback"> = deps.llmSource ?? "claude";
    if (!llm) {
      const mode = conciergeMode(env);
      if (mode === "no_key") {
        yield { type: "start", source: "fallback" };
        yield* fallback("no_key", false);
        return;
      }
      if (mode === "mock") {
        const fixture = pickFixture(deps.fixtures ?? loadFixtures(), lastUser);
        if (!fixture) {
          // No recorded conversation resembles this message: answer deterministically (not a failure).
          yield { type: "start", source: "fallback" };
          yield* fallback(undefined, false);
          return;
        }
        llm = new FixtureClient(fixture);
        source = "mock";
      } else {
        llm = realClient(env);
      }
    }
    const spend = source === "mock" ? null : (deps.reserve ?? ((i) => reserveClaudeSpend(i, { env })));
    const model = deps.model ?? DEFAULT_CLAUDE_MODEL;
    const maxCalls = Math.max(1, Math.min(CONCIERGE_MAX_CALLS, deps.maxCalls ?? CONCIERGE_MAX_CALLS));

    yield { type: "start", source };

    const ledger = new GroundingLedger();
    const convo: Anthropic.MessageParam[] = history.map((m) => ({ role: m.role, content: m.content }));
    let draft: { brief: GiftBrief; suggestions: ConciergeSuggestion[] } | undefined;
    let emittedText = false;

    for (let call = 0; call < maxCalls; call++) {
      const last = call === maxCalls - 1;
      const params: Anthropic.MessageCreateParamsNonStreaming = {
        model,
        max_tokens: CONCIERGE_MAX_TOKENS,
        system: SYSTEM,
        tools: CONCIERGE_TOOLS,
        // The final allowed call must answer in prose.
        tool_choice: last ? { type: "none" } : { type: "auto" },
        thinking: { type: "between_tools" },
        output_config: { effort: "low" },
        // Automatic breakpoint on the last block: later iterations of this loop read the earlier ones.
        cache_control: { type: "ephemeral" },
        messages: convo,
      };

      let reservation: Extract<SpendDecision, { ok: true }> | null = null;
      if (spend) {
        const decision = await spend({ model, inputTokens: estimateInputTokens(convo), maxTokens: CONCIERGE_MAX_TOKENS });
        if (!decision.ok) {
          console.warn("[concierge] Claude spend refused:", decision.reason);
          if (draft) break;
          yield* fallback(decision.reason === "disabled" ? "disabled" : "spend_cap", emittedText);
          return;
        }
        reservation = decision;
      }

      const scrubber = new ProseScrubber();
      let turnText = "";
      const usageSeen: { value: ClaudeUsage | null } = { value: null };
      let message: Anthropic.Message;
      try {
        const stream = llm.stream(params, { signal: deps.signal });
        for await (const ev of stream) {
          if (ev.type === "message_start") usageSeen.value = { ...ev.message.usage };
          else if (ev.type === "message_delta" && usageSeen.value) usageSeen.value = { ...usageSeen.value, output_tokens: ev.usage.output_tokens };
          else if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
            const safe = scrubber.push(ev.delta.text);
            if (safe) {
              const prefix = !turnText && emittedText ? "\n\n" : "";
              turnText += safe;
              yield { type: "text", delta: prefix + safe };
            }
          }
        }
        message = await stream.finalMessage();
      } catch (err) {
        // A call that failed mid-stream may still be billed: settle what the stream reported.
        await reservation?.settle(usageSeen.value);
        if (deps.signal?.aborted) return;
        console.error("[concierge] Claude call failed:", err instanceof Anthropic.APIError ? `${err.status} ${err.name}` : (err as Error).name);
        if (draft) break;
        yield* fallback("api_error", emittedText || turnText.length > 0);
        return;
      }
      await reservation?.settle(message.usage);
      deps.onTurn?.(message);

      const tail = scrubber.flush();
      if (tail) {
        const prefix = !turnText && emittedText ? "\n\n" : "";
        turnText += tail;
        yield { type: "text", delta: prefix + tail };
      }
      if (turnText) emittedText = true;

      if (message.stop_reason === "refusal") {
        console.warn("[concierge] model refusal:", message.stop_details?.category ?? "unknown");
        if (draft) break;
        yield* fallback("refusal", emittedText);
        return;
      }

      const toolUses = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      // A tool input cut off at max_tokens can still parse; never run it.
      if (toolUses.length === 0 || message.stop_reason !== "tool_use") break;

      convo.push({ role: "assistant", content: message.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      let createdThisTurn = false;
      for (const use of toolUses) {
        const outcome = isConciergeTool(use.name)
          ? runConciergeTool(use.name, use.input, catalog, ledger)
          : { result: { error: "unknown tool" }, isError: true, summary: "Unknown tool refused" };
        if (isConciergeTool(use.name)) yield { type: "tool", name: use.name, summary: scrubProse(outcome.summary) };
        if ("draft" in outcome && outcome.draft) {
          draft = outcome.draft;
          createdThisTurn = true;
        }
        results.push({ type: "tool_result", tool_use_id: use.id, content: JSON.stringify(outcome.result), ...(outcome.isError ? { is_error: true } : {}) });
      }
      // The reply was written in the same turn as the draft: done, no extra call.
      if (createdThisTurn && turnText) break;
      convo.push({ role: "user", content: results });
    }

    if (!emittedText) yield { type: "text", delta: closingText(lang, Boolean(draft)) };
    yield {
      type: "final",
      ...(draft ? { brief: draft.brief } : {}),
      suggestions: draft?.suggestions ?? [],
      source,
      degraded: false,
    };
  } catch (err) {
    console.error("[concierge] engine failed:", (err as Error).message);
    try {
      yield* fallback("api_error", true);
    } catch {
      yield { type: "error", error: "internal_error" };
    }
  }
}

/** Collects a whole run (tests, scripts). */
export async function collectConcierge(input: readonly ConciergeChatMessage[], deps: ConciergeDeps = {}): Promise<{ events: ConciergeEvent[]; text: string; final?: Extract<ConciergeEvent, { type: "final" }> }> {
  const events: ConciergeEvent[] = [];
  for await (const ev of runConcierge(input, deps)) events.push(ev);
  const text = events.map((e) => (e.type === "text" ? e.delta : "")).join("");
  const final = events.find((e): e is Extract<ConciergeEvent, { type: "final" }> => e.type === "final");
  return { events, text, final };
}

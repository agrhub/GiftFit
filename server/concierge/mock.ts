/**
 * Mock mode for the Gift Concierge (owner: A7): replays a recorded Claude conversation
 * (fixtures/concierge/*.json, recorded with scripts/concierge-record.ts) through the same engine, tools
 * and grounding, so CI and e2e stay keyless. Fixtures hold only the model's turns (text + tool calls)
 * and token usage: no secrets, no personal data, no thinking signatures.
 */
import type Anthropic from "@anthropic-ai/sdk";
import anniversaryEn from "@/fixtures/concierge/anniversary-en.json";
import birthdayVi from "@/fixtures/concierge/birthday-vi.json";
import type { ConciergeLlm, ConciergeLlmStream } from "./engine";
import type { ConciergeChatMessage } from "./types";

export type FixtureBlock = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown };

export interface ConciergeFixture {
  name: string;
  description?: string;
  recordedAt: string;
  model: string;
  /** Keywords that select this fixture for a user message (case-insensitive). */
  match: string[];
  /** The conversation that was recorded (user input only matters for selection). */
  messages: ConciergeChatMessage[];
  turns: Array<{
    content: FixtureBlock[];
    stop_reason: "end_turn" | "tool_use" | "max_tokens" | "refusal" | "stop_sequence" | "pause_turn";
    usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null };
  }>;
}

export function loadFixtures(): ConciergeFixture[] {
  return [anniversaryEn as ConciergeFixture, birthdayVi as ConciergeFixture];
}

const fold = (s: string) => s.normalize("NFC").toLowerCase();

/** The fixture whose keywords best match the message (exact recorded message wins); undefined if none match. */
export function pickFixture(fixtures: readonly ConciergeFixture[], message: string): ConciergeFixture | undefined {
  const m = fold(message).trim();
  let best: { f: ConciergeFixture; score: number } | undefined;
  for (const f of fixtures) {
    const recorded = f.messages.filter((x) => x.role === "user").some((x) => fold(x.content).trim() === m);
    const score = (recorded ? 100 : 0) + f.match.filter((k) => m.includes(fold(k))).length;
    if (score > 0 && (!best || score > best.score)) best = { f, score };
  }
  return best?.f;
}

function toMessage(f: ConciergeFixture, turn: ConciergeFixture["turns"][number], index: number): Anthropic.Message {
  return {
    id: `msg_fixture_${f.name}_${index}`,
    type: "message",
    role: "assistant",
    model: f.model,
    content: turn.content.map((b) => (b.type === "text" ? { type: "text", text: b.text, citations: null } : { type: "tool_use", id: b.id, name: b.name, input: b.input })),
    stop_reason: turn.stop_reason,
    stop_sequence: null,
    usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...turn.usage },
  } as unknown as Anthropic.Message;
}

/** Plays the fixture's turns in order, one per `stream()` call, as real-shaped stream events (text in small deltas). */
export class FixtureClient implements ConciergeLlm {
  private index = 0;
  constructor(private readonly fixture: ConciergeFixture) {}

  stream(): ConciergeLlmStream {
    const f = this.fixture;
    const i = this.index++;
    const turn = f.turns[i] ?? { content: [{ type: "text", text: "" }], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } };
    const message = toMessage(f, turn, i);
    async function* events(): AsyncGenerator<Anthropic.MessageStreamEvent> {
      yield { type: "message_start", message: { ...message, content: [] } } as unknown as Anthropic.MessageStreamEvent;
      // The real event order: each block starts, streams its deltas, stops (text before a tool call included).
      for (const [index, block] of turn.content.entries()) {
        if (block.type === "text") {
          yield { type: "content_block_start", index, content_block: { type: "text", text: "", citations: null } } as unknown as Anthropic.MessageStreamEvent;
          for (let p = 0; p < block.text.length; p += 14) {
            yield { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text.slice(p, p + 14) } } as Anthropic.MessageStreamEvent;
          }
        } else {
          yield { type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } } as unknown as Anthropic.MessageStreamEvent;
          yield { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } } as Anthropic.MessageStreamEvent;
        }
        yield { type: "content_block_stop", index } as Anthropic.MessageStreamEvent;
      }
      yield { type: "message_delta", delta: { stop_reason: turn.stop_reason, stop_sequence: null }, usage: { output_tokens: turn.usage.output_tokens } } as unknown as Anthropic.MessageStreamEvent;
    }
    return { [Symbol.asyncIterator]: events, finalMessage: async () => message };
  }
}

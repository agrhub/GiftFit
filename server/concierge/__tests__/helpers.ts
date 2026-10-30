import type { ConciergeLlm } from "../engine";
import { FixtureClient, type ConciergeFixture, type FixtureBlock } from "../mock";

export type Turn = ConciergeFixture["turns"][number];

export const usage = { input_tokens: 1200, output_tokens: 150, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

export const text = (t: string): FixtureBlock => ({ type: "text", text: t });
export const tool = (id: string, name: string, input: unknown): FixtureBlock => ({ type: "tool_use", id, name, input });

export function turn(content: FixtureBlock[], stop_reason: Turn["stop_reason"] = content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn"): Turn {
  return { content, stop_reason, usage };
}

export function fixture(turns: Turn[], over: Partial<ConciergeFixture> = {}): ConciergeFixture {
  return { name: "test", recordedAt: "test", model: "claude-sonnet-5-5", match: ["gift"], messages: [{ role: "user", content: "a gift" }], turns, ...over };
}

/** A scripted LLM that records the params of every call. */
export function scripted(turns: Turn[]): ConciergeLlm & { calls: Array<Parameters<ConciergeLlm["stream"]>[0]> } {
  const inner = new FixtureClient(fixture(turns));
  const calls: Array<Parameters<ConciergeLlm["stream"]>[0]> = [];
  return {
    calls,
    stream(params) {
      calls.push(structuredClone(params));
      return inner.stream();
    },
  } as ConciergeLlm & { calls: typeof calls };
}

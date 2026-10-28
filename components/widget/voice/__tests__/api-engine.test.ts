/** The server voice's engine header maps to the widget's "AI voice" label (A13, ADR-057). */
import { describe, expect, it } from "vitest";
import { synthesize } from "../api";

const respond = (engine: string, type = "audio/wav") => (async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": type, "x-voice-engine": engine } })) as unknown as typeof fetch;

describe("synthesize(): x-voice-engine", () => {
  it.each([
    ["supertonic-server", "supertonic"],
    ["supertonic", "supertonic"],
    ["google", "google"],
    ["mock", "mock"],
    ["something-else", "google"],
  ])("%s → %s", async (header, engine) => {
    const r = await synthesize("Hello.", "en", { sessionId: "3b241101-e2bb-4255-8caf-4136c566a962", fetchImpl: respond(header) });
    expect(r.engine).toBe(engine);
    expect(r.bytes.byteLength).toBe(3);
  });
});

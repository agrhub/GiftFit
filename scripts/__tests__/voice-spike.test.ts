/** scripts/voice-spike.mjs (A13, ADR-057): its sample set and percentile helper. No network. */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isSupertonicLang, splitSentences } from "@/lib/voice/supertonic/inference";

type Spike = { SENTENCES: Record<string, string[]>; pct(values: number[], p: number): number | null };
const load = async () => (await import(/* @vite-ignore */ pathToFileURL(path.resolve(__dirname, "../voice-spike.mjs")).href)) as Spike;

describe("voice-spike sample sentences", () => {
  it("covers en, vi, ja, es with at least 10 sentences of 40–160 characters, one sentence each", async () => {
    const { SENTENCES } = await load();
    expect(Object.keys(SENTENCES).sort()).toEqual(["en", "es", "ja", "vi"]);
    for (const [lang, list] of Object.entries(SENTENCES)) {
      expect(isSupertonicLang(lang)).toBe(true);
      expect(list.length).toBeGreaterThanOrEqual(10);
      for (const s of list) {
        expect([...s].length, s).toBeGreaterThanOrEqual(40);
        expect([...s].length, s).toBeLessThanOrEqual(160);
        expect(splitSentences(s, lang as never), s).toHaveLength(1);
      }
    }
  });

  it("percentiles", async () => {
    const { pct } = await load();
    expect(pct([], 50)).toBeNull();
    expect(pct([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(pct(Array.from({ length: 20 }, (_, i) => i + 1), 95)).toBe(19);
    expect(pct([1, 2], 100)).toBe(2);
  });
});

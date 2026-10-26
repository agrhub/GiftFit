import { describe, expect, it } from "vitest";
import { chunksForSpeech, cleanForSpeech, sentences, TTS_MAX_CHARS } from "../text";

describe("speech text", () => {
  it("drops links, markdown and emoji", () => {
    expect(cleanForSpeech("**Gold hoops** 💛 see https://shop.example/p/1 and [this](https://x.y)")).toBe("Gold hoops see and this");
  });

  it("splits sentences, Vietnamese included", () => {
    expect(sentences("Hi! How are you? Fine.\nNext line")).toEqual(["Hi!", "How are you?", "Fine.", "Next line"]);
    expect(sentences("Chào bạn! Mình gợi ý ba món.")).toEqual(["Chào bạn!", "Mình gợi ý ba món."]);
  });

  it("chunks at most 400 chars, on sentence boundaries, first sentence alone when long enough", () => {
    const s1 = "Here are three ideas she might love for your anniversary.";
    const filler = Array.from({ length: 20 }, (_, i) => `Option ${i} is a delicate gold piece that suits everyday wear.`).join(" ");
    const chunks = chunksForSpeech(`${s1} ${filler}`);
    expect(chunks[0]).toBe(s1);
    expect(chunks.length).toBeLessThanOrEqual(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(TTS_MAX_CHARS);
    for (const c of chunks.slice(1)) expect(c).toMatch(/\.$/);
  });

  it("hard-splits a sentence longer than the limit on spaces", () => {
    const long = Array.from({ length: 120 }, () => "gold").join(" ");
    const chunks = chunksForSpeech(long, 100, 10);
    expect(chunks.every((c) => c.length <= 100)).toBe(true);
    expect(chunks.join(" ")).toBe(long);
  });

  it("returns nothing for empty or emoji-only text", () => {
    expect(chunksForSpeech("")).toEqual([]);
    expect(chunksForSpeech(" 💛🎁 ")).toEqual([]);
  });
});

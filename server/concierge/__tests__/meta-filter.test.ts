import { describe, expect, it } from "vitest";
import { isMetaSentence, LeadingMetaFilter, stripLeadingMeta } from "../meta-filter";

describe("isMetaSentence", () => {
  it.each([
    "The user wants help choosing, so I'll search for delicate gold earrings and necklaces.",
    "The shopper is looking for a birthday gift.",
    "I'll search the catalog for rings under $200.",
    "I’ll look for minimal pieces.",
    "I will check the budget first.",
    "Let me find a few options.",
    "I'm going to search for necklaces.",
    "First, I'll check which metals fit.",
    "Now I'll draft the brief.",
    "Searching the catalog for earrings.",
    "Calling search_catalog with a $300 cap.",
    "The tool results show nine matches.",
    "Người dùng muốn tặng quà sinh nhật cho mẹ.",
    "Mình sẽ tìm vài mẫu dây chuyền cổ điển.",
  ])("meta: %s", (s) => expect(isMetaSentence(s)).toBe(true));

  it.each([
    "Here are three delicate ideas for your anniversary.",
    "I've drafted a brief for a $300 anniversary gift.",
    "Let me know if you'd like other metals.",
    "These earrings would suit someone who loves minimal pieces.",
    "This tool set is a great gift for a keen gardener.",
    "Searchlight Pendant is a classic choice.",
    "Mình đã soạn sẵn yêu cầu quà cho mẹ.",
    "What budget do you have in mind?",
  ])("not meta: %s", (s) => expect(isMetaSentence(s)).toBe(false));
});

describe("stripLeadingMeta", () => {
  it("drops one or two leading meta sentences and keeps the rest verbatim", () => {
    expect(stripLeadingMeta("The user wants earrings. I'll search for gold ones. Here are two ideas you'll love.")).toBe("Here are two ideas you'll love.");
    expect(stripLeadingMeta("I'll search now.\nHere are two ideas.")).toBe("Here are two ideas.");
  });

  it("leaves normal replies, and meta-looking sentences after the first, untouched", () => {
    const reply = "Here are two ideas. I'll search for more if you like. Let me know!";
    expect(stripLeadingMeta(reply)).toBe(reply);
    expect(stripLeadingMeta("Lovely! The user guide is in the box.")).toBe("Lovely! The user guide is in the box.");
  });

  it("returns empty for an all-meta reply", () => {
    expect(stripLeadingMeta("The user wants a gift.")).toBe("");
    expect(stripLeadingMeta("I'll search the catalog")).toBe("");
  });

  it("does not split on decimals or abbreviations without a space", () => {
    expect(stripLeadingMeta("From $49.50 up, these fit your budget.")).toBe("From $49.50 up, these fit your budget.");
  });
});

describe("LeadingMetaFilter (streaming)", () => {
  const run = (deltas: string[]) => {
    const f = new LeadingMetaFilter();
    const outs = deltas.map((d) => f.push(d));
    outs.push(f.flush());
    return outs;
  };

  it("holds only until the first sentence is complete, then passes deltas through live", () => {
    const outs = run(["Here are ", "two ideas. ", "The first ", "is a ring", "."]);
    expect(outs.join("")).toBe("Here are two ideas. The first is a ring.");
    expect(outs.slice(2, 5)).toEqual(["The first ", "is a ring", "."]);
  });

  it("drops a meta opener split across deltas", () => {
    expect(run(["The us", "er wants rings, so I'", "ll search. ", "Two rings ", "stand out."]).join("")).toBe("Two rings stand out.");
  });

  it("gives up holding after 300 characters without a sentence end", () => {
    const long = "a".repeat(320);
    const outs = run([long, " more"]);
    expect(outs[0]).toBe(long);
    expect(outs.join("")).toBe(`${long} more`);
  });
});

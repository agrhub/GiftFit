import { describe, expect, it } from "vitest";
import { giftfitSnippet, shopifySnippet, tokenizeTag, wordpressSnippet } from "../snippets";

const O = "https://giftfit.example";

describe("snippets", () => {
  it("builds the embed tag with the documented attributes", () => {
    // No language attribute by default: all ten languages, the page's own first.
    expect(giftfitSnippet(O)).toBe(`<script src="${O}/giftfit.js" data-store="aurum" async></script>`);
    expect(giftfitSnippet(O, { langs: "vi", widget: false })).toBe(`<script src="${O}/giftfit.js" data-store="aurum" data-langs="vi" data-widget="off" async></script>`);
    expect(shopifySnippet(O)).toBe(`<script src="${O}/giftfit.js" data-store="aurum" async></script>\n</body>`);
    expect(wordpressSnippet(O)).toContain("add_action( 'wp_footer', function () { ?>");
    expect(wordpressSnippet(O)).toContain(giftfitSnippet(O));
  });

  it("the highlighter keeps every character", () => {
    for (const s of [giftfitSnippet(O), giftfitSnippet(O, { widget: false }), shopifySnippet(O).split("\n")[0]]) {
      const tokens = tokenizeTag(s);
      expect(tokens.map((t) => t.text).join("")).toBe(s);
      expect(tokens.filter((t) => t.kind === "attr").map((t) => t.text)).toContain("data-store");
      expect(tokens.find((t) => t.kind === "tag")?.text).toBe("script");
    }
  });
});

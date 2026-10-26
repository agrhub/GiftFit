// @vitest-environment jsdom
/**
 * The widget e-card: an occasion-aware default message in the card language that follows occasion
 * and language changes until the giver edits it, and a layout that scrolls instead of collapsing the
 * card (jsdom can't measure layout: the classes are asserted; Playwright checks the real height).
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { CreateFitRequestResponse } from "@/lib/contracts/api";
import { OCCASIONS } from "@/lib/contracts/giftfit";
import { t, translator, type MessageKey } from "@/lib/i18n";
import { GiftCardStep } from "../GiftCardStep";

afterEach(cleanup);

const result: CreateFitRequestResponse = {
  fitRequestId: "fr1",
  giverToken: "g".repeat(43),
  recipientPath: `/r/${"r".repeat(43)}`,
  giverReportPath: `/g/${"g".repeat(43)}`,
  expiresAt: new Date(Date.now() + 72 * 3600e3).toISOString(),
  carouselSize: 6,
};

const card = (occasion: string, locale: "en" | "vi" = "en") => <GiftCardStep locale={locale} tr={translator(locale)} result={result} occasion={occasion} baseUrl="https://giftfit.example" onNewGift={() => undefined} />;
const message = () => screen.getByTestId("widget-card-message") as HTMLTextAreaElement;
const def = (lang: "en" | "vi", occasion: string) => t(lang, `card.defaultMessage.${occasion}` as MessageKey);

describe("e-card default message", () => {
  it.each(OCCASIONS.flatMap((o) => (["en", "vi"] as const).map((l) => [o, l] as const)))("%s in %s: its own default, shown on the card", (occasion, lang) => {
    render(card(occasion, lang));
    expect(message().value).toBe(def(lang, occasion));
    expect(screen.getByTestId("widget-ecard").textContent).toContain(def(lang, occasion));
  });

  it("every occasion has a distinct default; only the anniversary one is romantic", () => {
    for (const lang of ["en", "vi"] as const) {
      const all = OCCASIONS.map((o) => def(lang, o));
      expect(new Set(all).size).toBe(OCCASIONS.length);
      for (const o of OCCASIONS) if (o !== "anniversary") expect(def(lang, o), `${lang}:${o}`).not.toMatch(lang === "en" ? /\blove\b/i : /yêu/i);
    }
    expect(def("en", "birthday")).toMatch(/birthday/i);
  });

  it("follows the card language and the occasion until edited, then keeps the giver's text", () => {
    const { rerender } = render(card("birthday"));
    fireEvent.change(screen.getByTestId("widget-card-lang"), { target: { value: "vi" } });
    expect(message().value).toBe(def("vi", "birthday"));
    rerender(card("graduation"));
    expect(message().value).toBe(def("vi", "graduation"));

    fireEvent.change(message(), { target: { value: "Love you, sis!" } });
    rerender(card("wedding"));
    fireEvent.change(screen.getByTestId("widget-card-lang"), { target: { value: "en" } });
    expect(message().value).toBe("Love you, sis!");
    expect(screen.getByTestId("widget-ecard").textContent).toContain("Love you, sis!");

    // Cleared on purpose: no message on the card (not the default again).
    fireEvent.change(message(), { target: { value: "" } });
    expect(screen.queryByText(def("en", "wedding"), { selector: "blockquote" })).toBeNull();
  });
});

describe("e-card layout", () => {
  it("the step scrolls and the card never shrinks", () => {
    render(card("birthday"));
    const step = screen.getByTestId("widget-card-step");
    expect(step.className).toMatch(/\bmin-h-0\b/);
    expect(step.className).toMatch(/\boverflow-y-auto\b/);
    expect(step.className).toContain("[&>*]:shrink-0");
    expect(screen.getByTestId("widget-ecard").className).toMatch(/\bshrink-0\b/);
  });
});

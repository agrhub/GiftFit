// @vitest-environment jsdom
/**
 * GiftHeader (A26): rendered with the page's server-decided locale (no English flash at hydration), then
 * following the locale the page publishes once its client knows better (navigator.languages, report lang).
 */
import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rt } from "@/lib/i18n/recipient";
import { GiftHeader } from "../GiftHeader";
import { setGiftLocale } from "../giftLocale";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("GiftHeader", () => {
  it("hydrates in the server-decided locale without a mismatch, then follows the published one", async () => {
    const container = document.createElement("div");
    container.innerHTML = renderToString(<GiftHeader locale="ja" />);
    document.body.append(container);
    expect(container.textContent).toContain(rt("ja", "header.private"));
    const errors = vi.spyOn(console, "error");
    const root = await act(async () => hydrateRoot(container, <GiftHeader locale="ja" />));
    expect(errors).not.toHaveBeenCalled();
    expect(container.textContent).toContain(rt("ja", "header.private"));
    expect(container.textContent).not.toContain("Private");
    await act(async () => setGiftLocale("de")); // e.g. the recipient's navigator.languages
    expect(container.textContent).toContain(rt("de", "header.private"));
    expect(container.querySelector("header")?.getAttribute("lang")).toBe("de");
    act(() => root.unmount());
  });
});

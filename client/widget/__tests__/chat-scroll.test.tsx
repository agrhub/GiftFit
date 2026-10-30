// @vitest-environment jsdom
/**
 * Reply scrolling: a question scrolls the log to the bottom; a long reply stops at its own top so the words
 * are read first, instead of the log jumping to the cards and the brief below them.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "@/server/i18n";
import { WidgetApp } from "../WidgetApp";

const LOG_H = 300;
const CONTENT_H = 1000;
const REPLY_TOP = 400; // the reply's top, measured from the top of the log's content
const scrolls: number[] = [];
const tops = new WeakMap<Element, number>();
const isLog = (el: Element) => el.getAttribute("role") === "log";

beforeEach(() => {
  scrolls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url !== "/api/concierge") return new Response("{}", { status: 404 });
      const lines = [{ type: "start", source: "mock" }, { type: "text", delta: "A long reply. ".repeat(40) }, { type: "final", suggestions: [], source: "mock", degraded: false }];
      return new Response(lines.map((l) => JSON.stringify(l)).join("\n") + "\n", { headers: { "Content-Type": "application/x-ndjson" } });
    }),
  );
  const proto = HTMLElement.prototype;
  vi.spyOn(proto, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
    return isLog(this) ? CONTENT_H : 0;
  });
  vi.spyOn(proto, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return isLog(this) ? LOG_H : 0;
  });
  vi.spyOn(Element.prototype, "scrollTop", "get").mockImplementation(function (this: Element) {
    return tops.get(this) ?? 0;
  });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const log = this.closest("[role=log]");
    const y = this.hasAttribute("data-turn") && log ? REPLY_TOP - (tops.get(log) ?? 0) : 0;
    return { top: y, bottom: y, left: 0, right: 0, width: 0, height: 0, x: 0, y, toJSON: () => ({}) } as DOMRect;
  });
  proto.scrollTo = function (this: HTMLElement, opts?: ScrollToOptions | number) {
    const top = Math.max(0, Math.min(CONTENT_H - LOG_H, typeof opts === "object" ? (opts.top ?? 0) : 0));
    tops.set(this, top);
    if (isLog(this)) scrolls.push(top);
  } as typeof proto.scrollTo;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

describe("chat scrolling", () => {
  it("scrolls to the bottom for the question, then to the top of a long reply, not past it", async () => {
    render(<WidgetApp store="aurum" parentOrigin={null} allowedLangs={["en"]} baseUrl="https://giftfit.example" />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "A gift for my sister" } });
    fireEvent.click(screen.getByRole("button", { name: t("en", "chat.send") }));
    await waitFor(() => expect(screen.queryByRole("button", { name: t("en", "chat.stop") })).toBeNull());
    expect(scrolls[0]).toBe(CONTENT_H - LOG_H);
    // The reply's top, 12 px of padding above it, and nothing further down.
    await waitFor(() => expect(scrolls).toContain(REPLY_TOP - 12));
    const atReply = scrolls.indexOf(REPLY_TOP - 12);
    expect(atReply).toBeGreaterThan(0);
    expect(scrolls.slice(atReply).every((s) => s === REPLY_TOP - 12)).toBe(true);
  });
});

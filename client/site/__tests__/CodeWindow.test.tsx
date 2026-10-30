// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodeWindow } from "../CodeWindow";
import { CODE_KEYS, pick } from "../labels";
import { translator } from "@/server/i18n";
import { whenReady } from "../runWidget";

const ORIGIN = "https://giftfit.example";
const labels = pick(translator("en"), CODE_KEYS);
type Win = Window & { GiftFit?: { openWidget?: () => void; destroy?: () => void; loaded?: boolean } };

const scripts = () => [...document.querySelectorAll<HTMLScriptElement>('script[src$="/giftfit.js"]')];

/** What the real loader does once its frame says hello. */
function fakeLoaderReady() {
  const api = { loaded: true, openWidget: vi.fn(), destroy: vi.fn(() => document.querySelector("giftfit-widget")?.remove()) };
  (window as Win).GiftFit = api;
  const host = document.createElement("giftfit-widget");
  host.setAttribute("data-ready", "");
  document.body.appendChild(host);
  return api;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.querySelectorAll("script, giftfit-widget").forEach((n) => n.remove());
  delete (window as Win).GiftFit;
});

describe("CodeWindow", () => {
  it("shows the snippet with no language attribute, says the language is automatic, and rewrites it from the widget switch", () => {
    render(<CodeWindow origin={ORIGIN} labels={labels} />);
    const code = () => screen.getByTestId("code-snippet").textContent;
    expect(code()).toBe(`<script src="${ORIGIN}/giftfit.js" data-store="aurum" async></script>`);
    expect(screen.getByTestId("code-lang-auto").textContent).toContain("Automatic: the store page's language, then each shopper's own (10 languages)");
    expect(screen.queryByRole("radio")).toBeNull();
    fireEvent.click(screen.getByRole("switch"));
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
    expect(code()).toBe(`<script src="${ORIGIN}/giftfit.js" data-store="aurum" data-widget="off" async></script>`);
  });

  it("Copy puts the current snippet on the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<CodeWindow origin={ORIGIN} labels={labels} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("code-copy"));
    });
    expect(writeText).toHaveBeenCalledWith(`<script src="${ORIGIN}/giftfit.js" data-store="aurum" async></script>`);
    expect(screen.getByTestId("code-copy").textContent).toBe("Copied");
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByTestId("code-copy").textContent).toBe("Copy");
  });

  it("Run injects giftfit.js exactly once, then re-opens the chat", async () => {
    render(<CodeWindow origin={ORIGIN} labels={labels} />);
    expect(scripts()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(scripts()).toHaveLength(1);
    const s = scripts()[0];
    expect(s.src).toBe(`${ORIGIN}/giftfit.js`);
    expect(s.async).toBe(true);
    expect(s.getAttribute("data-store")).toBe("aurum");
    expect(s.hasAttribute("data-langs")).toBe(false);
    expect(s.hasAttribute("data-lang")).toBe(false);
    expect(s.hasAttribute("data-widget")).toBe(false);
    expect(screen.getByTestId("code-run-status").textContent).toContain("Starting the assistant");

    const api = fakeLoaderReady();
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByTestId("code-run-status").textContent).toContain("Mark-kun is here");
    expect(api.openWidget).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(scripts()).toHaveLength(1);
    expect(api.openWidget).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("code-run-status").textContent).toBe("Chat opened in the bottom-right corner.");
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(scripts()).toHaveLength(1);
    expect(api.openWidget).toHaveBeenCalledTimes(2);
  });

  it("Run again before the frame is ready waits, then opens", async () => {
    render(<CodeWindow origin={ORIGIN} labels={labels} />);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(scripts()).toHaveLength(1);
    const api = fakeLoaderReady();
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(api.openWidget).toHaveBeenCalledTimes(1);
  });

  it("widget off removes the tag; on again mounts one fresh tag", async () => {
    render(<CodeWindow origin={ORIGIN} labels={labels} />);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    const api = fakeLoaderReady();
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(api.destroy).toHaveBeenCalledTimes(1);
    expect((window as Win).GiftFit).toBeUndefined();
    expect(scripts()).toHaveLength(0);
    expect(screen.getByTestId("code-run-status").textContent).toContain('data-widget="off"');

    fireEvent.click(screen.getByRole("switch"));
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(scripts()).toHaveLength(1);
    expect(scripts()[0].getAttribute("data-store")).toBe("aurum");
  });

  it("says so when the widget never becomes ready", async () => {
    render(<CodeWindow origin={ORIGIN} labels={labels} />);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await act(async () => {
      vi.advanceTimersByTime(101_000);
    });
    expect(screen.getByTestId("code-run-status").textContent).toContain("didn't start");
  });
});

describe("whenReady", () => {
  it("fails fast when the loader removes a frame that never said hello", () => {
    const done = vi.fn();
    const host = document.createElement("giftfit-widget");
    document.body.appendChild(host);
    whenReady(done, { intervalMs: 100 });
    vi.advanceTimersByTime(250);
    expect(done).not.toHaveBeenCalled();
    host.remove();
    vi.advanceTimersByTime(150);
    expect(done).toHaveBeenCalledWith(false);
  });
});

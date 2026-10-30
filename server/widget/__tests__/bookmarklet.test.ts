// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { BOOKMARKLET_BLOCKED_LINK, bookmarkletHref, bookmarkletSource } from "../bookmarklet";

const APP = "https://giftfit.example";
const KEY = "AbCdEfGhIjKlMnOpQrStUv";
const PREVIEW = `${APP}/s/${KEY}`;
const run = () => new Function(bookmarkletSource(APP, KEY, PREVIEW))();

afterEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  delete (window as unknown as { GiftFit?: unknown }).GiftFit;
  vi.useRealTimers();
});

describe("bookmarklet", () => {
  it("is a javascript: URL around the source and refuses bad inputs", () => {
    expect(bookmarkletHref(APP, KEY, PREVIEW).startsWith("javascript:")).toBe(true);
    expect(decodeURIComponent(bookmarkletHref(APP, KEY, PREVIEW).slice("javascript:".length))).toBe(bookmarkletSource(APP, KEY, PREVIEW));
    expect(() => bookmarkletSource(APP, "short", PREVIEW)).toThrow();
    expect(() => bookmarkletSource("javascript:alert(1)", KEY, PREVIEW)).toThrow();
  });

  it("injects exactly one giftfit.js script with the preview store key, even when clicked twice", () => {
    run();
    run();
    const scripts = document.querySelectorAll("script");
    expect(scripts).toHaveLength(1);
    expect(scripts[0].getAttribute("src")).toBe(`${APP}/giftfit.js`);
    expect(scripts[0].getAttribute("data-store")).toBe(`preview:${KEY}`);
    expect(scripts[0].async).toBe(true);
  });

  it("opens the assistant instead when GiftFit is already on the page", () => {
    const openWidget = vi.fn();
    (window as unknown as { GiftFit: unknown }).GiftFit = { loaded: true, openWidget };
    run();
    expect(openWidget).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll("script")).toHaveLength(0);
  });

  it("shows a friendly notice linking to the preview when the page's CSP blocks GiftFit", () => {
    vi.useFakeTimers();
    run();
    // A violation for another origin is ignored.
    document.dispatchEvent(Object.assign(new Event("securitypolicyviolation"), { blockedURI: "https://cdn.other.example/x.js" }));
    expect(document.getElementById("giftfit-bookmarklet-note")).toBeNull();
    document.dispatchEvent(Object.assign(new Event("securitypolicyviolation"), { blockedURI: `${APP}/giftfit.js` }));
    const note = document.getElementById("giftfit-bookmarklet-note")!;
    expect(note.getAttribute("role")).toBe("status");
    const link = note.querySelector("a")!;
    expect(link.textContent).toBe(BOOKMARKLET_BLOCKED_LINK);
    expect(link.href).toBe(PREVIEW);
    expect(link.rel).toBe("noopener noreferrer");
    // Script error (blocked another way) does not add a second notice; it disappears after 15 s.
    document.querySelector("script")!.dispatchEvent(new Event("error"));
    expect(document.querySelectorAll("#giftfit-bookmarklet-note")).toHaveLength(1);
    vi.advanceTimersByTime(15_000);
    expect(document.getElementById("giftfit-bookmarklet-note")).toBeNull();
  });
});

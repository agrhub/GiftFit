import { describe, expect, it } from "vitest";
import { acceptHostMessage, cleanPrice, cleanUrl, exactOrigin, frameMessage, parentMatchesAncestor, parseFrameMessage, parseHostMessage, sanitizePdp, WIDGET_SOURCE } from "../protocol";
import { isWidgetOriginAllowed, widgetFrameAncestors, widgetOrigins } from "../config";

const PARENT = "https://shop.example";
const parentWin = { name: "parent" };
const ctx = (extra: Record<string, unknown> = {}) => ({ source: WIDGET_SOURCE, v: 1, type: "context", product: { title: "Halo Drop Earrings", price: "245.00", currency: "usd", source: "json-ld" }, page: { lang: "vi", url: "https://shop.example/p/halo?utm=x#top" }, ...extra });

describe("sanitizePdp", () => {
  it("keeps product facts only, cleaned and capped", () => {
    const p = sanitizePdp({
      title: "  Halo‮ Drop\n Earrings  ",
      price: "1,299.00",
      currency: "usd",
      image: "https://cdn.shop.example/halo.jpg",
      url: "https://shop.example/p/halo?ref=mail#reviews",
      sku: "AUR-EAR-028",
      source: "json-ld",
      email: "x@y.z",
    });
    expect(p).toEqual({ title: "Halo Drop Earrings", price: 1299, currency: "USD", image: "https://cdn.shop.example/halo.jpg", url: "https://shop.example/p/halo", sku: "AUR-EAR-028", source: "json-ld" });
  });

  it("drops unsafe URLs, bad prices and missing titles", () => {
    expect(sanitizePdp({ title: "" })).toBeNull();
    expect(sanitizePdp(null)).toBeNull();
    const p = sanitizePdp({ title: "x".repeat(500), image: "javascript:alert(1)", url: "https://user:pw@shop.example/p", price: -5, currency: "dollars", source: "evil" });
    expect(p).toEqual({ title: "x".repeat(160), source: "dom" });
  });

  it("parses price formats", () => {
    expect(cleanPrice("245")).toBe(245);
    expect(cleanPrice("$1,299.50")).toBe(1299.5);
    expect(cleanPrice("1.299,50 €")).toBe(1299.5);
    expect(cleanPrice("2.000.000 ₫")).toBe(2_000_000);
    expect(cleanPrice("free")).toBeUndefined();
    expect(cleanPrice(1e12)).toBeUndefined();
    expect(cleanUrl("data:image/png;base64,AAA")).toBeUndefined();
  });
});

describe("host → frame messages", () => {
  it("accepts only the expected parent window on the expected origin", () => {
    expect(acceptHostMessage({ origin: PARENT, source: parentWin, data: ctx() }, PARENT, parentWin)).toMatchObject({ type: "context", page: { lang: "vi", url: "https://shop.example/p/halo" } });
    expect(acceptHostMessage({ origin: "https://evil.example", source: parentWin, data: ctx() }, PARENT, parentWin)).toBeNull();
    expect(acceptHostMessage({ origin: PARENT, source: { other: true }, data: ctx() }, PARENT, parentWin)).toBeNull();
    expect(acceptHostMessage({ origin: PARENT, source: parentWin, data: ctx() }, null, parentWin)).toBeNull();
  });

  it("rejects other versions, sources and types; re-sanitises the product", () => {
    expect(parseHostMessage(ctx({ v: 2 }))).toBeNull();
    expect(parseHostMessage(ctx({ source: "giftfit" }))).toBeNull();
    expect(parseHostMessage({ source: WIDGET_SOURCE, v: 1, type: "token" })).toBeNull();
    expect(parseHostMessage({ source: WIDGET_SOURCE, v: 1, type: "open" })).toEqual({ type: "open" });
    const m = parseHostMessage(ctx({ product: { title: "  ", price: 5 } }));
    expect(m).toEqual({ type: "context", product: null, page: { lang: "vi", url: "https://shop.example/p/halo" } });
  });
});

describe("frame → host messages", () => {
  it("envelope and parsing (loader's rules)", () => {
    expect(frameMessage({ type: "resize", mode: "panel" })).toEqual({ source: WIDGET_SOURCE, v: 1, type: "resize", mode: "panel" });
    expect(parseFrameMessage(frameMessage({ type: "sent" }))).toEqual({ type: "sent" });
    expect(parseFrameMessage({ source: WIDGET_SOURCE, v: 1, type: "resize", mode: "fullscreen" })).toBeNull();
    expect(parseFrameMessage({ source: WIDGET_SOURCE, v: 1, type: "sent", giverToken: "x" })).toEqual({ type: "sent" });
  });
});

describe("origins", () => {
  it("exactOrigin accepts only bare http(s) origins", () => {
    expect(exactOrigin("https://shop.example")).toBe("https://shop.example");
    expect(exactOrigin("https://shop.example/")).toBe("https://shop.example");
    expect(exactOrigin("https://shop.example/path")).toBeNull();
    expect(exactOrigin("javascript:alert(1)")).toBeNull();
    expect(exactOrigin("https://u:p@shop.example")).toBeNull();
    expect(exactOrigin(undefined)).toBeNull();
  });

  it("ancestorOrigins must name the claimed parent when present", () => {
    expect(parentMatchesAncestor(PARENT, [PARENT])).toBe(true);
    expect(parentMatchesAncestor(PARENT, ["https://evil.example"])).toBe(false);
    expect(parentMatchesAncestor(PARENT, undefined)).toBe(true);
  });

  it("GIFTFIT_WIDGET_ORIGINS drives the allow-list and frame-ancestors", () => {
    expect(widgetOrigins({})).toBe("*");
    expect(widgetFrameAncestors({})).toBe("*");
    const env = { GIFTFIT_WIDGET_ORIGINS: "https://demo.example, https://shop.example/x  not-a-url http://localhost:4320" };
    expect(widgetOrigins(env)).toEqual(["https://demo.example", "https://shop.example", "http://localhost:4320"]);
    expect(widgetFrameAncestors(env)).toBe("'self' https://demo.example https://shop.example http://localhost:4320");
    expect(isWidgetOriginAllowed("https://demo.example", "https://app.example", env)).toBe(true);
    expect(isWidgetOriginAllowed("https://app.example", "https://app.example", env)).toBe(true);
    expect(isWidgetOriginAllowed("https://evil.example", "https://app.example", env)).toBe(false);
    expect(isWidgetOriginAllowed("https://demo.example/", "https://app.example", env)).toBe(false);
    expect(isWidgetOriginAllowed("https://anything.example", null, {})).toBe(true);
  });
});

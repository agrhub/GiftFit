// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { matchPreviewProduct, WidgetApp, type WidgetPreview } from "../WidgetApp";

const PARENT = "https://shop.example";
const preview: WidgetPreview = {
  key: "AbCdEfGhIjKlMnOpQrStUv",
  domain: "lumen-jewelry.example",
  storeName: "Lumen Fine Jewelry",
  giftable: true,
  products: [
    { id: "1001", title: "Aria Gold Hoops", url: "https://lumen-jewelry.example/products/aria-gold-hoops", price: 180, currency: "USD", image: "https://cdn.example/a.jpg", skuId: "AbCdEfGhIjKlMnOpQrStUv~pv-0-1001" },
    { id: "t9", title: "Gift Wrap", url: "https://lumen-jewelry.example/products/wrap", price: 5, currency: "USD" },
  ],
  settings: { character: "mascot", accentColor: "#1f6f5c", greeting: "Welcome to Lumen! Ask me for a gift idea." },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("matchPreviewProduct", () => {
  it("matches by SKU (= store product id), product URL path, the preview's own /p/<id> page, then title", () => {
    expect(matchPreviewProduct(preview, { title: "x", sku: "1001", source: "json-ld" })).toMatchObject({ id: "AbCdEfGhIjKlMnOpQrStUv~pv-0-1001", giftable: true });
    expect(matchPreviewProduct(preview, { title: "x", url: "https://lumen-jewelry.example/products/aria-gold-hoops/", source: "open-graph" })?.title).toBe("Aria Gold Hoops");
    expect(matchPreviewProduct(preview, { title: "x", url: "https://giftfit.example/s/AbCdEfGhIjKlMnOpQrStUv/p/1001", source: "json-ld" })?.title).toBe("Aria Gold Hoops");
    expect(matchPreviewProduct(preview, { title: "  gift WRAP ", source: "dom" })).toMatchObject({ id: "t9", giftable: false });
    expect(matchPreviewProduct(preview, { title: "Something else", source: "dom" })).toBeNull();
  });
});

describe("WidgetApp on a preview store", () => {
  it("applies the owner's greeting, accent and character; Gift this? on a matched page; no catalog lookup call", async () => {
    const fetchMock = vi.fn(async (url: string) => new Response(url ? "{}" : "", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<WidgetApp store={`preview:${preview.key}`} preview={preview} parentOrigin={PARENT} allowedLangs={["en"]} baseUrl="https://giftfit.example" />);
    act(() => window.dispatchEvent(new MessageEvent("message", { origin: PARENT, source: window, data: { source: "giftfit-widget", v: 1, type: "context", product: { title: "Aria Gold Hoops", sku: "1001", source: "json-ld" }, page: { lang: "en" } } })));
    expect((await screen.findByTestId("widget-tip")).textContent).toContain("Gift this?");
    expect(fetchMock.mock.calls.some((c) => String(c[0]).startsWith("/api/retailer/lookup"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Open the gift assistant" }));
    const panel = await screen.findByTestId("widget-panel");
    expect(panel.querySelector("header")!.getAttribute("data-accent")).toBe("#1f6f5c");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Lumen Fine Jewelry");
    expect(screen.getByTestId("widget-intro").textContent).toContain("Aria Gold Hoops");
  });

  it("shows the greeting when the page has no product", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    render(<WidgetApp store={`preview:${preview.key}`} preview={preview} parentOrigin={null} allowedLangs={["en"]} baseUrl="https://giftfit.example" />);
    expect((await screen.findByTestId("widget-intro")).textContent).toBe("Welcome to Lumen! Ask me for a gift idea.");
  });
});

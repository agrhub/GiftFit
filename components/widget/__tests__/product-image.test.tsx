// @vitest-environment jsdom
/**
 * Suggestion thumbnails on a store preview: a small CDN rendition, loaded eagerly, the original tried once if it fails,
 * then a neutral tile (a recorded real-store take showed empty white boxes for full-size lazy images).
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ProductImage, thumbnailUrl } from "../WidgetChat";

afterEach(cleanup);

const SHOPIFY = "https://cdn.shopify.com/s/files/1/0001/products/pendant.jpg?v=178";

describe("thumbnailUrl", () => {
  it("asks Shopify's CDN (and a store's /cdn/shop/ path) for a 160 px rendition, keeping other parameters", () => {
    expect(thumbnailUrl(SHOPIFY)).toBe("https://cdn.shopify.com/s/files/1/0001/products/pendant.jpg?v=178&width=160");
    expect(thumbnailUrl("https://shop.example.com/cdn/shop/files/ring.jpg?width=2000")).toBe("https://shop.example.com/cdn/shop/files/ring.jpg?width=160");
  });

  it("leaves other hosts, http, relative paths and junk alone", () => {
    for (const u of ["https://images.example.com/a.jpg", "http://cdn.shopify.com/a.jpg", "/catalog/a.jpg", "not a url"]) expect(thumbnailUrl(u)).toBe(u);
  });
});

describe("ProductImage", () => {
  const img = () => document.querySelector("img")!;

  it("loads the small rendition eagerly, with no Referer", () => {
    render(<ProductImage src={SHOPIFY} />);
    expect(img().getAttribute("src")).toBe(thumbnailUrl(SHOPIFY));
    expect(img().getAttribute("loading")).toBe("eager");
    expect(img().getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("falls back to the original once, then to a neutral tile instead of an empty box", () => {
    render(<ProductImage src={SHOPIFY} />);
    fireEvent.error(img());
    expect(img().getAttribute("src")).toBe(SHOPIFY);
    fireEvent.error(img());
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByTestId("product-image-fallback")).toBeTruthy();
  });

  it("a non-CDN image goes straight to the tile when it fails", () => {
    render(<ProductImage src="https://images.example.com/a.jpg" />);
    expect(img().getAttribute("src")).toBe("https://images.example.com/a.jpg");
    fireEvent.error(img());
    expect(screen.getByTestId("product-image-fallback")).toBeTruthy();
  });
});

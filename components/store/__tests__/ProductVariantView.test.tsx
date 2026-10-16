// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getProduct, toGiftPiece } from "../catalog";
import { CartProvider, useCart } from "../CartProvider";
import { ProductVariantView } from "../ProductVariantView";

vi.mock("@/components/gift/GiftItRightButton", () => ({ GiftItRightButton: () => null }));

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function Bag() {
  const { lines } = useCart();
  return <pre data-testid="bag">{JSON.stringify(lines.map((l) => [l.variantId, l.metal, l.price]))}</pre>;
}

describe("PDP metal selector (ADR-032)", () => {
  it("switches image, price and the bag line with the metal", () => {
    const halo = getProduct("AUR-EAR-028")!;
    expect(halo.variants.length).toBeGreaterThan(1);
    render(
      <CartProvider>
        <ProductVariantView product={halo} categoryLabel="Earring" giftPiece={toGiftPiece(halo)} details={[]} />
        <Bag />
      </CartProvider>,
    );
    const first = halo.variants[0];
    const other = halo.variants[1];
    expect(screen.getByTestId("pdp-price").textContent).toBe(`$${first.price}`);
    fireEvent.click(screen.getByTestId(`pdp-metal-${other.metal}`));
    expect(screen.getByTestId("pdp-price").textContent).toBe(`$${other.price}`);
    expect(screen.getByRole("img").getAttribute("alt")).toMatch(new RegExp(`in ${other.metal.replace("_", " ")}`));
    fireEvent.click(screen.getByTestId("add-to-bag"));
    expect(JSON.parse(screen.getByTestId("bag").textContent!)).toEqual([[other.variantId, other.metal, other.price]]);
  });

  it("hides the selector for single-metal designs", () => {
    const ring = getProduct("AUR-RNG-012")!;
    render(
      <CartProvider>
        <ProductVariantView product={ring} categoryLabel="Ring" giftPiece={toGiftPiece(ring)} details={[]} />
      </CartProvider>,
    );
    expect(screen.queryByTestId("pdp-metals")).toBeNull();
  });
});

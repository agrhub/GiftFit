// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CarouselItem } from "@/lib/contracts/api";
import { TryOnCarousel } from "../recipient/TryOnCarousel";
import type { CardState } from "../recipient/variants";

afterEach(cleanup);

const sw = (id: string, metalLabel: string, swatchColor: string, isDefault = false) => ({ swatchId: id, metalLabel, swatchColor, isDefault });
const three = (p: string) => [sw(`${p}y`, "Yellow gold", "#d4b062", true), sw(`${p}w`, "White gold", "#d9d9d6"), sw(`${p}r`, "Rose gold", "#d39a85")];

// Server order; the first two happen to be the giver's picks, which the client never knows.
// Decoys carry swatches with the same count (A3's strict leveling, ADR-035).
const items: CarouselItem[] = [
  { itemId: "q9", title: "Halo Drop Earrings", category: "earring", productImage: "/catalog/a.jpg", needsHandPhoto: false, swatches: three("q9") },
  { itemId: "k2", title: "Crescent Pendant", category: "necklace", productImage: "/catalog/b.jpg", needsHandPhoto: false, swatches: three("k2") },
  { itemId: "z1", title: "Chime Bell Drops", category: "earring", productImage: "/catalog/c.jpg", needsHandPhoto: false, swatches: three("z1") },
  { itemId: "a7", title: "Pavé Collar", category: "necklace", productImage: "/catalog/d.jpg", needsHandPhoto: false, swatches: three("a7") },
  { itemId: "m3", title: "Cove Fringe Earrings", category: "earring", productImage: "/catalog/e.jpg", needsHandPhoto: false, swatches: three("m3") },
  { itemId: "c5", title: "Summit Band", category: "ring", productImage: "/catalog/f.jpg", needsHandPhoto: true, swatches: [sw("c5w", "White gold", "#d9d9d6", true)] },
];
const cards: Record<string, CardState> = Object.fromEntries(
  items.map((i) => [
    i.itemId,
    {
      swatchId: i.swatches![0].swatchId,
      render: i.needsHandPhoto ? { status: "skipped_needs_hand" } : { status: "ready", imageUrl: `/api/recipient/tryon/${i.itemId}?sig=x` },
      loading: false,
      hearted: i.itemId === "k2",
      wished: false,
      capNote: false,
    },
  ]),
);

function renderCarousel(overrides: Partial<Record<string, Partial<CardState>>> = {}) {
  const handlers = { onSwatch: vi.fn(), onToggleHeart: vi.fn(), onWish: vi.fn() };
  const merged = Object.fromEntries(items.map((i) => [i.itemId, { ...cards[i.itemId], ...overrides[i.itemId] }]));
  render(<TryOnCarousel items={items} cards={merged} {...handlers} />);
  return handlers;
}

/** Structure of a card with item-specific text, URLs and colours stripped. */
function skeleton(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll("*").forEach((n) => {
    for (const attr of ["src", "alt", "aria-label", "title", "style", "aria-pressed", "fill"]) n.removeAttribute(attr);
    if (n.children.length === 0) n.textContent = "";
  });
  clone.removeAttribute("aria-label");
  return clone.outerHTML.replace(/bg-rose text-white|bg-white\/95 text-ink/g, "HEART");
}

describe("TryOnCarousel", () => {
  it("renders 6 cards in server order; each try-on is labelled AI preview with the metal in the alt text", () => {
    renderCarousel();
    const cardsEls = screen.getAllByTestId("carousel-item");
    expect(cardsEls.map((c) => c.querySelector("h3")!.textContent)).toEqual(items.map((i) => i.title));
    expect(screen.getAllByText("AI preview")).toHaveLength(5);
    expect(screen.getByAltText("AI preview of you wearing Halo Drop Earrings in yellow gold")).toBeTruthy();
    expect(screen.getByText(/Needs a hand photo/)).toBeTruthy();
  });

  it("shows metal swatches as a labelled radio group, never prices", () => {
    renderCarousel();
    const first = screen.getAllByTestId("carousel-item")[0];
    const group = within(first).getByRole("radiogroup", { name: "Metal for Halo Drop Earrings" });
    expect(within(group).getAllByRole("radio").map((r) => [r.getAttribute("aria-label"), r.getAttribute("aria-checked")])).toEqual([
      ["Yellow gold", "true"],
      ["White gold", "false"],
      ["Rose gold", "false"],
    ]);
    expect(document.body.textContent).not.toMatch(/\$\s?\d|USD|price/i);
  });

  it("gives no visible or DOM hint that separates shortlist from decoys", () => {
    renderCarousel();
    const cardEls = screen.getAllByTestId("carousel-item");
    expect(new Set(cardEls.slice(0, 5).map(skeleton)).size).toBe(1);
    const html = document.body.innerHTML.toLowerCase();
    for (const word of ["shortlist", "decoy", "giver", "picked", "data-sku", "catalog id"]) expect(html).not.toContain(word);
    for (const card of cardEls) {
      const dataAttrs = [...card.querySelectorAll("*"), card].flatMap((n) => [...n.attributes].filter((a) => a.name.startsWith("data-") && a.name !== "data-testid").map((a) => a.name));
      expect(dataAttrs).toEqual([]);
    }
  });

  it("calls back for swatch, heart (of the metal shown) and wish", () => {
    const h = renderCarousel();
    const first = screen.getAllByTestId("carousel-item")[0];
    fireEvent.click(within(first).getByRole("radio", { name: "White gold" }));
    expect(h.onSwatch).toHaveBeenCalledWith("q9", "q9w");
    fireEvent.click(within(first).getByRole("radio", { name: "Yellow gold" }));
    expect(h.onSwatch).toHaveBeenCalledTimes(1); // already shown
    const heart = screen.getByRole("button", { name: "Heart Halo Drop Earrings, yellow gold" });
    expect(heart.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(heart);
    expect(h.onToggleHeart).toHaveBeenCalledWith("q9");
    expect(screen.getByRole("button", { name: "Heart Crescent Pendant, yellow gold" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(first).getByTestId("wish-metal"));
    expect(h.onWish).toHaveBeenCalledWith("q9");
  });

  it("shows loading on one card only, the cap note, and the earlobe retake", () => {
    renderCarousel({ q9: { loading: true, swatchId: "q9w", render: undefined }, k2: { capNote: true }, z1: { render: { status: "failed", failureReason: "2" } } });
    expect(screen.getAllByTestId("swatch-loading")).toHaveLength(1);
    expect(screen.getByText("Trying on white gold…")).toBeTruthy();
    expect(screen.getByTestId("cap-note").textContent).toBe("You've tried all the extra metals we can show this time.");
    expect(screen.getByText(/We couldn't see your ears/)).toBeTruthy();
  });
});

describe("TryOnCarousel: focused crop", () => {
  it("opens each try-on on its category crop, keeping the AI preview label", () => {
    renderCarousel();
    const imgs = screen.getAllByTestId("tryon-image");
    const byAlt = (re: RegExp) => imgs.find((i) => re.test(i.getAttribute("alt") ?? ""))!;
    expect(byAlt(/Halo Drop/).style.transform).toBe("scale(1.818)");
    expect(byAlt(/Halo Drop/).style.transformOrigin).toBe("50.0% 17.8%");
    expect(byAlt(/Crescent Pendant/).style.transform).toBe("scale(2.381)");
    expect(screen.getAllByText("AI preview")).toHaveLength(imgs.length);
  });

  it("toggles full frame per card with aria-pressed, keeps it while other cards change, and leaves hearts alone", () => {
    const h = renderCarousel();
    const [halo, crescent] = screen.getAllByTestId("carousel-item");
    const toggle = within(halo).getByRole("button", { name: "Show full photo" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(within(halo).getByTestId("tryon-image").style.transform).toBe("scale(1)");
    // Other cards keep their crop; interacting with them doesn't reset this one.
    expect(within(crescent).getByTestId("tryon-image").style.transform).toBe("scale(2.381)");
    fireEvent.click(within(crescent).getByTestId("heart"));
    expect(within(halo).getByRole("button", { name: "Show full photo" }).getAttribute("aria-pressed")).toBe("true");
    // The toggle neither hearts nor changes the metal.
    expect(h.onToggleHeart).toHaveBeenCalledTimes(1);
    expect(h.onToggleHeart).toHaveBeenCalledWith("k2");
    expect(h.onSwatch).not.toHaveBeenCalled();
    fireEvent.click(toggle);
    expect(within(halo).getByTestId("tryon-image").style.transform).toBe("scale(1.818)");
  });
});

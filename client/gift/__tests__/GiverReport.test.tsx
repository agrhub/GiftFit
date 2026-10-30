// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GiverReportStatus } from "@/server/contracts/api";
import { type GiftApi, normalizeReport } from "../api";
import { GiverReport } from "../report/GiverReport";
import { GiftHeader } from "../GiftHeader";

afterEach(cleanup);
const TOKEN = "t".repeat(43);

const products = {
  hero: { id: "hero", slug: "halo-drop-earrings", title: "Halo Drop Earrings", price: 245, currency: "USD", metal: "yellow_gold" as const },
  nec: { id: "nec", slug: "crescent-pendant", title: "Crescent Pendant", price: 230, currency: "USD", metal: "rose_gold" as const },
};

const completed: GiverReportStatus = {
  status: "completed",
  expiresAt: "2026-10-18T12:00:00.000Z",
  results: [
    { skuId: "nec", score: 61, breakdown: { hearts: 8, metal: 16, style: 9, budgetOccasion: 13.2 }, reasons: ["Close to a piece they hearted."], caution: "Longer chain than their favourite." },
    { skuId: "hero", variantId: "hero:white_gold", metal: "white_gold", price: 265, score: 94, breakdown: { hearts: 50, metal: 18.4, style: 12, budgetOccasion: 13.6 }, reasons: ["They hearted this piece.", "Warm undertone estimate suits yellow gold."] },
  ],
  heartedShortlistIds: ["hero"],
  otherMetalWishes: ["nec"],
  recipientLabels: { undertone: "Warm undertone estimate", faceShape: "Oval face shape estimate" },
};

const apiWith = (r: GiverReportStatus) => ({ giverReport: vi.fn(async () => normalizeReport(r)) }) as unknown as GiftApi;

describe("GiverReport", () => {
  it("shows scores, reasons, hearts and a buy button, sorted by score", async () => {
    render(<GiverReport token={TOKEN} api={apiWith(completed)} products={products} />);
    const items = await screen.findAllByTestId("fit-report-item");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("Halo Drop Earrings");
    expect(items[0].textContent).toContain("94");
    expect(items[0].textContent).toContain("They loved it");
    expect(items[1].textContent).not.toContain("They loved it");
    expect(screen.getByText("Warm undertone estimate")).toBeTruthy();
    // The hearted variant: design + metal + price, and the buy button for that exact variant.
    expect(items[0].textContent).toContain("White gold");
    expect(within(items[0]).getByTestId("report-price").textContent).toBe("$265");
    expect(screen.getAllByTestId("buy-button")[0].getAttribute("href")).toBe("/p/halo-drop-earrings");
    expect(screen.getAllByTestId("buy-button")[0].textContent).toBe("Buy as a gift · White gold · $265");
    // No variant info on a result: falls back to the product's default metal and price.
    expect(items[1].textContent).toContain("Rose gold");
    expect(within(items[1]).getByTestId("wished-other-metal").textContent).toBe("Wished for another metal");
    expect(within(items[0]).queryByTestId("wished-other-metal")).toBeNull();
    expect(screen.getByTestId("photos-seen-counter").textContent).toContain("Photos seen by the giver: 0");
    expect(screen.getByTestId("hearted-count").textContent).toBe("1");
  });

  it("renders no image elements, background images or hex values", async () => {
    const { container } = render(<GiverReport token={TOKEN} api={apiWith(completed)} products={products} />);
    await screen.findAllByTestId("fit-report-item");
    expect(container.querySelectorAll("img, picture, image, video, canvas, source").length).toBe(0);
    for (const el of container.querySelectorAll<HTMLElement>("[style]")) expect(el.getAttribute("style")).not.toMatch(/url\(/i);
    expect(container.textContent).not.toMatch(/#[0-9a-f]{6}\b/i);
    expect(container.textContent).not.toMatch(/\bL\*|\blab\b|hue/i);
  });

  it("waits and polls while the recipient hasn't finished", async () => {
    const api = apiWith({ status: "waiting", expiresAt: completed.expiresAt });
    render(<GiverReport token={TOKEN} api={api} products={products} pollMs={20} />);
    expect(await screen.findByTestId("report-waiting")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 70));
    expect((api.giverReport as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1);
    expect(screen.queryAllByTestId("fit-report-item")).toHaveLength(0);
  });

  it("says 'Demo request' for a seeded judge demo (API flag or ?demo=1) and not otherwise", async () => {
    render(<GiverReport token={TOKEN} api={apiWith({ ...completed, demo: true } as GiverReportStatus)} products={products} />);
    expect((await screen.findByTestId("demo-request")).textContent).toBe("Demo request");
    expect(screen.getByText(/AI-generated model/)).toBeTruthy();
    cleanup();
    window.history.replaceState(null, "", "/g/x?demo=1");
    render(<GiverReport token={TOKEN} api={apiWith(completed)} products={products} />);
    expect(await screen.findByTestId("demo-request")).toBeTruthy();
    cleanup();
    window.history.replaceState(null, "", "/g/x");
    render(<GiverReport token={TOKEN} api={apiWith(completed)} products={products} />);
    await screen.findAllByTestId("fit-report-item");
    expect(screen.queryByTestId("demo-request")).toBeNull();
    // Still no images on a demo report.
    expect(document.querySelectorAll("img, picture").length).toBe(0);
  });
});

describe("GiverReport: Help me choose (ADR-045)", () => {
  const help: GiverReportStatus = {
    ...completed,
    mode: "help_me_choose",
    tasteSummary: { text: "Their hearts lean minimal, mostly in yellow gold, with a liking for drop earrings.", source: "template" },
    similarNotTried: [
      { catalogId: "nec", variantId: "nec:rose_gold", price: 230, currency: "USD", label: "not tried on" },
      { catalogId: "unknown", price: 99, currency: "USD", label: "not tried on" },
    ],
  };
  const withVariants = { ...products, nec: { ...products.nec, variants: [{ variantId: "nec:rose_gold", metal: "rose_gold" as const, price: 230, image: "/catalog/x.png", material: "10k rose gold" }] } };

  it("shows the taste summary and the not-tried picks, clearly labelled, with no images", async () => {
    const { container } = render(<GiverReport token={TOKEN} api={apiWith(help)} products={withVariants} />);
    await screen.findAllByTestId("fit-report-item");
    expect(screen.getByTestId("taste-summary-text").textContent).toBe(help.tasteSummary!.text);
    expect(screen.getByTestId("taste-summary-source").textContent).toMatch(/hearted/);
    const picks = screen.getAllByTestId("not-tried-item");
    expect(picks).toHaveLength(2);
    for (const p of picks) expect(within(p).getByTestId("not-tried-label").textContent).toBe("Not tried on");
    expect(picks[0].textContent).toContain("Crescent Pendant");
    expect(picks[0].textContent).toContain("Rose gold");
    expect(picks[0].textContent).toContain("$230");
    expect(picks[1].textContent).toContain("A similar piece");
    expect(screen.getByText("Pieces tried")).toBeTruthy();
    expect(container.querySelectorAll("img, picture, image, video, canvas, source").length).toBe(0);
  });

  it("credits Claude when it wrote the summary", async () => {
    render(<GiverReport token={TOKEN} api={apiWith({ ...help, tasteSummary: { text: "They lean minimal.", source: "claude" } })} products={products} />);
    expect((await screen.findByTestId("taste-summary-source")).textContent).toMatch(/Claude/);
  });

  it("an I have ideas report has neither section", async () => {
    render(<GiverReport token={TOKEN} api={apiWith(completed)} products={products} />);
    await screen.findAllByTestId("fit-report-item");
    expect(screen.queryByTestId("taste-summary")).toBeNull();
    expect(screen.queryByTestId("not-tried")).toBeNull();
    expect(screen.getByText("Your picks")).toBeTruthy();
  });
});

describe("GiverReport for a store-URL preview request (A6, ADR-055)", () => {
  const snapshot = [
    { catalogId: "K~pv-0-1001", title: "Aria Gold Hoops", price: 180, currency: "USD", image: "https://cdn.shop.example/aria.jpg", url: "https://shop.example/products/aria" },
    { catalogId: "K~pv-1-1002", title: "Lumen Pearl Studs", price: 120, currency: "USD", url: "https://shop.example/products/lumen" },
  ];
  const preview: GiverReportStatus = {
    status: "completed",
    expiresAt: "2026-10-30T12:00:00.000Z",
    results: [
      { skuId: "K~pv-0-1001", score: 88, breakdown: { hearts: 50, metal: 16, style: 9, budgetOccasion: 13 }, reasons: ["They hearted this piece."] },
      { skuId: "K~pv-1-1002", score: 40, breakdown: { hearts: 0, metal: 16, style: 9, budgetOccasion: 13 }, reasons: [] },
    ],
    heartedShortlistIds: ["K~pv-0-1001"],
    products: snapshot,
    previewExpired: true,
  };

  it("names the pieces from the frozen snapshot, shows merchant images and links out with rel nofollow", async () => {
    render(<GiverReport token={TOKEN} api={apiWith(preview)} products={{}} />);
    const items = await screen.findAllByTestId("fit-report-item");
    expect(items[0].textContent).toContain("Aria Gold Hoops");
    expect(items[1].textContent).toContain("Lumen Pearl Studs");
    const img = within(items[0]).getByTestId("report-product-image") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("https://cdn.shop.example/aria.jpg");
    expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
    const buy = within(items[0]).getByTestId("buy-button");
    expect(buy.getAttribute("href")).toBe("https://shop.example/products/aria");
    expect(buy.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    expect(buy.getAttribute("target")).toBe("_blank");
    expect(screen.getByTestId("report-preview-expired").textContent).toContain("This preview has expired");
    expect(screen.getByTestId("report-preview-expired").textContent).toContain("Bản xem trước");
  });
});

describe("GiverReport without a try-on (store-URL previews, ADR-055)", () => {
  const preview: GiverReportStatus = {
    status: "completed",
    expiresAt: "2026-10-30T12:00:00.000Z",
    mode: "help_me_choose",
    tryOn: false,
    storeName: "gorjana",
    results: [
      { skuId: "hero", variantId: "hero:yellow_gold", metal: "yellow_gold", price: 245, score: 100, breakdown: { hearts: 80, budgetOccasion: 20 }, reasons: ["They hearted this piece.", "Within your $300 budget."], caution: "Scored from their hearts, your budget and the occasion. Check the size before you buy." },
      { skuId: "nec", score: 15, breakdown: { hearts: 0, budgetOccasion: 15.2 }, reasons: ["Within your $300 budget.", "Not tagged for a birthday, but still giftable."], caution: "They did not heart this piece." },
    ],
    heartedShortlistIds: ["hero"],
    tasteSummary: { text: "They hearted 1 of 2 pieces.", source: "template" },
    similarNotTried: [{ catalogId: "nec", price: 230, currency: "USD", label: "not tried on" }],
  };

  it("Pieces shown, only the scored factors, no try-on/estimate/decoy lines, and the store's name in the header", async () => {
    const { container } = render(
      <>
        <GiftHeader />
        <GiverReport token={TOKEN} api={apiWith(preview)} products={products} />
      </>,
    );
    await screen.findAllByTestId("fit-report-item");
    expect(screen.getByText("Pieces shown")).toBeTruthy();
    expect(screen.queryByText("Pieces tried")).toBeNull();
    expect(screen.queryByText("Metal and undertone")).toBeNull();
    expect(screen.queryByText("Style and face shape")).toBeNull();
    expect(screen.getAllByText("80 / 80").length).toBeGreaterThan(0);
    expect(screen.getByTestId("disclaimer").textContent).toBe("Scores come from their hearts, your budget and the occasion. Not a sizing guarantee.");
    expect(screen.getByText("Similar pieces they haven't seen")).toBeTruthy();
    expect(screen.getByTestId("not-tried-label").textContent).toBe("Not shown to them");
    expect((await screen.findByTestId("gift-header-store")).textContent).toBe("for gorjana");
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/undertone|face shape|try-on|tried on|decoy|AI estimate|Aurum/i);
  });

  it("a try-on report keeps the four factors, the try-on disclaimer and the Aurum header", async () => {
    render(
      <>
        <GiftHeader />
        <GiverReport token={TOKEN} api={apiWith(completed)} products={products} />
      </>,
    );
    await screen.findAllByTestId("fit-report-item");
    expect(screen.getAllByText("Metal and undertone").length).toBeGreaterThan(0);
    expect(screen.getByTestId("disclaimer").textContent).toMatch(/AI try-on preview/);
    expect((await screen.findByTestId("gift-header-store")).textContent).toBe("for Aurum Jewelry");
  });

  it("Help me choose never shows the decoy line in the transparency card", async () => {
    const { container } = render(<GiverReport token={TOKEN} api={apiWith({ ...completed, mode: "help_me_choose" })} products={products} />);
    await screen.findAllByTestId("fit-report-item");
    expect(container.textContent).not.toMatch(/decoy|mixed with similar/i);
  });
});

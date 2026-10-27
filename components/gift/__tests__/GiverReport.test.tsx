// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GiverReportStatus } from "@/lib/contracts/api";
import { type GiftApi, normalizeReport } from "../api";
import { GiverReport } from "../report/GiverReport";

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

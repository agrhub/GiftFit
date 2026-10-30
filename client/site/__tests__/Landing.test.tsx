// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Landing } from "../Landing";

const STORE = "https://store.example";
const ORIGIN = "https://giftfit.example";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.documentElement.lang = "en";
});

function renderLanding(locale: "en" | "vi" = "en", previewMock = false) {
  return render(<Landing locale={locale} demoStoreUrl={STORE} origin={ORIGIN} previewMock={previewMock} />);
}

describe("Landing", () => {
  it("English: hero, CTAs, live code window, 4 features, 3 steps, docs, preview form, judge demo, credits", () => {
    renderLanding("en");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("The gift assistant for any store");
    expect(screen.getByTestId("cta-demo-store").getAttribute("href")).toBe(STORE);
    expect(screen.getByTestId("cta-demo-store").textContent).toBe("Open the demo store");
    expect(screen.getByTestId("cta-try").getAttribute("href")).toBe("#try");
    expect(screen.getByTestId("cta-try").textContent).toBe("Try it on your store");
    expect(document.getElementById("try")).toBeTruthy();
    expect(document.getElementById("store-url")).toBeTruthy();
    expect(screen.getByTestId("cta-merchants").getAttribute("href")).toBe("/merchants");
    expect(screen.getByTestId("code-snippet").textContent).toBe(`<script src="${ORIGIN}/giftfit.js" data-store="aurum" async></script>`);
    const features = within(screen.getByTestId("features")).getAllByRole("listitem");
    expect(features.map((li) => li.querySelector("h3")!.textContent)).toEqual(["Help me choose", "Private try-on", "Fit Report", "Voice, in the shopper's language"]);
    for (const li of features) expect(li.querySelector("svg")).toBeTruthy();
    expect(features[1].textContent).toContain("never shown to the giver");
    expect(screen.getByTestId("how-steps").querySelectorAll("li")).toHaveLength(3);
    expect(screen.getByTestId("link-judge-demo").getAttribute("href")).toBe("/demo");
    expect(screen.getByTestId("ai-note").textContent).toMatch(/AI-generated/);
    const credits = screen.getByTestId("site-credits").textContent!;
    for (const s of ["Live2D Inc.", "Mark-kun", "Google Cloud Speech-to-Text", "Text-to-Speech", "computer-generated", "YouCam", "Claude (Anthropic)"]) expect(credits).toContain(s);
    // Voice is Google Cloud TTS only (ADR-059): no in-browser model, no third-party model licence.
    expect(credits).not.toMatch(/super\s*tonic|rail-m|onnx/i);
    expect(document.querySelector('a[href*="/voice/"]')).toBeNull();
    // Landmarks and headings: one h1, a heading per section; no language switcher (the browser decides).
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    for (const name of ["See it run, right here", "What the assistant does", "How it works", "Quick start", "Paste your store URL", "For judges", "About and credits"]) {
      expect(screen.getByRole("heading", { level: 2, name })).toBeTruthy();
    }
    expect(screen.queryByRole("navigation", { name: "Language" })).toBeNull();
    expect(screen.queryByTestId("lang-en")).toBeNull();
  });

  it("does not load the widget before Run", () => {
    renderLanding("en");
    expect(document.querySelector('script[src*="giftfit.js"]')).toBeNull();
    expect(document.querySelector("giftfit-widget")).toBeNull();
  });

  it("Vietnamese: copy, CTA labels, plain links, <html lang> follows", () => {
    renderLanding("vi");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Trợ lý quà tặng cho mọi cửa hàng");
    expect(screen.getByTestId("cta-demo-store").textContent).toBe("Mở cửa hàng demo");
    expect(screen.getByTestId("cta-try").textContent).toBe("Thử trên cửa hàng của bạn");
    expect(screen.getByTestId("cta-merchants").getAttribute("href")).toBe("/merchants");
    expect(screen.getByRole("button", { name: "Chạy" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Tạo bản xem trước" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Bắt đầu nhanh" })).toBeTruthy();
    expect(screen.queryByTestId("lang-vi")).toBeNull();
    expect(screen.getByTestId("landing").getAttribute("lang")).toBe("vi");
    expect(document.documentElement.lang).toBe("vi");
  });

  it("Quick start tabs: HTML first with the attributes table; click and arrow keys switch panels", () => {
    renderLanding("en");
    const panel = (id: string) => screen.getByTestId(`docs-panel-${id}`);
    expect(panel("html").hidden).toBe(false);
    expect(panel("shopify").hidden).toBe(true);
    const rows = within(screen.getByTestId("docs-attrs")).getAllByRole("row");
    expect(rows.map((r) => r.querySelector("th")!.textContent)).toEqual(["data-store", "data-lang", "data-langs", "data-widget", "data-button"]);
    expect(screen.getByTestId("docs-code-html").textContent).toContain(`${ORIGIN}/giftfit.js`);

    fireEvent.click(screen.getByRole("tab", { name: "Shopify" }));
    expect(panel("shopify").hidden).toBe(false);
    expect(panel("html").hidden).toBe(true);
    expect(screen.getByRole("tab", { name: "Shopify" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("docs-code-shopify").textContent).not.toContain("data-lang");
    expect(panel("shopify").textContent).toContain("Shopify themes already set the page's language");
    expect(panel("shopify").textContent).toContain("layout/theme.liquid");

    fireEvent.keyDown(screen.getByRole("tab", { name: "Shopify" }), { key: "ArrowRight" });
    expect(panel("woo").hidden).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "WooCommerce / WordPress" }));
    expect(screen.getByTestId("docs-code-woo").textContent).toContain("add_action( 'wp_footer'");

    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(panel("gtm").hidden).toBe(false);
    expect(panel("gtm").textContent).toContain("Custom HTML");
    expect(panel("gtm").textContent).toContain("All Pages");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(panel("html").hidden).toBe(false);
  });

  it("copy buttons write the code to the clipboard and say so", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    renderLanding("en");
    await act(async () => {
      fireEvent.click(screen.getByTestId("docs-code-html-copy"));
    });
    expect(writeText).toHaveBeenCalledWith(`<script src="${ORIGIN}/giftfit.js" data-store="aurum" async></script>`);
    expect(screen.getByTestId("docs-code-html-copy").textContent).toBe("Copied");
  });

  it("prefers-reduced-motion adds the gf-motion-reduce class", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
    renderLanding("en");
    expect(screen.getByTestId("landing").className).toContain("gf-motion-reduce");
    expect(screen.getByTestId("landing").getAttribute("data-motion")).toBe("reduce");
  });

  it("full motion by default", () => {
    renderLanding("en");
    expect(screen.getByTestId("landing").className).not.toContain("gf-motion-reduce");
    expect(screen.getByTestId("landing").className).toContain("gf-dark");
  });
});

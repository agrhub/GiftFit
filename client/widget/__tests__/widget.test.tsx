// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GiftBrief } from "@/server/contracts/api";
import { GIFTS_KEY, SESSION_POLLED_KEY } from "@/server/widget/giver-store";
import { fitRequestBody } from "../BriefConfirm";
import { PlaceholderCharacter } from "../CharacterSlot";
import { WidgetApp } from "../WidgetApp";

const PARENT = "https://shop.example";
const brief: GiftBrief = { mode: "help_me_choose", occasion: "anniversary", budgetMax: 300, currency: "USD", categories: ["earring"], styleHints: ["minimal"] };
const match = { id: "cat-1", title: "Halo Drop Earrings", price: 345, currency: "USD" };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

describe("CharacterSlot placeholder", () => {
  it("is a labelled button that activates, bobs only without reduced motion, and shows the tip", () => {
    const onActivate = vi.fn();
    const { rerender } = render(<PlaceholderCharacter state="talking" mouth={1} tip="Gift this?" onActivate={onActivate} reducedMotion={false} label="Open the gift assistant" />);
    fireEvent.click(screen.getByRole("button", { name: "Open the gift assistant" }));
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toBe("Gift this?");
    expect((document.querySelector("svg") as SVGElement).style.animation).toContain("gf-bob");
    rerender(<PlaceholderCharacter state="thinking" onActivate={onActivate} reducedMotion />);
    expect((document.querySelector("svg") as SVGElement).style.animation).toBe("");
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByTestId("widget-character").getAttribute("data-state")).toBe("thinking");
  });
});

describe("fitRequestBody", () => {
  it("help me choose: the brief as is, no shortlist", () => {
    expect(fitRequestBody(brief, "help", match)).toEqual({ occasion: "anniversary", currency: "USD", mode: "help_me_choose", budgetMax: 300, shortlistIds: [], categories: ["earring"], styleHints: ["minimal"] });
  });
  it("I have ideas: the product on the page first, budget raised to cover it", () => {
    expect(fitRequestBody({ ...brief, mode: "i_have_ideas", shortlistIds: ["cat-2", "cat-1"] }, "ideas", match)).toEqual({ occasion: "anniversary", currency: "USD", mode: "i_have_ideas", budgetMax: 345, shortlistIds: ["cat-1", "cat-2"] });
  });
});

describe("WidgetApp", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith("/api/retailer/lookup")) return new Response(JSON.stringify({ found: true, product: match, embedPath: "/embed" }), { headers: { "Content-Type": "application/json" } });
      if (url === "/api/fit/report") return new Response(JSON.stringify({ status: "completed", expiresAt: "2099-01-01T00:00:00Z" }), { headers: { "Content-Type": "application/json" } });
      return new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  const host = (data: unknown, origin = PARENT) => act(() => window.dispatchEvent(new MessageEvent("message", { data, origin, source: window })));
  const ctx = { source: "giftfit-widget", v: 1, type: "context", product: { title: "Halo Drop Earrings", sku: "AUR-EAR-028", source: "json-ld" }, page: { lang: "vi" } };

  it("on a product page: matches the catalog, says “Gift this?” in the host's language, opens the panel", async () => {
    render(<WidgetApp store="aurum" parentOrigin={PARENT} allowedLangs={["en", "vi"]} baseUrl="https://giftfit.example" />);
    host(ctx, "https://evil.example");
    expect(screen.queryByTestId("widget-tip")).toBeNull();
    host(ctx);
    // The tip waits for the lazily loaded catalog chunk: slow on a loaded host.
    expect((await screen.findByTestId("widget-tip", {}, { timeout: 8000 })).textContent).toContain("Tặng món này?");
    const lookup = new URL(String(fetchMock.mock.calls.find((c) => String(c[0]).startsWith("/api/retailer/lookup"))![0]), "https://x");
    expect(lookup.searchParams.get("sku")).toBe("AUR-EAR-028");

    fireEvent.click(screen.getByRole("button", { name: "Mở trợ lý quà tặng" }));
    expect(await screen.findByTestId("widget-panel")).toBeTruthy();
    expect(screen.getByTestId("widget-intro").textContent).toContain("Halo Drop Earrings");
    expect(screen.getByRole("button", { name: "Tặng món này" })).toBeTruthy();
  });

  it("tells a returning giver their Fit Report is ready (one lazy check per session)", async () => {
    const token = "T".repeat(43);
    localStorage.setItem(GIFTS_KEY, JSON.stringify([{ giverToken: token, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString() }]));
    render(<WidgetApp store="aurum" parentOrigin={PARENT} allowedLangs={["en", "vi"]} baseUrl="https://giftfit.example" />);
    expect((await screen.findByTestId("widget-tip")).textContent).toContain("Fit Report");
    expect(sessionStorage.getItem(SESSION_POLLED_KEY)).toBe("1");
    expect(fetchMock.mock.calls.filter((c) => c[0] === "/api/fit/report")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /gift assistant/i }));
    const link = (await screen.findByTestId("widget-ready")) as HTMLAnchorElement;
    expect(link.href).toBe(`https://giftfit.example/g/${token}`);
    await waitFor(() => expect(JSON.parse(localStorage.getItem(GIFTS_KEY)!)[0].announced).toBe(true));
  });

  it("opened directly (no parent) it is a page with the panel open and no close button", () => {
    render(<WidgetApp store="aurum" parentOrigin={null} allowedLangs={["en"]} baseUrl="https://giftfit.example" />);
    expect(screen.getByTestId("widget-panel")).toBeTruthy();
    expect(screen.queryByTestId("widget-close")).toBeNull();
    expect(screen.getByTestId("widget-intro").textContent).toContain("Tell me who the gift is for");
  });
});

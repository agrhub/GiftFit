// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateFitRequestBody, GiftBrief, GiftMode } from "@/lib/contracts/api";
import { ApiError, type GiftApi } from "../api";
import { GiverPanel } from "../GiverPanel";
import type { GiftPiece } from "../giverDraft";

afterEach(cleanup);

const piece = (id: string, price: number, extra: Partial<GiftPiece> = {}): GiftPiece => ({ id, slug: id, title: `Piece ${id}`, price, currency: "USD", image: `/catalog/${id}.png`, category: "earring", occasions: ["anniversary"], ...extra });
const hero = piece("hero", 245, {
  title: "Halo Drop Earrings",
  variants: [
    { metal: "yellow_gold", price: 245 },
    { metal: "white_gold", price: 265 },
    { metal: "rose_gold", price: 249 },
  ],
});
const catalog = [hero, piece("s1", 199), piece("s2", 260), piece("s3", 180), piece("s4", 210), piece("s5", 290)];

function fakeApi(): GiftApi & { createFitRequest: ReturnType<typeof vi.fn> } {
  return {
    createFitRequest: vi.fn(async (body: CreateFitRequestBody) => ({
      fitRequestIdHint: body.occasion,
      fitRequestId: "fr1",
      giverToken: "g".repeat(43),
      recipientPath: `/r/${"r".repeat(43)}`,
      giverReportPath: `/g/${"g".repeat(43)}`,
      expiresAt: new Date(Date.now() + 72 * 3600e3).toISOString(),
      carouselSize: 6,
    })),
  } as unknown as GiftApi & { createFitRequest: ReturnType<typeof vi.fn> };
}

function renderPanel(api = fakeApi(), mode: GiftMode = "i_have_ideas") {
  render(<GiverPanel open onClose={() => undefined} initialPieces={[hero]} catalog={catalog} api={api} initialMode={mode} />);
  return api;
}

describe("GiverPanel: Help me choose (default, ADR-045)", () => {
  it("starts in Help me choose with no shortlist, and sends the brief", async () => {
    const api = fakeApi();
    render(<GiverPanel open onClose={() => undefined} initialPieces={[hero]} catalog={catalog} api={api} />);
    expect((screen.getByTestId("mode-help_me_choose") as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByTestId("shortlist")).toBeNull();
    expect(screen.queryByTestId("add-to-shortlist")).toBeNull();
    fireEvent.click(screen.getByTestId("send-fit-request"));
    expect(await screen.findByText("Choose the occasion.")).toBeTruthy();
    fireEvent.click(screen.getByTestId("occasion-birthday"));
    fireEvent.click(screen.getByTestId("budget-300"));
    fireEvent.click(screen.getByTestId("lock-gold"));
    fireEvent.click(screen.getByTestId("category-earring"));
    fireEvent.click(screen.getByTestId("category-necklace"));
    fireEvent.click(screen.getByTestId("style-minimal"));
    fireEvent.click(screen.getByTestId("presentation-feminine"));
    fireEvent.click(screen.getByTestId("send-fit-request"));
    await waitFor(() => expect(api.createFitRequest).toHaveBeenCalledTimes(1));
    expect(api.createFitRequest.mock.calls[0][0]).toEqual({
      storeId: expect.any(String),
      mode: "help_me_choose",
      occasion: "birthday",
      budgetMax: 300,
      metalLock: ["yellow_gold", "rose_gold"],
      currency: "USD",
      shortlistIds: [],
      categories: ["earring", "necklace"],
      styleHints: ["minimal"],
      genderPresentation: "feminine",
    });
    const sent = await screen.findByTestId("fit-request-sent");
    expect(within(sent).getByTestId("curated-note").textContent).toMatch(/6 pieces picked by GiftFit/);
  });

  it("switches to I have ideas (the PDP piece is kept) and back", () => {
    renderPanel(fakeApi(), "help_me_choose");
    fireEvent.click(screen.getByTestId("use-my-picks"));
    expect((screen.getByTestId("mode-i_have_ideas") as HTMLInputElement).checked).toBe(true);
    expect(within(screen.getByTestId("shortlist")).getByText("Halo Drop Earrings")).toBeTruthy();
    fireEvent.click(screen.getByTestId("mode-help_me_choose"));
    expect(screen.queryByTestId("shortlist")).toBeNull();
  });

  it("pre-fills from a GiftBrief (Gift Concierge hand-over)", async () => {
    const api = fakeApi();
    const brief: GiftBrief = { mode: "help_me_choose", occasion: "anniversary", budgetMax: 275, currency: "USD", categories: ["necklace"], metalLock: ["yellow_gold"], styleHints: ["classic", "minimal"], genderPresentation: "unisex" };
    const { rerender } = render(<GiverPanel open onClose={() => undefined} initialPieces={[]} catalog={catalog} api={api} brief={null} />);
    rerender(<GiverPanel open onClose={() => undefined} initialPieces={[]} catalog={catalog} api={api} brief={brief} />);
    expect((screen.getByTestId("occasion-anniversary") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId("budget-custom") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Maximum ($)") as HTMLInputElement).value).toBe("275");
    expect((screen.getByTestId("lock-yellow_gold") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId("category-necklace") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId("style-classic") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId("presentation-unisex") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByTestId("send-fit-request"));
    await waitFor(() => expect(api.createFitRequest).toHaveBeenCalledTimes(1));
    expect(api.createFitRequest.mock.calls[0][0]).toMatchObject({ mode: "help_me_choose", budgetMax: 275, categories: ["necklace"], styleHints: ["classic", "minimal"], genderPresentation: "unisex", metalLock: ["yellow_gold"] });
  });

  it("opens the Gift Concierge inside the panel and fills the form from its brief", async () => {
    const brief: GiftBrief = { mode: "help_me_choose", occasion: "anniversary", budgetMax: 300, currency: "USD", styleHints: ["minimal"], genderPresentation: "feminine" };
    const ndjson = [{ type: "start", source: "mock" }, { type: "text", delta: "Here is a draft." }, { type: "final", brief, suggestions: [], source: "mock", degraded: false }].map((e) => JSON.stringify(e)).join("\n") + "\n";
    const fetchMock = vi.fn(async () => new Response(ndjson, { status: 200, headers: { "content-type": "application/x-ndjson" } }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      render(<GiverPanel open onClose={() => undefined} initialPieces={[hero]} catalog={catalog} api={fakeApi()} />);
      fireEvent.click(screen.getByTestId("open-concierge"));
      const view = screen.getByTestId("giver-concierge");
      expect(screen.queryByTestId("send-fit-request")).toBeNull();
      fireEvent.change(within(view).getByRole("textbox"), { target: { value: "Anniversary gift, minimal, about $300" } });
      fireEvent.submit(within(view).getByRole("textbox").closest("form")!);
      fireEvent.click(await within(view).findByRole("button", { name: /use this brief/i }));
      await waitFor(() => expect(screen.queryByTestId("giver-concierge")).toBeNull());
      expect((screen.getByTestId("mode-help_me_choose") as HTMLInputElement).checked).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // Back to the form, nothing sent yet: the giver reviews first.
      expect(screen.getByTestId("send-fit-request")).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("explains a 422 in Help me choose", async () => {
    const api = fakeApi();
    api.createFitRequest.mockRejectedValueOnce(new ApiError(422, "insufficient_catalog"));
    renderPanel(api, "help_me_choose");
    fireEvent.click(screen.getByTestId("occasion-birthday"));
    fireEvent.click(screen.getByTestId("budget-150"));
    fireEvent.click(screen.getByTestId("send-fit-request"));
    expect(await screen.findByText(/Not enough pieces fit this budget/)).toBeTruthy();
  });
});

describe("GiverPanel: I have ideas", () => {
  it("blocks sending until occasion and budget cap are chosen", async () => {
    const api = renderPanel();
    fireEvent.click(screen.getByTestId("send-fit-request"));
    expect(await screen.findByText("Choose the occasion.")).toBeTruthy();
    expect(screen.getByText("Choose a budget cap.")).toBeTruthy();
    expect(api.createFitRequest).not.toHaveBeenCalled();
  });

  it("caps the shortlist at 4 designs", () => {
    renderPanel();
    const add = () => screen.getAllByTestId("add-to-shortlist").find((b) => !(b as HTMLButtonElement).disabled)!;
    fireEvent.click(add());
    fireEvent.click(add());
    fireEvent.click(add());
    expect(screen.getByTestId("shortlist-count").textContent).toBe("4 of 4 designs");
    for (const b of screen.getAllByTestId("add-to-shortlist")) expect((b as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/shortlist is full/)).toBeTruthy();
  });

  it("requires at least one design", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Remove Halo Drop Earrings from shortlist" }));
    fireEvent.click(screen.getByTestId("occasion-anniversary"));
    fireEvent.click(screen.getByTestId("budget-300"));
    fireEvent.click(screen.getByTestId("send-fit-request"));
    expect(await screen.findByText("Add at least one design to your shortlist.")).toBeTruthy();
  });

  it("validates a custom cap", async () => {
    renderPanel();
    fireEvent.click(screen.getByTestId("occasion-birthday"));
    fireEvent.click(screen.getByTestId("budget-custom"));
    fireEvent.change(screen.getByLabelText("Maximum ($)"), { target: { value: "0" } });
    fireEvent.click(screen.getByTestId("send-fit-request"));
    expect(await screen.findByText(/Enter a maximum/)).toBeTruthy();
  });

  it("shows the metals within the cap and lock per design, and blocks an ineligible design", async () => {
    const api = renderPanel();
    const note = () => within(screen.getByTestId("shortlist")).getByTestId("shortlist-metals").textContent;
    expect(note()).toBe("3 metals · from $245");
    fireEvent.click(screen.getByTestId("budget-300"));
    expect(note()).toBe("3 metals within your budget");
    fireEvent.click(screen.getByTestId("lock-white"));
    expect(note()).toBe("White gold within your budget");
    fireEvent.click(screen.getByTestId("lock-silver"));
    expect(note()).toBe("No metal within your budget and metal choice");
    fireEvent.click(screen.getByTestId("occasion-anniversary"));
    fireEvent.click(screen.getByTestId("send-fit-request"));
    expect(await screen.findByText(/has no metal within your budget and metal choice/)).toBeTruthy();
    expect(api.createFitRequest).not.toHaveBeenCalled();
  });

  it("explains a 422 from the server", async () => {
    const api = fakeApi();
    api.createFitRequest.mockRejectedValueOnce(new ApiError(422, "no_eligible_variant"));
    renderPanel(api);
    fireEvent.click(screen.getByTestId("occasion-anniversary"));
    fireEvent.click(screen.getByTestId("budget-300"));
    fireEvent.click(screen.getByTestId("send-fit-request"));
    expect(await screen.findByText(/has no metal within your budget and metal choice. Raise the cap/)).toBeTruthy();
  });

  it("sends the demo request (cap $300, gold lock) and shows the share link, copy and QR", async () => {
    const api = renderPanel();
    fireEvent.click(screen.getByTestId("occasion-anniversary"));
    fireEvent.click(screen.getByTestId("budget-300"));
    fireEvent.click(screen.getByTestId("lock-gold"));
    fireEvent.click(screen.getAllByTestId("add-to-shortlist")[0]);
    fireEvent.click(screen.getAllByTestId("add-to-shortlist")[0]);
    fireEvent.click(screen.getByTestId("send-fit-request"));
    await waitFor(() => expect(api.createFitRequest).toHaveBeenCalledTimes(1));
    const body = api.createFitRequest.mock.calls[0][0] as CreateFitRequestBody;
    expect(body).toMatchObject({ mode: "i_have_ideas", occasion: "anniversary", budgetMax: 300, metalLock: ["yellow_gold", "rose_gold"], currency: "USD" });
    expect(body.budgetMin).toBeUndefined();
    expect(body.shortlistIds).toHaveLength(3);
    expect(body.shortlistIds[0]).toBe("hero");

    const sent = await screen.findByTestId("fit-request-sent");
    expect((within(sent).getByTestId("recipient-link") as HTMLInputElement).value).toMatch(/\/r\/r{43}$/);
    expect(within(sent).getByTestId("copy-link")).toBeTruthy();
    fireEvent.click(within(sent).getByTestId("show-qr"));
    expect(within(sent).getByTestId("qr-code")).toBeTruthy();
    expect(within(sent).getByTestId("giver-report-link").getAttribute("href")).toBe(`/g/${"g".repeat(43)}`);
  });
});

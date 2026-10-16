// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateFitRequestBody } from "@/lib/contracts/api";
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

function renderPanel(api = fakeApi()) {
  render(<GiverPanel open onClose={() => undefined} initialPieces={[hero]} catalog={catalog} api={api} />);
  return api;
}

describe("GiverPanel", () => {
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
    expect(body).toMatchObject({ occasion: "anniversary", budgetMax: 300, metalLock: ["yellow_gold", "rose_gold"], currency: "USD" });
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

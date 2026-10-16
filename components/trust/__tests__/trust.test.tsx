// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DISCLAIMER_TEXT, DeleteEverythingButton, Disclaimer, GiverTransparencyCard, RecipientTransparencyCard, UndertoneEstimateCard } from "..";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const HEX = /#[0-9a-fA-F]{6}/;

describe("Disclaimer", () => {
  it("states the exact shared disclaimer", () => {
    render(<Disclaimer />);
    expect(screen.getByRole("note").textContent).toBe("AI try-on preview. Undertone and face shape are estimates. Not a sizing guarantee.");
    expect(DISCLAIMER_TEXT).toContain("estimates");
  });
});

describe("Transparency Cards", () => {
  it("tells the recipient what is used, kept, and what the giver sees", () => {
    render(<RecipientTransparencyCard hasHandPhoto={false} expiresAt="2026-10-23T12:00:00Z" />);
    const card = screen.getByRole("region", { name: "Your privacy" });
    const text = card.textContent ?? "";
    expect(text).toMatch(/1 selfie/);
    expect(text).toMatch(/Optional: 1 back-of-hand photo/);
    expect(text).toMatch(/kept for at most 1 hour, only so you can try other metals/);
    expect(text).toMatch(/deleted when you tap Done/);
    expect(text).toMatch(/Delete my photo now.{1,3} removes your selfie, hand photo and every try-on image right away; your picks are kept until Done/);
    expect(text).toMatch(/estimates only/);
    expect(text).toMatch(/Never your photo,/);
    expect(text).toMatch(/Oct 23, 2026/);
    expect(text).toMatch(/YouCam/);
  });

  it("mentions the hand photo when one was given", () => {
    render(<RecipientTransparencyCard hasHandPhoto />);
    expect(screen.getByText(/^1 back-of-hand photo, for rings/)).toBeTruthy();
  });

  it("tells the giver what they will and won't see, with no images and no hex anywhere", () => {
    const { container } = render(<GiverTransparencyCard expiresAt={new Date("2026-10-23T12:00:00Z")} />);
    const text = container.textContent ?? "";
    expect(text).toMatch(/Fit Score from 0 to 100/);
    expect(text).toMatch(/Their photos or any try-on image/);
    expect(text).toMatch(/estimates/);
    expect(container.querySelectorAll("img, picture, video, canvas, svg image").length).toBe(0);
    expect(container.innerHTML).not.toMatch(HEX);
  });

  it("uses labelled regions with headings", () => {
    render(
      <>
        <RecipientTransparencyCard />
        <GiverTransparencyCard />
      </>,
    );
    expect(screen.getAllByRole("region")).toHaveLength(2);
    expect(screen.getByRole("heading", { level: 2, name: "What you will and won't see" })).toBeTruthy();
  });
});

describe("UndertoneEstimateCard", () => {
  it("labels the undertone as an estimate and offers warm / neutral / cool", () => {
    render(<UndertoneEstimateCard estimate="warm" confidence={0.8} onChange={() => {}} />);
    expect(screen.getByText("Estimate")).toBeTruthy();
    expect(screen.getByText(/Our AI estimate from your selfie/).textContent).toMatch(/Warm/);
    const group = screen.getByRole("group");
    expect(group.querySelector("legend")?.textContent).toMatch(/change it/);
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((r) => r.value)).toEqual(["warm", "neutral", "cool"]);
    expect((screen.getByLabelText(/Warm/) as HTMLInputElement).checked).toBe(true);
  });

  it("asks the recipient to check when confidence is low", () => {
    render(<UndertoneEstimateCard estimate="neutral" confidence={0.2} onChange={() => {}} />);
    expect(screen.getByText(/not sure/i)).toBeTruthy();
    expect(screen.getByText(/Please pick the one that fits you best/)).toBeTruthy();
  });

  it("saves an override through the recipient API and can go back to the estimate", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<UndertoneEstimateCard estimate="warm" confidence={0.8} sessionToken="tok" />);
    fireEvent.click(screen.getByLabelText(/Cool/));
    await waitFor(() => expect(screen.getByText(/Saved/)).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith("/api/recipient/undertone", expect.objectContaining({ method: "POST", body: JSON.stringify({ undertone: "cool" }) }));
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(screen.getByText(/Using your choice/).textContent).toMatch(/Cool/);

    fireEvent.click(screen.getByRole("button", { name: "Use the estimate instead" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body).toBe(JSON.stringify({ undertone: null }));
    await waitFor(() => expect((screen.getByLabelText(/Warm/) as HTMLInputElement).checked).toBe(true));
  });

  it("reverts and says so when saving fails", async () => {
    const onChange = vi.fn(async () => {
      throw new Error("offline");
    });
    render(<UndertoneEstimateCard estimate="warm" confidence={0.8} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText(/Neutral/));
    await waitFor(() => expect(screen.getByText(/Could not save/)).toBeTruthy());
    expect((screen.getByLabelText(/Warm/) as HTMLInputElement).checked).toBe(true);
  });

  it("may show the recipient their own hex, and ignores malformed values", () => {
    const { container, unmount } = render(<UndertoneEstimateCard estimate="warm" confidence={0.8} skinHex="#c68e6b" onChange={() => {}} />);
    expect(screen.getByText("#c68e6b")).toBeTruthy();
    expect(container.textContent).toMatch(/only you see this/);
    unmount();
    const again = render(<UndertoneEstimateCard estimate="warm" confidence={0.8} skinHex="javascript:alert(1)" onChange={() => {}} />);
    expect(again.container.innerHTML).not.toMatch(/javascript/);
  });
});

describe("DeleteEverythingButton", () => {
  it("deletes with one tap and confirms", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, verified: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const onDeleted = vi.fn();
    render(<DeleteEverythingButton onDeleted={onDeleted} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete everything" }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith("/api/recipient/delete", expect.objectContaining({ method: "POST", credentials: "same-origin" }));
    expect(screen.getByRole("status").textContent).toMatch(/Done\. Your photos, try-ons, estimates and hearts are deleted/);
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("reports failure and allows a retry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "x" }), { status: 500 })));
    render(<DeleteEverythingButton />);
    fireEvent.click(screen.getByRole("button", { name: "Delete everything" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/Something went wrong/));
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(false);
  });
});

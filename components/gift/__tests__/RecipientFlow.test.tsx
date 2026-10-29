// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CaptureResponse, RecipientSessionResponse, SwatchResponse } from "@/lib/contracts/api";
import type { GiftApi } from "../api";

// The camera UI needs a real browser; stand in a button that "takes" a photo.
vi.mock("../recipient/CaptureStep", () => ({
  CaptureStep: ({ mode, onConfirm, onSkip, error, onPhotoChange }: { mode: string; onConfirm: (b: Blob) => void; onSkip?: () => void; error?: string | null; onPhotoChange?: (b: boolean) => void }) => (
    <div>
      {onPhotoChange ? (
        <button type="button" onClick={() => onPhotoChange(true)}>
          fake review
        </button>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      <button type="button" onClick={() => onConfirm(new Blob(["x"], { type: "image/jpeg" }))}>
        fake {mode}
      </button>
      {onSkip ? (
        <button type="button" onClick={onSkip}>
          skip
        </button>
      ) : null}
    </div>
  ),
}));

import { RecipientFlow } from "../recipient/RecipientFlow";
import { GiftHeader } from "../GiftHeader";

afterEach(cleanup);
const TOKEN = "r".repeat(43);

const sw = (id: string, metalLabel: string, swatchColor: string, isDefault = false) => ({ swatchId: id, metalLabel, swatchColor, isDefault });
const items: RecipientSessionResponse["items"] = [
  { itemId: "i1", title: "Halo Drop Earrings", category: "earring", productImage: "/a.jpg", needsHandPhoto: false, swatches: [sw("s1y", "Yellow gold", "#d4b062", true), sw("s1w", "White gold", "#d9d9d6"), sw("s1r", "Rose gold", "#d39a85")] },
  { itemId: "i2", title: "Crescent Pendant", category: "necklace", productImage: "/b.jpg", needsHandPhoto: false, swatches: [sw("s2r", "Rose gold", "#d39a85", true), sw("s2s", "Sterling silver", "#c8cacc")] },
  { itemId: "i3", title: "Summit Band", category: "ring", productImage: "/c.jpg", needsHandPhoto: true, swatches: [sw("s3w", "White gold", "#d9d9d6", true)] },
];
const session = (status: RecipientSessionResponse["status"]): RecipientSessionResponse => ({ status, occasion: "anniversary", expiresAt: "2026-10-18T12:00:00.000Z", items });
const capture: CaptureResponse = {
  tryons: [
    { itemId: "i1", swatchId: "s1y", status: "ready", imageUrl: "/t/1" },
    { itemId: "i2", swatchId: "s2r", status: "ready", imageUrl: "/t/2" },
    { itemId: "i3", swatchId: "s3w", status: "skipped_needs_hand" },
  ],
  undertone: { estimate: "warm", confidence: 0.7, override: null, label: "Warm undertone estimate" },
  faceShapeLabel: "Oval",
  processingSeconds: 21,
};

function api(start: RecipientSessionResponse["status"] = "awaiting_consent", resumed: CaptureResponse | null = null) {
  return {
    resumeCapture: vi.fn(async (): Promise<CaptureResponse | null> => resumed),
    openSession: vi.fn(async () => session(start)),
    consent: vi.fn(async () => session("awaiting_capture")),
    capture: vi.fn(async (): Promise<CaptureResponse> => capture),
    saveHearts: vi.fn<(t: string, hearts: Array<{ itemId: string; swatchId?: string }>) => Promise<void>>(async () => undefined),
    trySwatch: vi.fn(async (_t: string, itemId: string, swatchId: string): Promise<SwatchResponse> => ({ status: "ready", imageUrl: `/t/${itemId}-${swatchId}`, rendersLeft: 3 })),
    wishMetal: vi.fn(async () => undefined),
    deletePhoto: vi.fn(async () => ({ photoDeleted: true as const, rendersLeft: 0 as const })),
    finish: vi.fn(async () => ({ photosDeleted: true as const, photosStored: 0 as const, completedAt: "now" })),
    setUndertone: vi.fn(async () => undefined),
  };
}
const asApi = (a: ReturnType<typeof api>) => a as unknown as GiftApi;

describe("RecipientFlow", () => {
  it("runs consent → selfie → hand (skipped) → carousel → hearts → undertone → done", async () => {
    const a = api();
    render(<RecipientFlow token={TOKEN} api={asApi(a)} />);
    expect(await screen.findByText("Someone who cares about you is choosing a gift.")).toBeTruthy();
    expect(screen.getByText("They will never see your photos.")).toBeTruthy();
    fireEvent.click(screen.getByTestId("consent-accept"));

    fireEvent.click(await screen.findByText("fake selfie"));
    expect(await screen.findByText("Add your hand?")).toBeTruthy();
    fireEvent.click(screen.getByText("skip"));

    await screen.findByTestId("tryon-screen");
    expect(a.capture).toHaveBeenCalledWith(TOKEN, expect.objectContaining({ hand: null }));
    expect(await screen.findAllByTestId("carousel-item")).toHaveLength(3);
    expect(screen.getAllByText("AI preview")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Heart Crescent Pendant, rose gold" }));
    fireEvent.click(screen.getByTestId("send-hearts"));
    await waitFor(() => expect(a.saveHearts).toHaveBeenCalledWith(TOKEN, [{ itemId: "i2", swatchId: "s2r" }]));

    expect(await screen.findByText("One last check")).toBeTruthy();
    expect(await screen.findByText("Estimate")).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Cool/));
    await waitFor(() => expect(a.setUndertone).toHaveBeenCalledWith(TOKEN, "cool"));
    fireEvent.click(screen.getByTestId("finish"));

    const done = await screen.findByTestId("done-screen");
    expect(done.textContent).toContain("Done. Your photos are deleted.");
    expect(done.textContent).toContain("The surprise is safe.");
    expect(screen.getByTestId("photos-stored").textContent).toBe("0");
    expect(screen.getByTestId("delete-everything").querySelector("button")).toBeTruthy();
  });

  it("shows the expired screen and the already-done screen", async () => {
    render(<RecipientFlow token={TOKEN} api={asApi(api("expired"))} />);
    expect(await screen.findByTestId("expired-screen")).toBeTruthy();
    cleanup();
    render(<RecipientFlow token={TOKEN} api={asApi(api("completed"))} />);
    expect((await screen.findByTestId("done-screen")).textContent).toContain("already sent your hearts");
  });

  it("returns to the selfie step with a message when capture fails", async () => {
    const a = api("awaiting_capture");
    a.capture.mockRejectedValueOnce(new Error("boom"));
    render(<RecipientFlow token={TOKEN} api={asApi(a)} />);
    fireEvent.click(await screen.findByText("fake selfie"));
    fireEvent.click(await screen.findByText("skip"));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("Take a selfie")).toBeTruthy();
  });

  it("restores the carousel after a reload (trying_on + GET capture)", async () => {
    const a = api("trying_on", capture);
    render(<RecipientFlow token={TOKEN} api={asApi(a)} />);
    await screen.findByTestId("tryon-screen");
    expect(a.resumeCapture).toHaveBeenCalledWith(TOKEN);
    expect(await screen.findAllByText("AI preview")).toHaveLength(2);
    expect(screen.getByAltText("AI preview of you wearing Halo Drop Earrings in yellow gold").getAttribute("src")).toBe("/t/1");
    expect(a.capture).not.toHaveBeenCalled();
  });

  it("asks for a selfie again when trying_on has nothing to restore (404 not_captured)", async () => {
    render(<RecipientFlow token={TOKEN} api={asApi(api("trying_on", null))} />);
    expect(await screen.findByText("Take a selfie")).toBeTruthy();
  });

  it("lets a finished recipient see the previews again, read-only", async () => {
    render(<RecipientFlow token={TOKEN} api={asApi(api("completed", capture))} />);
    fireEvent.click(await screen.findByTestId("view-previews"));
    await screen.findByTestId("tryon-screen");
    expect(screen.getByText("Your previews")).toBeTruthy();
    expect(await screen.findAllByTestId("carousel-item")).toHaveLength(3);
    expect(screen.queryAllByTestId("heart")).toHaveLength(0);
    expect(screen.queryByTestId("send-hearts")).toBeNull();
  });

  it("maps an earlobe failure to a retake that keeps hearts", async () => {
    const a = api("awaiting_capture");
    const earFail: CaptureResponse = { ...capture, tryons: [{ itemId: "i1", status: "failed", failureReason: "2" }, ...capture.tryons.slice(1)] };
    a.capture.mockResolvedValueOnce(earFail);
    render(<RecipientFlow token={TOKEN} api={asApi(a)} />);
    fireEvent.click(await screen.findByText("fake selfie"));
    fireEvent.click(await screen.findByText("skip"));
    expect(await screen.findByText(/We couldn't see your ears, so this earring preview was skipped/)).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Heart Crescent Pendant, rose gold" }));
    fireEvent.click(screen.getByTestId("retake-selfie"));
    expect(await screen.findByText("Retake your selfie")).toBeTruthy();
    expect(screen.getByText(/Your hearts are kept/)).toBeTruthy();
    fireEvent.click(await screen.findByText("fake selfie"));
    fireEvent.click(await screen.findByText("skip"));
    await screen.findByTestId("tryon-screen");
    expect(await screen.findAllByText("AI preview")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Heart Crescent Pendant, rose gold" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByTestId("send-hearts"));
    await waitFor(() => expect(a.saveHearts).toHaveBeenCalledWith(TOKEN, [{ itemId: "i2", swatchId: "s2r" }]));
    expect(a.capture).toHaveBeenCalledTimes(2);
  });

  describe("metal variants (ADR-032)", () => {
    const halo = () => screen.getAllByTestId("carousel-item")[0];
    async function openCarousel(a: ReturnType<typeof api>) {
      render(<RecipientFlow token={TOKEN} api={asApi(a)} />);
      await screen.findByTestId("tryon-screen");
      await screen.findAllByTestId("carousel-item");
    }

    it("renders a tapped swatch lazily, with a loading state on that card only", async () => {
      const a = api("trying_on", capture);
      let release!: () => void;
      a.trySwatch.mockImplementationOnce(
        (_t: string, itemId: string, swatchId: string) =>
          new Promise<SwatchResponse>((res) => {
            release = () => res({ status: "ready", imageUrl: `/t/${itemId}-${swatchId}`, rendersLeft: 3 });
          }),
      );
      await openCarousel(a);
      const swatches = within(halo()).getAllByRole("radio");
      expect(swatches.map((b) => b.getAttribute("aria-label"))).toEqual(["Yellow gold", "White gold", "Rose gold"]);
      expect(swatches[0].getAttribute("aria-checked")).toBe("true");
      fireEvent.click(swatches[1]);
      expect(await within(halo()).findByTestId("swatch-loading")).toBeTruthy();
      expect(screen.getAllByTestId("swatch-loading")).toHaveLength(1);
      expect(a.trySwatch).toHaveBeenCalledWith(TOKEN, "i1", "s1w");
      release();
      const img = await within(halo()).findByAltText("AI preview of you wearing Halo Drop Earrings in white gold");
      expect(img.getAttribute("src")).toBe("/t/i1-s1w");
      expect(within(halo()).queryByTestId("swatch-loading")).toBeNull();
      // Back to yellow: cached, no new call.
      fireEvent.click(within(halo()).getAllByRole("radio")[0]);
      expect(within(halo()).getByAltText("AI preview of you wearing Halo Drop Earrings in yellow gold")).toBeTruthy();
      expect(a.trySwatch).toHaveBeenCalledTimes(1);
    });

    it("shows the cap note and keeps the previous metal when the extra renders run out", async () => {
      const a = api("trying_on", capture);
      a.trySwatch.mockResolvedValueOnce({ status: "cap_reached", rendersLeft: 0 });
      await openCarousel(a);
      fireEvent.click(within(halo()).getAllByRole("radio")[2]);
      expect((await within(halo()).findByTestId("cap-note")).textContent).toBe("You've tried all the extra metals we can show this time.");
      expect(within(halo()).getAllByRole("radio")[0].getAttribute("aria-checked")).toBe("true");
    });

    it("hearts the metal shown and sends hearts per variant", async () => {
      const a = api("trying_on", capture);
      await openCarousel(a);
      fireEvent.click(within(halo()).getAllByRole("radio")[1]);
      await within(halo()).findByAltText(/in white gold/);
      fireEvent.click(screen.getByRole("button", { name: "Heart Halo Drop Earrings, white gold" }));
      // The heart belongs to white gold: switching back to yellow shows it un-hearted.
      fireEvent.click(within(halo()).getAllByRole("radio")[0]);
      expect(screen.getByRole("button", { name: "Heart Halo Drop Earrings, yellow gold" }).getAttribute("aria-pressed")).toBe("false");
      fireEvent.click(screen.getByRole("button", { name: "Heart Crescent Pendant, rose gold" }));
      fireEvent.click(screen.getByTestId("send-hearts"));
      await waitFor(() =>
        expect(a.saveHearts).toHaveBeenCalledWith(TOKEN, [
          { itemId: "i1", swatchId: "s1w" },
          { itemId: "i2", swatchId: "s2r" },
        ]),
      );
    });

    it("sends 'wish it came in another metal' in one tap with a confirmation", async () => {
      const a = api("trying_on", capture);
      await openCarousel(a);
      const wish = within(halo()).getByTestId("wish-metal");
      expect(wish.textContent).toBe("Love the style, wish it came in another metal");
      fireEvent.click(wish);
      await waitFor(() => expect(a.wishMetal).toHaveBeenCalledWith(TOKEN, "i1"));
      expect(await screen.findByText(/Thanks, noted/)).toBeTruthy();
      expect(within(halo()).getByTestId("wish-metal").getAttribute("aria-pressed")).toBe("true");
    });

    it("never shows a price anywhere in the recipient flow", async () => {
      const a = api();
      render(<RecipientFlow token={TOKEN} api={asApi(a)} />);
      const noPrice = () => expect(document.body.textContent ?? "").not.toMatch(/\$\s?\d|USD|price/i);
      await screen.findByTestId("consent-screen");
      noPrice();
      fireEvent.click(screen.getByTestId("consent-accept"));
      fireEvent.click(await screen.findByText("fake selfie"));
      fireEvent.click(await screen.findByText("skip"));
      await screen.findAllByTestId("carousel-item");
      noPrice();
      fireEvent.click(within(halo()).getAllByRole("radio")[1]);
      await within(halo()).findByAltText(/in white gold/);
      noPrice();
      fireEvent.click(screen.getByTestId("send-hearts"));
      await screen.findByTestId("undertone-screen");
      noPrice();
      fireEvent.click(screen.getByTestId("finish"));
      await screen.findByTestId("done-screen");
      noPrice();
    });
  });

  describe("Delete my photo now (ADR-036)", () => {
    it("says on the consent screen that the photo is kept for at most 1 hour", async () => {
      render(<RecipientFlow token={TOKEN} api={asApi(api())} />);
      await screen.findByTestId("consent-screen");
      expect(screen.getByText("They will never see your photos.")).toBeTruthy();
      expect(screen.getByTestId("photo-retention").textContent).toBe(
        "We keep your photos for at most 1 hour so you can try other metals. They're deleted when you tap Finish, or right away with Delete my photo now, and the giver never sees them.",
      );
      expect(screen.queryByTestId("delete-photo-now")).toBeNull();
    });

    it("is visible on every step after a photo exists: review, hand, processing, carousel, undertone", async () => {
      const a = api("awaiting_capture");
      let finishCapture!: () => void;
      a.capture.mockImplementationOnce(() => new Promise<CaptureResponse>((res) => (finishCapture = () => res(capture))));
      render(<RecipientFlow token={TOKEN} api={asApi(a)} />);
      await screen.findByText("fake selfie");
      expect(screen.queryByTestId("delete-photo-now")).toBeNull();
      fireEvent.click(screen.getByText("fake review"));
      expect(screen.getByTestId("delete-photo-now")).toBeTruthy(); // selfie review
      fireEvent.click(screen.getByText("fake selfie"));
      await screen.findByText("Add your hand?");
      expect(screen.getByTestId("delete-photo-now")).toBeTruthy(); // hand step
      fireEvent.click(screen.getByText("skip"));
      await screen.findByTestId("processing");
      expect(screen.getByTestId("delete-photo-now")).toBeTruthy(); // processing
      finishCapture();
      await screen.findByTestId("tryon-screen");
      expect(screen.getByTestId("delete-photo-now").textContent).toBe("Delete my photo now"); // carousel
      fireEvent.click(screen.getByTestId("send-hearts"));
      await screen.findByTestId("undertone-screen");
      expect(screen.getByTestId("delete-photo-now")).toBeTruthy(); // hearts sent / undertone
      fireEvent.click(screen.getByTestId("finish"));
      const done = await screen.findByTestId("done-screen");
      expect(done.textContent).toContain("Done. Your photos are deleted.");
      expect(screen.queryByTestId("delete-photo-now")).toBeNull();
    });

    /** Every <img src> on the page that is a try-on (recipient-derived) image. */
    const tryOnSrcs = () => [...document.querySelectorAll("img")].map((i) => i.getAttribute("src") ?? "").filter((src) => src.startsWith("/t/"));

    it("deletes every face-derived image: product photos in the carousel, hearts intact, extra metals off", async () => {
      const a = api("trying_on", capture);
      render(<RecipientFlow token={TOKEN} api={asApi(a)} />);
      await screen.findByTestId("tryon-screen");
      const halo = (await screen.findAllByTestId("carousel-item"))[0];
      // Render an extra metal first, so there are two try-on images of this design.
      fireEvent.click(within(halo).getByRole("radio", { name: "Rose gold" }));
      await within(halo).findByAltText(/in rose gold/);
      fireEvent.click(screen.getByRole("button", { name: "Heart Halo Drop Earrings, rose gold" }));
      expect(tryOnSrcs().length).toBeGreaterThan(0);

      fireEvent.click(screen.getByTestId("delete-photo-now"));
      await waitFor(() => expect(a.deletePhoto).toHaveBeenCalledWith(TOKEN));
      expect((await screen.findByTestId("photo-deleted-note")).textContent).toBe("Your photos are deleted. Your picks are saved.");
      expect(screen.queryByTestId("delete-photo-now")).toBeNull();

      // No try-on image anywhere in the DOM; product photos instead.
      expect(tryOnSrcs()).toEqual([]);
      expect(screen.queryAllByText("AI preview")).toHaveLength(0);
      expect(within(halo).getByAltText("Halo Drop Earrings").getAttribute("src")).toBe("/a.jpg");
      expect(within(halo).getByTestId("product-photo-note")).toBeTruthy();

      // Extra metals are off (even the one rendered before), no render call is made.
      for (const name of ["Yellow gold", "White gold"]) expect((within(halo).getByRole("radio", { name }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(within(halo).getByRole("radio", { name: "White gold" }));
      expect(a.trySwatch).toHaveBeenCalledTimes(1);
      expect(within(halo).getByTestId("renders-off-note")).toBeTruthy();

      // Hearts are intact and still sent per variant.
      expect(screen.getByRole("button", { name: "Heart Halo Drop Earrings, rose gold" }).getAttribute("aria-pressed")).toBe("true");
      fireEvent.click(screen.getByTestId("send-hearts"));
      await waitFor(() => expect(a.saveHearts).toHaveBeenCalledWith(TOKEN, [{ itemId: "i1", swatchId: "s1r" }]));
    });

    it("after a reload, a deleted capture shows product photos and the note (GET capture has no images)", async () => {
      const deleted: CaptureResponse = { ...capture, tryons: capture.tryons.map((t) => ({ itemId: t.itemId, swatchId: t.swatchId, status: "failed" as const, failureReason: "photo_deleted" })) };
      const a = api("trying_on", deleted);
      render(<RecipientFlow token={TOKEN} api={asApi(a)} />);
      await screen.findByTestId("tryon-screen");
      await screen.findAllByTestId("carousel-item");
      expect(tryOnSrcs()).toEqual([]);
      expect(screen.getByTestId("photo-deleted-note").textContent).toBe("Your photos are deleted. Your picks are saved.");
      expect(screen.queryByTestId("delete-photo-now")).toBeNull();
      expect(screen.queryByText(/We couldn't see your ears/)).toBeNull();
    });

    it("before upload, discards the photo on the device without calling the server", async () => {
      const a = api("awaiting_capture");
      render(<RecipientFlow token={TOKEN} api={asApi(a)} />);
      fireEvent.click(await screen.findByText("fake selfie"));
      await screen.findByText("Add your hand?");
      fireEvent.click(screen.getByTestId("delete-photo-now"));
      expect(await screen.findByText("Take a selfie")).toBeTruthy();
      expect(screen.getByTestId("photo-deleted-note").textContent).toBe("Photo deleted from this device. Nothing was uploaded.");
      expect(a.deletePhoto).not.toHaveBeenCalled();
      expect(a.capture).not.toHaveBeenCalled();
    });

    it("treats a swatch answer of photo_deleted as renders off", async () => {
      const a = api("trying_on", capture);
      a.trySwatch.mockResolvedValueOnce({ status: "failed", failureReason: "photo_deleted", rendersLeft: 0 });
      render(<RecipientFlow token={TOKEN} api={asApi(a)} />);
      const halo = (await screen.findAllByTestId("carousel-item"))[0];
      fireEvent.click(within(halo).getByRole("radio", { name: "White gold" }));
      expect(await within(halo).findByTestId("renders-off-note")).toBeTruthy();
      expect(within(halo).getByRole("radio", { name: "Yellow gold" }).getAttribute("aria-checked")).toBe("true");
      expect(tryOnSrcs()).toEqual([]);
    });
  });

  it("labels a seeded judge demo: persistent 'AI-generated model · demo' badge and one on every try-on card", async () => {
    const a = api("trying_on", { ...capture, demo: true });
    a.openSession.mockResolvedValue({ ...session("trying_on"), demo: true });
    render(<RecipientFlow token={TOKEN} api={asApi(a)} />);
    await screen.findByTestId("tryon-screen");
    await screen.findAllByTestId("carousel-item");
    const badges = screen.getAllByTestId("ai-model-badge");
    const readyCards = capture.tryons.filter((t) => t.status === "ready").length;
    expect(badges.length).toBe(readyCards + 1);
    for (const b of badges) expect(b.textContent).toBe("AI-generated model · demo");
    expect(screen.getAllByText("AI preview")).toHaveLength(readyCards);
    // Still there on the next step.
    fireEvent.click(screen.getByTestId("send-hearts"));
    await screen.findByTestId("undertone-screen");
    expect(screen.getAllByTestId("ai-model-badge")).toHaveLength(1);
  });

  it("shows no AI-model badge on a real request", async () => {
    render(<RecipientFlow token={TOKEN} api={asApi(api("trying_on", capture))} />);
    await screen.findAllByTestId("carousel-item");
    expect(screen.queryAllByTestId("ai-model-badge")).toHaveLength(0);
  });
});

describe("RecipientFlow for a store-URL preview (A6, ADR-055)", () => {
  it("hearts only: no selfie step, the no-try-on note, and Send finishes without the undertone check", async () => {
    const a = api();
    a.openSession.mockResolvedValue({ ...session("awaiting_consent"), tryOn: false });
    a.consent.mockResolvedValue({ ...session("consented" as RecipientSessionResponse["status"]), status: "awaiting_capture", tryOn: false });
    render(<RecipientFlow token={TOKEN} api={asApi(a)} />);
    expect(await screen.findByTestId("no-tryon-consent")).toBeTruthy();
    fireEvent.click(screen.getByTestId("consent-accept"));
    await screen.findByTestId("tryon-screen");
    expect(screen.queryByText("fake selfie")).toBeNull();
    expect(screen.getByTestId("no-tryon-note").textContent).toContain("Try-on isn't enabled for previews");
    fireEvent.click(screen.getAllByRole("button", { name: /^Heart Halo Drop Earrings/ })[0]);
    fireEvent.click(screen.getByTestId("send-hearts"));
    await waitFor(() => expect(a.finish).toHaveBeenCalledTimes(1));
    expect(a.saveHearts).toHaveBeenCalledTimes(1);
    expect(a.capture).not.toHaveBeenCalled();
    expect(a.trySwatch).not.toHaveBeenCalled();
    expect(screen.queryByTestId("undertone-screen")).toBeNull();
  });

  it("no try-on copy anywhere for a preview: intro, card notes, done screen; the header names the store", async () => {
    const a = api();
    a.openSession.mockResolvedValue({ ...session("awaiting_consent"), tryOn: false, storeName: "gorjana" });
    a.consent.mockResolvedValue({ ...session("consented" as RecipientSessionResponse["status"]), status: "awaiting_capture", tryOn: false, storeName: "gorjana" });
    render(
      <>
        <GiftHeader />
        <RecipientFlow token={TOKEN} api={asApi(a)} />
      </>,
    );
    const consent = await screen.findByTestId("consent-screen");
    expect(consent.textContent).toMatch(/A private gift/);
    expect(consent.textContent).toMatch(/Look through \d+ pieces/);
    expect(consent.textContent).not.toMatch(/Try on \d+ pieces|try-on ·|They will never see your photos/);
    expect(screen.queryByTestId("photo-retention")).toBeNull();
    expect((await screen.findByTestId("gift-header-store")).textContent).toBe("for gorjana");
    fireEvent.click(screen.getByTestId("consent-accept"));
    await screen.findByTestId("tryon-screen");
    for (const note of screen.queryAllByTestId("product-photo-note")) expect(note.textContent).not.toMatch(/try-on/i);
    fireEvent.click(screen.getAllByRole("button", { name: /^Heart Halo Drop Earrings/ })[0]);
    fireEvent.click(screen.getByTestId("send-hearts"));
    const done = await screen.findByTestId("done-screen");
    expect(done.textContent).toMatch(/Your hearts are sent/);
    expect(done.textContent).not.toMatch(/photos are deleted|fit scores, never your photos/);
  });

  it("an Aurum link's header names the Aurum store", async () => {
    const a = api();
    a.openSession.mockResolvedValue(session("awaiting_consent"));
    render(
      <>
        <GiftHeader />
        <RecipientFlow token={TOKEN} api={asApi(a)} />
      </>,
    );
    expect((await screen.findByTestId("gift-header-store")).textContent).toBe("for Aurum Jewelry");
  });
});

describe("RecipientFlow when the store preview is gone (A6, ADR-055)", () => {
  it("shows the expired-preview screen instead of an empty carousel", async () => {
    const a = api();
    a.openSession.mockResolvedValue({ ...session("awaiting_consent"), items: [], tryOn: false, previewExpired: true });
    render(<RecipientFlow token={TOKEN} api={asApi(a)} />);
    const screenEl = await screen.findByTestId("preview-expired-screen");
    expect(screenEl.textContent).toContain("This preview has expired");
    expect(screen.queryByTestId("consent-accept")).toBeNull();
  });
});

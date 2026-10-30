// @vitest-environment jsdom
/**
 * A21: the recipient page renders in the locale the server picked (ja, de here): consent, privacy
 * details, carousel, undertone check and done screen, with no English sentence left in the main flow.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CaptureResponse, RecipientSessionResponse, SwatchResponse } from "@/server/contracts/api";
import type { Locale } from "@/server/i18n";
import { RECIPIENT_CATALOGS } from "@/server/i18n/recipient";
import { en } from "@/server/i18n/recipient/en";
import type { GiftApi } from "../api";

vi.mock("../recipient/CaptureStep", () => ({
  CaptureStep: ({ mode, onConfirm, onSkip }: { mode: string; onConfirm: (b: Blob) => void; onSkip?: () => void }) => (
    <div>
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
const sw = (id: string, metalLabel: string, isDefault = false) => ({ swatchId: id, metalLabel, swatchColor: "#ccc", isDefault });
const items: RecipientSessionResponse["items"] = [
  { itemId: "i1", title: "Halo Drop Earrings", category: "earring", productImage: "/a.jpg", needsHandPhoto: false, swatches: [sw("s1y", "Yellow gold", true), sw("s1w", "White gold")] },
  { itemId: "i2", title: "Crescent Pendant", category: "necklace", productImage: "/b.jpg", needsHandPhoto: false, swatches: [sw("s2r", "Rose gold", true)] },
  { itemId: "i3", title: "Summit Band", category: "ring", productImage: "/c.jpg", needsHandPhoto: true, swatches: [sw("s3w", "White gold", true)] },
];
const session = (status: RecipientSessionResponse["status"]): RecipientSessionResponse => ({ status, occasion: "birthday", expiresAt: "2026-10-18T12:00:00.000Z", items });
const capture: CaptureResponse = {
  tryons: [
    { itemId: "i1", swatchId: "s1y", status: "failed", failureReason: "2" },
    { itemId: "i2", swatchId: "s2r", status: "ready", imageUrl: "/t/2" },
    { itemId: "i3", swatchId: "s3w", status: "skipped_needs_hand" },
  ],
  undertone: { estimate: "warm", confidence: 0.4, override: null, label: "Warm undertone estimate" },
  faceShapeLabel: "Oval face shape (estimate)",
  processingSeconds: 21,
};
const api = () =>
  ({
    resumeCapture: vi.fn(async () => null),
    openSession: vi.fn(async () => session("awaiting_consent")),
    consent: vi.fn(async () => session("awaiting_capture")),
    capture: vi.fn(async () => capture),
    saveHearts: vi.fn(async () => undefined),
    trySwatch: vi.fn(async (): Promise<SwatchResponse> => ({ status: "ready", imageUrl: "/t/x", rendersLeft: 3 })),
    wishMetal: vi.fn(async () => undefined),
    deletePhoto: vi.fn(async () => ({ photoDeleted: true as const, rendersLeft: 0 as const })),
    finish: vi.fn(async () => ({ photosDeleted: true as const, photosStored: 0 as const, completedAt: "now" })),
    setUndertone: vi.fn(async () => undefined),
  }) as unknown as GiftApi;

/** English sentences that must not survive in a localized page (the catalog's own English, plus fixed copy). */
const ENGLISH = [
  en["intro.title"],
  en["intro.neverSee"],
  en["intro.retention"],
  en["consent.accept"],
  en["consent.agree"],
  en["privacy.summary"],
  en["privacy.keepPhoto"],
  en["deleteAll.idle"],
  en["photo.delete"],
  en["tryon.title"],
  en["tryon.note"],
  en["card.wish"],
  en["card.failEars"],
  en["card.needsHand"],
  en["disclaimer.tryOn"],
  en["undertone.title"],
  en["undertone.lowConfidence"],
  en["done.safe"],
  en["done.forgetBody"],
  "Heart the ones you love",
  "AI preview",
  "Earring",
  "Necklace",
  "Rose gold",
  "Birthday",
  "Oval face shape",
  "Private",
];
const SLOW = { timeout: 10_000 };
const PRODUCT_TITLES = ["Halo Drop Earrings", "Crescent Pendant", "Summit Band"];

function englishLeftovers(): string[] {
  // Product titles are the store's own words; GiftFit and YouCam are names.
  let text = document.body.textContent ?? "";
  for (const t of PRODUCT_TITLES) text = text.split(t).join("");
  return ENGLISH.filter((s) => text.includes(s));
}

async function runFlow(locale: Locale, faceShape: string) {
  const c = RECIPIENT_CATALOGS[locale];
  render(
    <>
      <GiftHeader />
      <RecipientFlow token={TOKEN} api={api()} locale={locale} />
    </>,
  );
  expect(await screen.findByText(c["intro.title"])).toBeTruthy();
  expect(screen.getByTestId("photo-retention").textContent).toBe(c["intro.retention"]);
  expect(document.body.textContent).toContain(c["privacy.keepPhoto"]);
  expect(document.body.textContent).toContain(c["deleteAll.idle"]);
  expect(englishLeftovers(), `${locale} consent`).toEqual([]);
  expect(document.documentElement.lang).toBe(locale);
  await waitFor(() => expect(document.body.textContent).toContain(c["header.private"]));

  fireEvent.click(screen.getByTestId("consent-accept"));
  // Later steps load on demand (next/dynamic): allow for a cold import.
  fireEvent.click(await screen.findByText("fake selfie", {}, SLOW));
  expect(await screen.findByText(c["hand.title"])).toBeTruthy();
  fireEvent.click(screen.getByText("skip"));

  await screen.findByTestId("tryon-screen");
  expect(await screen.findAllByTestId("carousel-item", {}, SLOW)).toHaveLength(3);
  expect(screen.getByText(c["tryon.title"])).toBeTruthy();
  expect(document.body.textContent).toContain(c["card.failEars"]);
  expect(document.body.textContent).toContain(c["card.needsHand"]);
  expect(document.body.textContent).toContain(c["photo.kept"]);
  expect(englishLeftovers(), `${locale} carousel`).toEqual([]);
  fireEvent.click(screen.getAllByTestId("heart")[1]);
  fireEvent.click(screen.getByTestId("send-hearts"));

  expect(await screen.findByText(c["undertone.title"], {}, SLOW)).toBeTruthy();
  expect(await screen.findByText(c["undertone.lowConfidence"], { exact: false })).toBeTruthy();
  expect(document.body.textContent).toContain(faceShape);
  expect(englishLeftovers(), `${locale} undertone`).toEqual([]);
  fireEvent.click(screen.getByTestId("finish"));

  const done = await screen.findByTestId("done-screen", {}, SLOW);
  expect(done.textContent).toContain(c["done.title"]);
  expect(done.textContent).toContain(c["done.forgetBody"]);
  expect(englishLeftovers(), `${locale} done`).toEqual([]);
}

describe("RecipientFlow in the recipient's language (A21)", { timeout: 60_000 }, () => {
  it("renders the whole flow in Japanese", async () => {
    await runFlow("ja", "卵型の顔（推定）");
  });

  it("renders the whole flow in German", async () => {
    await runFlow("de", "Gesichtsform: oval (Schätzung)");
  });

  it("closed states and errors follow the locale too", async () => {
    const a = api();
    (a.openSession as ReturnType<typeof vi.fn>).mockResolvedValue(session("expired"));
    render(<RecipientFlow token={TOKEN} api={a} locale="th" />);
    expect((await screen.findByTestId("expired-screen")).textContent).toContain(RECIPIENT_CATALOGS.th["expired.title"]);
    cleanup();
    const { ApiError } = await import("../api");
    const b = api();
    (b.openSession as ReturnType<typeof vi.fn>).mockRejectedValue(new ApiError(429, "rate_limited"));
    render(<RecipientFlow token={TOKEN} api={b} locale="ko" />);
    expect(await screen.findByText(RECIPIENT_CATALOGS.ko["error.rateLimited"])).toBeTruthy();
    expect(screen.getByText(RECIPIENT_CATALOGS.ko["error.title"])).toBeTruthy();
  });

  it("corrects a server choice from navigator.languages (browser in the ten wins over the giver's)", async () => {
    const spy = vi.spyOn(navigator, "languages", "get").mockReturnValue(["es-ES", "en"]);
    render(<RecipientFlow token={TOKEN} api={api()} locale="vi" giverLang="vi" />);
    expect(await screen.findByText(RECIPIENT_CATALOGS.es["intro.title"])).toBeTruthy();
    spy.mockRestore();
  });
});

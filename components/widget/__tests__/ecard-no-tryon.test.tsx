// @vitest-environment jsdom
/** The widget e-card for a gift without a try-on (store-URL previews, ADR-055): no camera / try-on copy. */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { CreateFitRequestResponse } from "@/lib/contracts/api";
import { translator } from "@/lib/i18n";
import { GiftCardStep } from "../GiftCardStep";

afterEach(cleanup);

const result = (over: Partial<CreateFitRequestResponse> = {}): CreateFitRequestResponse => ({
  fitRequestId: "fr1",
  giverToken: "g".repeat(43),
  recipientPath: `/r/${"r".repeat(43)}`,
  giverReportPath: `/g/${"g".repeat(43)}`,
  expiresAt: new Date(Date.now() + 72 * 3600e3).toISOString(),
  carouselSize: 6,
  ...over,
});

const renderCard = (r: CreateFitRequestResponse) =>
  render(<GiftCardStep locale="en" tr={translator("en")} result={r} occasion="birthday" baseUrl="https://giftfit.example" onNewGift={() => undefined} />);

describe("GiftCardStep e-card copy", () => {
  it("a preview gift (tryOn:false) never mentions a camera or trying pieces on", () => {
    renderCard(result({ tryOn: false }));
    const card = screen.getByTestId("widget-ecard").textContent ?? "";
    expect(card).not.toMatch(/camera|try a few pieces on|try-on/i);
    expect(card).toMatch(/No photo is needed/);
  });

  it("an Aurum gift keeps the try-on copy", () => {
    renderCard(result());
    expect(screen.getByTestId("widget-ecard").textContent).toMatch(/phone camera/);
  });
});

// @vitest-environment jsdom
/**
 * The e-card's language (ADR-057): it starts in the widget's language (one of the ten), the giver may pick
 * another, and the gift card e-mail goes out in the card language while the giver's own "report ready"
 * note stays in the widget's language. Nothing is sent: fetch is a stub.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateFitRequestResponse } from "@/lib/contracts/api";
import { HEADLINES } from "@/lib/email/copy";
import { LOCALES, translator, type Locale } from "@/lib/i18n";
import { GiftCardStep } from "../GiftCardStep";

afterEach(cleanup);

const result: CreateFitRequestResponse = {
  fitRequestId: "fr1",
  giverToken: "g".repeat(43),
  recipientPath: `/r/${"r".repeat(43)}`,
  giverReportPath: `/g/${"g".repeat(43)}`,
  expiresAt: new Date(Date.now() + 72 * 3600e3).toISOString(),
  carouselSize: 6,
};

function renderCard(locale: Locale) {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ sent: true, saved: true, delivery: "logged" }), { status: 200 }));
  render(<GiftCardStep locale={locale} tr={translator(locale)} result={result} occasion="birthday" baseUrl="https://giftfit.example" onNewGift={() => undefined} fetchImpl={fetchImpl as unknown as typeof fetch} />);
  const bodyOf = (path: string) => {
    const call = fetchImpl.mock.calls.find((c) => (c as unknown[])[0] === path) as unknown as [string, RequestInit] | undefined;
    return call ? (JSON.parse(String(call[1].body)) as Record<string, unknown>) : undefined;
  };
  return { fetchImpl, bodyOf };
}

async function sendCardAndNotify() {
  fireEvent.change(screen.getByTestId("widget-email-to"), { target: { value: "mai@example.com" } });
  fireEvent.submit(screen.getByTestId("widget-email-to").closest("form")!);
  fireEvent.change(screen.getByTestId("widget-notify-email"), { target: { value: "nam@example.com" } });
  fireEvent.submit(screen.getByTestId("widget-notify-email").closest("form")!);
}

describe("e-card language", () => {
  it.each(LOCALES)("%s: the card starts in the widget's language and both e-mails are requested in it", async (locale) => {
    const { fetchImpl, bodyOf } = renderCard(locale);
    expect((screen.getByTestId("widget-card-lang") as HTMLSelectElement).value).toBe(locale);
    expect(screen.getByTestId("widget-ecard").getAttribute("lang")).toBe(locale);
    expect(screen.getByTestId("widget-ecard").textContent).toContain(HEADLINES.birthday[locale]);
    await sendCardAndNotify();
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    expect(bodyOf("/api/widget/send-card")).toMatchObject({ lang: locale });
    expect(bodyOf("/api/widget/notify")).toMatchObject({ lang: locale });
  });

  it("a card language the giver picks applies to the card e-mail only; their own note keeps the widget's language", async () => {
    const { fetchImpl, bodyOf } = renderCard("ja");
    fireEvent.change(screen.getByTestId("widget-card-lang"), { target: { value: "de" } });
    expect(screen.getByTestId("widget-ecard").textContent).toContain(HEADLINES.birthday.de);
    await sendCardAndNotify();
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    expect(bodyOf("/api/widget/send-card")).toMatchObject({ lang: "de" });
    expect(bodyOf("/api/widget/notify")).toMatchObject({ lang: "ja" });
  });
});

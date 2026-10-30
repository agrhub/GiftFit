// @vitest-environment jsdom
/**
 * A22: the giver's Fit Report renders in the report's language (GiverReportStatus.lang). Japanese and
 * German reports show no English outside product names and brand words; prices use the locale's Intl
 * format; the estimate labels (a fixed English vocabulary on the wire) are translated on the page.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GiverReportStatus } from "@/server/contracts/api";
import { formatMoney } from "@/server/i18n";
import { scoreSkus, toFitResult } from "@/server/fit/score";
import { templateTasteSummary, buildTasteInput } from "@/server/fit/taste";
import { fakeRules, profile, request, sku } from "@/server/fit/__tests__/fixtures";
import { type GiftApi, normalizeReport } from "../api";
import { GiverReport, localizeEstimateLabel } from "../report/GiverReport";

afterEach(cleanup);
const TOKEN = "t".repeat(43);

const SKUS = [
  sku("tried", { category: "earring", price: 245, attributes: { metal: "yellow_gold", earring_shape: "drop_teardrop" } }),
  sku("untried", { category: "earring", price: 180, attributes: { metal: "rose_gold", earring_shape: "drop_teardrop", tryon_eligible: false } }),
  sku("plain", { category: "earring", price: 340, attributes: { metal: "white_gold", earring_shape: "stud_statement", occasions: [] } }),
];
const products = {
  tried: { id: "tried", slug: "halo-drop-earrings", title: "Halo Drop Earrings", price: 245, currency: "USD", metal: "yellow_gold" as const },
  untried: { id: "untried", slug: "luna-drops", title: "Luna Drops", price: 180, currency: "USD", metal: "rose_gold" as const },
  plain: { id: "plain", slug: "nova-studs", title: "Nova Studs", price: 340, currency: "USD", metal: "white_gold" as const },
  similar: { id: "similar", slug: "iris-pendant", title: "Iris Pendant", price: 210, currency: "USD", metal: "rose_gold" as const },
};
const TITLES = Object.values(products).map((p) => p.title);

/** A completed mixed report as the server would write it in `lang` (real templates, real scorer). */
function reportIn(lang: "ja" | "de" | "en"): GiverReportStatus {
  const p = profile({ undertoneEstimate: "warm", undertoneConfidence: 0.4, faceShape: "Oval", heartedSkuIds: ["tried", "untried"], wishOtherMetalSkuIds: ["plain"] });
  const scored = scoreSkus(p, SKUS, request({ shortlistIds: SKUS.map((s) => s.id), budgetMin: 150, budgetMax: 300 }), fakeRules, { noTryOnIds: new Set(["untried"]), locale: lang });
  return {
    status: "completed",
    expiresAt: "2026-10-18T12:00:00.000Z",
    results: scored.map(toFitResult),
    heartedShortlistIds: ["tried", "untried"],
    otherMetalWishes: ["plain"],
    recipientLabels: { undertone: "Warm undertone estimate (low confidence)", faceShape: "Oval face shape estimate" },
    mode: "help_me_choose",
    demo: true,
    tasteSummary: { text: templateTasteSummary(buildTasteInput([{ sku: SKUS[0], metal: "yellow_gold" }], 3, 1), { locale: lang }), source: "template" },
    similarNotTried: [{ catalogId: "similar", price: 210, currency: "USD", label: "not tried on" }],
    lang,
  };
}

const itemFor = (items: HTMLElement[], title: string) => items.find((i) => i.textContent?.includes(title))!;
const apiWith = (r: GiverReportStatus) => ({ giverReport: vi.fn(async () => normalizeReport(r)) }) as unknown as GiftApi;

/** The report's visible text minus product names, brand words and allowed tokens. */
function mainText(container: HTMLElement): string {
  let text = container.querySelector('[data-testid="fit-report"]')!.textContent ?? "";
  for (const t of TITLES) text = text.split(t).join(" ");
  return text.replace(/GiftFit|Fit Report|Fit Score|Claude|US\$|\bAI\b|\bKI\b|\bUTC\b/g, " ");
}

describe("GiverReport in the giver's language", () => {
  it("ja: no English left in the main content; Japanese labels, chips, factors and buttons", async () => {
    const { container } = render(<GiverReport token={TOKEN} api={apiWith(reportIn("ja"))} products={products} />);
    const items = await screen.findAllByTestId("fit-report-item");
    expect(items).toHaveLength(3);
    expect(mainText(container).match(/[A-Za-z]{2,}/g) ?? []).toEqual([]);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("ぴったりのアイテムはこちら。");
    expect(screen.getByText("ウォームのアンダートーン（推定）（信頼度低）")).toBeTruthy();
    expect(screen.getByText("卵型の顔型（推定）")).toBeTruthy();
    expect(screen.getByTestId("not-tried-on-badge").textContent).toBe("未試着");
    expect(screen.getByTestId("mixed-tryon-note").textContent).toMatch(/試着/);
    expect(within(itemFor(items, "Halo Drop Earrings")).getByTestId("report-price").textContent).toBe(formatMoney("ja", 245, "USD"));
    expect(within(itemFor(items, "Halo Drop Earrings")).getByTestId("buy-button").textContent).toBe(`ギフトとして購入 · イエローゴールド · ${formatMoney("ja", 245, "USD")}`);
    expect(container.querySelector('[data-testid="fit-report"]')!.getAttribute("lang")).toBe("ja");
    await waitFor(() => expect(document.documentElement.lang).toBe("ja"));
  });

  it("de: no English left in the main content; German prices (300 $ style)", async () => {
    const { container } = render(<GiverReport token={TOKEN} api={apiWith(reportIn("de"))} products={products} />);
    const items = await screen.findAllByTestId("fit-report-item");
    const english = /\b(they|their|your|you|the|and|hearted|piece|pieces|within|suits|tried|loved|worth|buy|view|similar|estimate|undertone|score|expires|photos?)\b/gi;
    expect(mainText(container).match(english) ?? []).toEqual([]);
    expect(within(itemFor(items, "Halo Drop Earrings")).getByTestId("report-price").textContent).toBe(formatMoney("de", 245, "USD"));
    expect(formatMoney("de", 245, "USD")).toMatch(/^245\s\$$/);
    expect(screen.getByText("Unterton warm (Schätzung) (geringe Sicherheit)")).toBeTruthy();
    expect(screen.getByTestId("disclaimer").textContent).toMatch(/Größengarantie/);
    expect(screen.getByTestId("not-tried").textContent).toMatch(/nicht anprobiert/i);
    expect(screen.getByTestId("demo-request").textContent).toBe("Demo-Anfrage");
  });

  it("en (or no lang): unchanged English page", async () => {
    const r = reportIn("en");
    delete r.lang;
    render(<GiverReport token={TOKEN} api={apiWith(r)} products={products} />);
    const items = await screen.findAllByTestId("fit-report-item");
    expect(within(itemFor(items, "Halo Drop Earrings")).getByTestId("report-price").textContent).toBe("$245");
    expect(screen.getByText("Warm undertone estimate (low confidence)")).toBeTruthy();
    expect(within(itemFor(items, "Halo Drop Earrings")).getByTestId("buy-button").textContent).toBe("Buy as a gift · Yellow gold · $245");
  });

  it("the server-known locale is used before the report arrives", () => {
    render(<GiverReport token={TOKEN} api={{ giverReport: () => new Promise(() => {}) } as unknown as GiftApi} products={products} locale="th" />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Fit Report ของคุณ");
    expect(screen.getByLabelText("กำลังโหลดรายงานของคุณ")).toBeTruthy();
  });

  it("estimate labels: every vocabulary label translates; unknown text passes through", () => {
    expect(localizeEstimateLabel("vi", "Cool undertone (their choice)")).toBe("Tông da lạnh (do họ chọn)");
    expect(localizeEstimateLabel("fr", "Heart-shaped face shape estimate")).toBe("Visage en cœur (estimation)");
    expect(localizeEstimateLabel("ko", "something else")).toBe("something else");
    expect(localizeEstimateLabel("en", "Warm undertone estimate")).toBe("Warm undertone estimate");
  });
});

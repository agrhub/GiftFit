// @vitest-environment jsdom
/**
 * The widget follows the shopper's language (ADR-057): every clear message moves the UI to its language
 * (one of the ten, else English), unclear ones ("ok", "$150") leave it, and the Concierge gets the
 * page/conversation language as a hint.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCALES, parseLangList, t } from "@/lib/i18n";
import { WidgetApp } from "../WidgetApp";

const REPLY = "…";
let fetchMock: ReturnType<typeof vi.fn>;
const bodies = () => fetchMock.mock.calls.filter((c) => String(c[0]) === "/api/concierge").map((c) => JSON.parse(String((c[1] as RequestInit).body)) as { lang?: string });

beforeEach(() => {
  fetchMock = vi.fn(async (url: string) => {
    if (url === "/api/concierge") {
      const lines = [{ type: "start", source: "mock" }, { type: "text", delta: REPLY }, { type: "final", suggestions: [], source: "mock", degraded: false }];
      return new Response(lines.map((l) => JSON.stringify(l)).join("\n") + "\n", { headers: { "Content-Type": "application/x-ndjson" } });
    }
    if (url === "/api/fit/report") return Response.json({ status: "pending" });
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

async function say(text: string, sendLabel: string) {
  const n = bodies().length;
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: sendLabel }));
  await waitFor(() => expect(bodies().length).toBe(n + 1));
  await waitFor(() => expect(screen.queryByRole("button", { name: t("en", "chat.stop") })).toBeNull());
}

const sendIn = (l: (typeof LOCALES)[number]) => t(l, "chat.send");

describe("widget language", () => {
  it("each clear message switches the UI; unclear ones keep it; other languages show English", async () => {
    render(<WidgetApp store="aurum" parentOrigin={null} allowedLangs={[...LOCALES]} baseUrl="https://giftfit.example" />);
    expect(screen.getByRole("button", { name: sendIn("en") })).toBeTruthy();

    await say("Busco un regalo para mi hermana", sendIn("en"));
    await screen.findByRole("button", { name: sendIn("es") });

    await say("$150", sendIn("es"));
    expect(screen.getByRole("button", { name: sendIn("es") })).toBeTruthy();
    // The Concierge hint is the conversation's language once one is known.
    expect(bodies().at(-1)?.lang).toBe("es");

    await say("Mình muốn tặng mẹ bông tai", sendIn("es"));
    await screen.findByRole("button", { name: sendIn("vi") });

    // Portuguese isn't a widget locale: the UI shows English, the hint keeps "pt" for the Concierge.
    await say("Quero um presente para a minha mãe", sendIn("vi"));
    await screen.findByRole("button", { name: sendIn("en") });
    await say("ok", sendIn("en"));
    expect(bodies().at(-1)?.lang).toBe("pt");
  });

  it.each(["ja", "de"] as const)("with no data-langs, a store page in %s opens in that language, then follows the shopper", async (lang) => {
    const PARENT = "https://shop.example";
    // What /w gets from a tag without data-langs: no langs parameter, so all ten (jsdom's browser says en-US).
    render(<WidgetApp store="aurum" parentOrigin={PARENT} allowedLangs={parseLangList(undefined)} baseUrl="https://giftfit.example" />);
    const host = (data: object) => act(() => window.dispatchEvent(new MessageEvent("message", { data: { source: "giftfit-widget", v: 1, ...data }, origin: PARENT, source: window })));
    host({ type: "context", product: null, page: { lang: lang === "ja" ? "ja" : "de-DE", url: `${PARENT}/` } });
    host({ type: "open" });
    await screen.findByRole("button", { name: sendIn(lang) });
    await say("Busco un regalo para mi hermana", sendIn(lang));
    await screen.findByRole("button", { name: sendIn("es") });
  });

  it("stays within the store's languages", async () => {
    render(<WidgetApp store="aurum" parentOrigin={null} allowedLangs={["vi"]} baseUrl="https://giftfit.example" />);
    await say("Quero um presente para a minha mãe", sendIn("vi"));
    expect(screen.getByRole("button", { name: sendIn("vi") })).toBeTruthy();
  });
});

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GiftBrief } from "@/lib/contracts/api";
import { parseNdjson } from "@/lib/concierge/client";
import type { ConciergeEvent } from "@/lib/concierge/types";
import { ConciergePanel } from "../ConciergePanel";

afterEach(cleanup);

const brief: GiftBrief = { mode: "help_me_choose", occasion: "anniversary", budgetMax: 300, currency: "USD", styleHints: ["minimal"] };
const EVENTS: ConciergeEvent[] = [
  { type: "start", source: "mock" },
  { type: "text", delta: "Here are three " },
  { type: "text", delta: "delicate ideas." },
  { type: "tool", name: "search_catalog", summary: "Searched the catalog (≤ $300): 9 matches" },
  { type: "tool", name: "create_fit_request", summary: "Drafted a brief (not sent)" },
  {
    type: "final",
    brief,
    source: "mock",
    degraded: false,
    suggestions: [{ catalogId: "c1", title: "Whisper Fine Cable Chain", category: "necklace", style: "minimal", reason: "Delicate and timeless.", eligibleMetals: [{ metal: "yellow_gold", price: 95 }], fromPrice: 95, currency: "USD", image: "/catalog/aurum/aur-nec-028.png" }],
  },
];

/** NDJSON body split at awkward byte boundaries. */
function ndjsonBody(events: ConciergeEvent[], chunk = 7): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i >= bytes.length) return c.close();
      c.enqueue(bytes.slice(i, i + chunk));
      i += chunk;
    },
  });
}

const okFetch = (events = EVENTS) => vi.fn(async () => new Response(ndjsonBody(events), { status: 200, headers: { "Content-Type": "application/x-ndjson" } }));

describe("parseNdjson", () => {
  it("reassembles events across chunk boundaries and skips junk lines", async () => {
    const bytes = new TextEncoder().encode(`${JSON.stringify(EVENTS[0])}\nnot json\n{"no":"type"}\n${JSON.stringify(EVENTS[1])}`);
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, 5));
        c.enqueue(bytes.slice(5));
        c.close();
      },
    });
    const out: ConciergeEvent[] = [];
    for await (const e of parseNdjson(body)) out.push(e);
    expect(out).toEqual([EVENTS[0], EVENTS[1]]);
  });
});

describe("ConciergePanel", () => {
  it("sends with Enter, streams the reply, shows the collapsed transcript, cards and the draft brief; Use this brief calls onBrief", async () => {
    const fetchImpl = okFetch();
    const onBrief = vi.fn();
    render(<ConciergePanel onBrief={onBrief} fetchImpl={fetchImpl as unknown as typeof fetch} examples={[]} />);
    const input = screen.getByLabelText("Your message");
    fireEvent.change(input, { target: { value: "Anniversary gift, $300" } });
    fireEvent.keyDown(input, { key: "Enter" });

    const log = screen.getByRole("log", { name: "Conversation" });
    await waitFor(() => expect(within(log).getByText(/Here are three delicate ideas\./)).toBeTruthy());
    expect(within(log).getByText("Anniversary gift, $300")).toBeTruthy();

    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toEqual({ messages: [{ role: "user", content: "Anniversary gift, $300" }] });

    const summary = within(log).getByText(/How I searched \(2 steps\)/);
    expect(summary.closest("details")?.open).toBe(false);
    expect(within(log).getByRole("list", { name: "Suggested pieces" })).toBeTruthy();
    expect(within(log).getByText("Whisper Fine Cable Chain")).toBeTruthy();
    expect(within(log).getByText(/from \$95/)).toBeTruthy();
    expect(within(log).getByText("Up to $300")).toBeTruthy();

    fireEvent.click(within(log).getByRole("button", { name: "Use this brief" }));
    expect(onBrief).toHaveBeenCalledWith(brief);
    expect(within(log).getByRole("status").textContent).toMatch(/nothing has been sent/);
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it("sends the history on the next message (text only)", async () => {
    const fetchImpl = okFetch();
    render(<ConciergePanel onBrief={() => undefined} fetchImpl={fetchImpl as unknown as typeof fetch} examples={[]} />);
    const input = screen.getByLabelText("Your message");
    fireEvent.change(input, { target: { value: "first" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText(/delicate ideas/);
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeTruthy());
    fireEvent.change(input, { target: { value: "second" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    const body = JSON.parse((fetchImpl.mock.calls[1] as unknown as [string, RequestInit])[1].body as string);
    expect(body.messages).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "Here are three delicate ideas." },
      { role: "user", content: "second" },
    ]);
  });

  it("example prompts send directly", async () => {
    const fetchImpl = okFetch();
    render(<ConciergePanel onBrief={() => undefined} fetchImpl={fetchImpl as unknown as typeof fetch} examples={["Birthday ring under $200"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Birthday ring under $200" }));
    await screen.findByText(/delicate ideas/);
  });

  it("shows the quick-mode notice for a degraded answer", async () => {
    const degraded: ConciergeEvent[] = [{ type: "start", source: "fallback" }, { type: "text", delta: "Ideas." }, { type: "final", brief, suggestions: [], source: "fallback", degraded: true, degradeReason: "spend_cap", notes: ["Budget assumed: $250"] }];
    render(<ConciergePanel onBrief={() => undefined} fetchImpl={okFetch(degraded) as unknown as typeof fetch} examples={["x gift"]} />);
    fireEvent.click(screen.getByRole("button", { name: "x gift" }));
    expect(await screen.findByText(/Quick mode/)).toBeTruthy();
    expect(screen.getByText("Budget assumed: $250")).toBeTruthy();
  });

  it("explains a 429 with an alert", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "rate_limited" }), { status: 429, headers: { "Retry-After": "600", "Content-Type": "application/json" } }));
    render(<ConciergePanel onBrief={() => undefined} fetchImpl={fetchImpl as unknown as typeof fetch} examples={["y gift"]} />);
    fireEvent.click(screen.getByRole("button", { name: "y gift" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/try again in about 10 min/);
  });

  it("Shift+Enter does not send; an empty message cannot be sent", () => {
    const fetchImpl = okFetch();
    render(<ConciergePanel onBrief={() => undefined} fetchImpl={fetchImpl as unknown as typeof fetch} examples={[]} />);
    const input = screen.getByLabelText("Your message");
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

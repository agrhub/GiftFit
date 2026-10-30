// @vitest-environment jsdom
/**
 * A25: "Create the gift link" must not hang on "Creating…" when a response is lost. The call times out into a
 * localized error with the button usable again, and every retry of one brief sends the same Idempotency-Key
 * (the server replays the gift already made); a new brief or a changed body gets a new key. Nothing is sent:
 * fetch is a stub that never answers unless told to.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, CREATE_TIMEOUT_MS, httpGiftApi, newIdempotencyKey } from "@/client/gift/api";
import type { CreateFitRequestResponse, GiftBrief } from "@/server/contracts/api";
import { parseIdempotencyKey } from "@/server/fit/idempotency";
import { LOCALES, translator, type Locale } from "@/server/i18n";
import { BriefConfirm } from "../BriefConfirm";
import { createErrorKey, useGiftCreate } from "../useGiftCreate";

const RESULT: CreateFitRequestResponse = {
  fitRequestId: "fr1",
  giverToken: "g".repeat(43),
  recipientPath: `/r/${"r".repeat(43)}`,
  giverReportPath: `/g/${"g".repeat(43)}`,
  expiresAt: new Date(Date.now() + 72 * 3600e3).toISOString(),
  carouselSize: 6,
};
const BRIEF: GiftBrief = { mode: "help_me_choose", occasion: "birthday", budgetMax: 150, currency: "USD", shortlistIds: ["aurum-001"] };

/** fetch that hangs until aborted (rejecting like the platform does), or answers when `answer` is set. */
let answer: (() => Response) | null;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  answer = null;
  fetchMock = vi.fn((_url: string, init: RequestInit) => {
    if (answer) return Promise.resolve(answer());
    return new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const keyOf = (i: number) => (fetchMock.mock.calls[i][1] as RequestInit & { headers: Record<string, string> }).headers["Idempotency-Key"];

function Harness({ locale, onCreated, briefKey = 0 }: { locale: Locale; onCreated: (r: CreateFitRequestResponse) => void; briefKey?: number }) {
  const tr = translator(locale);
  const gift = useGiftCreate({ tr, onCreated, timeoutMs: 40 });
  return (
    <>
      <button type="button" data-testid="new-brief" onClick={gift.reset}>
        new brief {briefKey}
      </button>
      <BriefConfirm locale={locale} tr={tr} brief={BRIEF} match={null} tryOn suggestionTitles={["Halo"]} busy={gift.creating} error={gift.error} onCreate={(b) => void gift.create(b)} onBack={() => undefined} />
    </>
  );
}

describe("create: client timeout", () => {
  it.each(LOCALES)("%s: a lost response ends in the localized timeout error and Create works again", async (locale) => {
    const tr = translator(locale);
    const onCreated = vi.fn();
    render(<Harness locale={locale} onCreated={onCreated} />);
    const button = screen.getByTestId("widget-create") as HTMLButtonElement;
    fireEvent.click(button);
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe(tr("brief.creating"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(tr("brief.timeout")));
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe(tr("brief.create"));
    // The hung fetch was aborted, not left open.
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("the retry sends the same Idempotency-Key and lands on the gift", async () => {
    const onCreated = vi.fn();
    render(<Harness locale="vi" onCreated={onCreated} />);
    fireEvent.click(screen.getByTestId("widget-create"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(translator("vi")("brief.timeout")));
    answer = () => new Response(JSON.stringify(RESULT), { status: 201, headers: { "content-type": "application/json" } });
    fireEvent.click(screen.getByTestId("widget-create"));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(RESULT, expect.objectContaining({ mode: "help_me_choose" })));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(keyOf(0)).toBeTruthy();
    expect(parseIdempotencyKey(keyOf(0))).toBe(keyOf(0));
    expect(keyOf(1)).toBe(keyOf(0));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a new brief, or a changed body (another mode), gets a new key", async () => {
    render(<Harness locale="en" onCreated={vi.fn()} />);
    fireEvent.click(screen.getByTestId("widget-create"));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    fireEvent.click(screen.getByTestId("widget-mode-ideas"));
    fireEvent.click(screen.getByTestId("widget-create"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect((screen.getByTestId("widget-create") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("widget-create"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await waitFor(() => expect((screen.getByTestId("widget-create") as HTMLButtonElement).disabled).toBe(false));
    act(() => screen.getByTestId("new-brief").click());
    fireEvent.click(screen.getByTestId("widget-create"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(keyOf(1)).not.toBe(keyOf(0));
    expect(keyOf(2)).toBe(keyOf(1));
    expect(keyOf(3)).not.toBe(keyOf(2));
  });
});

describe("createFitRequest (http client)", () => {
  it("defaults to a 20 s timeout and sends the key as a header", async () => {
    expect(CREATE_TIMEOUT_MS).toBe(20_000);
    vi.useFakeTimers();
    try {
      const p = httpGiftApi.createFitRequest({ occasion: "birthday", budgetMax: 100, currency: "USD", shortlistIds: [] }, { idempotencyKey: "k".repeat(32) });
      const caught = p.catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(CREATE_TIMEOUT_MS - 1);
      expect((fetchMock.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const err = await caught;
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe("timeout");
      expect(keyOf(0)).toBe("k".repeat(32));
    } finally {
      vi.useRealTimers();
    }
  });

  it("still times out in a browser without AbortController (it just stops waiting)", async () => {
    vi.stubGlobal("AbortController", undefined);
    const err = await httpGiftApi.createFitRequest({ occasion: "birthday", budgetMax: 100, currency: "USD", shortlistIds: [] }, { timeoutMs: 20 }).catch((e: unknown) => e);
    expect((err as ApiError).code).toBe("timeout");
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBeUndefined();
    expect(fetchMock.mock.calls[0][1].headers["Idempotency-Key"]).toBeUndefined();
  });

  it("newIdempotencyKey: a UUID, else 32 hex chars, and the server accepts both", () => {
    const uuid = newIdempotencyKey();
    expect(uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(parseIdempotencyKey(uuid)).toBe(uuid);
    vi.stubGlobal("crypto", { getRandomValues: (b: Uint8Array) => b.fill(7) });
    expect(newIdempotencyKey()).toBe("07".repeat(16));
    vi.stubGlobal("crypto", undefined);
    const weak = newIdempotencyKey();
    expect(weak).toMatch(/^[0-9a-f]{32}$/);
    expect(parseIdempotencyKey(weak)).toBe(weak);
    expect(newIdempotencyKey()).not.toBe(weak);
  });

  it("createErrorKey: timeout, rate limit, anything else", () => {
    expect(createErrorKey(new ApiError(0, "timeout"))).toBe("brief.timeout");
    expect(createErrorKey(new ApiError(429, "rate_limited"))).toBe("brief.rateLimited");
    expect(createErrorKey(new ApiError(0, "network"))).toBe("brief.error");
    expect(createErrorKey(new Error("x"))).toBe("brief.error");
  });
});

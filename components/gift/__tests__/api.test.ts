import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, httpGiftApi, normalizeReport } from "../api";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("httpGiftApi", () => {
  it("resumeCapture: GET with the bearer token, null on 404 not_captured", async () => {
    const fetchMock = vi.fn(async () => json(404, { error: "not_captured" }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await httpGiftApi.resumeCapture("tok")).toBeNull();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/recipient/capture");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("resumeCapture: other errors still throw (e.g. 410 expired)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(410, { error: "expired", status: "expired" })));
    await expect(httpGiftApi.resumeCapture("tok")).rejects.toBeInstanceOf(ApiError);
  });

  it("marks an HTML 404 as a missing route", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 404, headers: { "content-type": "text/html" } })));
    await expect(httpGiftApi.openSession("tok")).rejects.toMatchObject({ status: 404, routeMissing: true });
  });

  it("normalizes a GiverReportStatus", () => {
    expect(normalizeReport({ status: "waiting", expiresAt: "x" })).toEqual({ state: "waiting", expiresAt: "x", results: [], labels: {}, heartedIds: [], otherMetalWishes: [], demo: false, mode: "i_have_ideas", similarNotTried: [] });
  });

  it("normalizes the Help me choose extras (ADR-045)", () => {
    const v = normalizeReport({
      status: "completed",
      expiresAt: "x",
      mode: "help_me_choose",
      demo: true,
      tasteSummary: { text: "They lean minimal.", source: "claude" },
      similarNotTried: [{ catalogId: "c1", variantId: "c1:yellow_gold", price: 120, currency: "USD", label: "not tried on" }],
    });
    expect(v).toMatchObject({ mode: "help_me_choose", demo: true, tasteSummary: { text: "They lean minimal.", source: "claude" } });
    expect(v.similarNotTried).toHaveLength(1);
  });
});

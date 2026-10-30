// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEMO_EXPLAINER, JudgeDemo } from "../JudgeDemo";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const seeded = { recipientPath: "/r/rtok", giverReportPath: "/g/gtok", expiresAt: "2026-10-19T10:00:00.000Z", subject: "showcase-latina-medium-warm", label: "AI-generated model" };

describe("Judge demo entry (ADR-038)", () => {
  it("explains the cost-free AI-model demo, seeds it and offers both views", async () => {
    const fetchMock = vi.fn(async () => json(201, seeded));
    vi.stubGlobal("fetch", fetchMock);
    render(<JudgeDemo compact />);
    expect(screen.getByText(DEMO_EXPLAINER)).toBeTruthy();
    expect(DEMO_EXPLAINER).toMatch(/pre-recorded try-ons of AI-generated models/);
    expect(DEMO_EXPLAINER).toMatch(/costs nothing/);
    fireEvent.click(screen.getByTestId("try-judge-demo"));
    const recipient = await screen.findByTestId("demo-recipient-link");
    expect(recipient.getAttribute("href")).toBe("/r/rtok");
    expect(recipient.textContent).toBe("Open the recipient view");
    const giver = screen.getByTestId("demo-giver-link");
    expect(giver.getAttribute("href")).toBe("/g/gtok?demo=1");
    expect(giver.textContent).toBe("Open the giver's Fit Report");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/demo/seed");
    expect(JSON.parse(String(init.body))).toEqual({ subject: "showcase-latina-medium-warm" });
  });

  it("sends the chosen subject", async () => {
    const fetchMock = vi.fn(async () => json(201, { ...seeded, subject: "showcase-man-lightmed-neutral" }));
    vi.stubGlobal("fetch", fetchMock);
    render(<JudgeDemo />);
    fireEvent.click(screen.getByTestId("demo-subject-3"));
    fireEvent.click(screen.getByTestId("try-judge-demo"));
    await screen.findByTestId("demo-recipient-link");
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ subject: "showcase-man-lightmed-neutral" });
  });

  it("handles the rate limit politely", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(429, { error: "rate_limited" }, { "retry-after": "540" })));
    render(<JudgeDemo compact />);
    fireEvent.click(screen.getByTestId("try-judge-demo"));
    const msg = await screen.findByTestId("judge-demo-error");
    expect(msg.textContent).toBe("The demo is busy for your network right now (up to 10 demos an hour). Please try again in about 9 minutes.");
    expect(screen.queryByTestId("demo-recipient-link")).toBeNull();
  });
});

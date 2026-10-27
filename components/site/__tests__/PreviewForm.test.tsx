// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { translator } from "@/lib/i18n";
import { PREVIEW_KEYS, pick } from "../labels";
import { PreviewForm } from "../PreviewForm";
import { checkStoreUrl, httpPreviewApi, mockPreviewApi, parseCreated, type PreviewApi } from "../previewApi";

const en = pick(translator("en"), PREVIEW_KEYS);
const vi_ = pick(translator("vi"), PREVIEW_KEYS);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function submit(url: string) {
  fireEvent.change(screen.getByTestId("preview-url"), { target: { value: url } });
  fireEvent.click(screen.getByTestId("preview-submit"));
}

describe("checkStoreUrl", () => {
  it("accepts public https addresses and adds https:// to a bare host", () => {
    expect(checkStoreUrl(" https://shop.example.com/products ")).toEqual({ ok: true, url: "https://shop.example.com/products" });
    expect(checkStoreUrl("shop.example.com")).toEqual({ ok: true, url: "https://shop.example.com/" });
  });
  it("rejects http, credentials, ports, local and IP hosts", () => {
    expect(checkStoreUrl("")).toEqual({ ok: false, error: "https" });
    expect(checkStoreUrl("http://shop.example.com")).toEqual({ ok: false, error: "https" });
    expect(checkStoreUrl("ftp://shop.example.com")).toEqual({ ok: false, error: "https" });
    for (const bad of ["https://user:pw@shop.example.com", "https://shop.example.com:8443", "https://localhost", "https://intranet", "https://10.0.0.1", "https://[::1]", "https://metadata.google.internal", "https://printer.local", "https://"]) {
      expect(checkStoreUrl(bad).ok, bad).toBe(false);
    }
  });
});

describe("preview API client", () => {
  it("parses 202 and keeps only same-origin paths", () => {
    expect(parseCreated({ key: "k", previewPath: "/s/k", statusPath: "/api/preview/k", ownerPath: "/s/k/admin#t=x" })).toEqual({ key: "k", previewPath: "/s/k", statusPath: "/api/preview/k", ownerPath: "/s/k/admin#t=x" });
    expect(parseCreated({ key: "k", previewPath: "https://evil.example/s/k", statusPath: "/api/preview/k", ownerPath: "/s/k/admin" })).toBeNull();
    expect(parseCreated({ key: "k", previewPath: "//evil.example", statusPath: "/a", ownerPath: "/b" })).toBeNull();
  });

  it("POSTs { url } and maps error codes", async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({ error: "daily_cap" }), { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await httpPreviewApi.create("https://shop.example.com/")).toEqual({ ok: false, error: "daily_cap" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/preview");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ url: "https://shop.example.com/" });

    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 429 }));
    expect(await httpPreviewApi.create("https://a.example/")).toEqual({ ok: false, error: "rate_limited" });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "blocked_url" }), { status: 400 }));
    expect(await httpPreviewApi.create("https://a.example/")).toEqual({ ok: false, error: "blocked_url" });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "disabled" }), { status: 503 }));
    expect(await httpPreviewApi.create("https://a.example/")).toEqual({ ok: false, error: "paused" });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "unavailable" }), { status: 503 }));
    expect(await httpPreviewApi.create("https://a.example/")).toEqual({ ok: false, error: "paused" });
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    expect(await httpPreviewApi.create("https://a.example/")).toEqual({ ok: false, error: "network" });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ key: "k", previewPath: "/s/k", statusPath: "/api/preview/k", ownerPath: "/s/k/o" }), { status: 202 }));
    expect(await httpPreviewApi.create("https://a.example/")).toEqual({ ok: true, created: { key: "k", previewPath: "/s/k", statusPath: "/api/preview/k", ownerPath: "/s/k/o" } });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ state: "crawling", productCount: 4 }), { status: 200 }));
    expect(await httpPreviewApi.status("/api/preview/k")).toEqual({ state: "crawling", productCount: 4, reason: null });
  });
});

describe("PreviewForm", () => {
  it("validates before calling the API", () => {
    const api: PreviewApi = { create: vi.fn(), status: vi.fn() };
    render(<PreviewForm labels={en} api={api} />);
    submit("http://shop.example.com");
    expect(screen.getByTestId("preview-error").textContent).toBe("Enter a full https:// address, for example https://your-store.com.");
    expect(screen.getByTestId("preview-url").getAttribute("aria-invalid")).toBe("true");
    submit("https://localhost:3000");
    expect(screen.getByTestId("preview-error").textContent).toBe("That doesn't look like a public https:// store address.");
    expect(api.create).not.toHaveBeenCalled();
  });

  it("mock flow: queued → crawling → ready with Open and Manage links and the owner-link note", async () => {
    render(<PreviewForm labels={en} mock pollMs={5} />);
    expect(screen.getByText("Demo mode: no website is contacted.")).toBeTruthy();
    submit("https://shop.example.com");
    expect(screen.getByTestId("preview-submit").textContent).toBe("Building…");
    expect(await screen.findByText(/Reading public product pages… 7 found so far\./)).toBeTruthy();
    const ready = await screen.findByTestId("preview-ready");
    expect(screen.getByTestId("preview-progress").textContent).toBe("Your preview is ready: 12 products.");
    expect(screen.getByTestId("preview-open").getAttribute("href")).toMatch(/^\/s\/mock[a-z0-9]+$/);
    expect(screen.getByTestId("preview-manage").getAttribute("href")).toMatch(/^\/s\/mock[a-z0-9]+\/admin#t=/);
    expect(ready.textContent).toContain("private and shown only once");
    expect(screen.getByTestId("preview-submit").textContent).toBe("Build my preview");
  });

  it("refused: explains the 3-product minimum", async () => {
    render(<PreviewForm labels={en} mock pollMs={5} />);
    submit("https://few-products.example");
    expect((await screen.findByTestId("preview-refused")).textContent).toMatch(/^We found 2 public products there; a preview needs at least 3\./);
    expect(screen.queryByTestId("preview-ready")).toBeNull();
  });

  it("429: rate limit and daily cap", async () => {
    render(<PreviewForm labels={en} mock pollMs={5} />);
    submit("https://limit.example");
    expect((await screen.findByTestId("preview-error")).textContent).toBe("You've reached today's preview limit for your network. Please try again tomorrow.");
    submit("https://cap.example");
    expect((await screen.findByText(/GiftFit has built all the previews it can today/)).getAttribute("data-testid")).toBe("preview-error");
  });

  it("site_blocked and paused get calm, specific copy", async () => {
    render(<PreviewForm labels={en} mock pollMs={5} />);
    submit("https://guarded.example");
    expect((await screen.findByTestId("preview-error")).textContent).toMatch(/^This site blocks automated visitors/);
    submit("https://paused.example");
    expect((await screen.findByText("Previews are paused right now. Please try again a little later.")).getAttribute("data-testid")).toBe("preview-error");
  });

  it("failed with a known reason; Vietnamese copy", async () => {
    render(<PreviewForm labels={vi_} api={mockPreviewApi({ pollsUntilDone: 0 })} pollMs={5} />);
    submit("https://few.example");
    expect((await screen.findByTestId("preview-refused")).textContent).toMatch(/^Chúng tôi tìm thấy 2 sản phẩm công khai; bản xem trước cần ít nhất 3\./);
    submit("https://fail.example");
    expect((await screen.findByTestId("preview-error")).textContent).toBe("Không truy cập được website đó. Kiểm tra lại địa chỉ rồi thử lại.");
  });
});

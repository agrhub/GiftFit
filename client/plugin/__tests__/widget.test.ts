// @vitest-environment jsdom
/**
 * client/plugin/giftfit.js v0.2 widget (owner: A6): PDP context detection (JSON-LD → Open Graph →
 * DOM), the isolated launcher iframe, and the origin-checked postMessage protocol v1.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SOURCE = readFileSync(path.join(process.cwd(), "client", "plugin", "giftfit.js"), "utf8");
const APP = "https://app.giftfit.test";

type Ctx = { title: string; price?: number; currency?: string; image?: string; url?: string; sku?: string; source: string } | null;
type Api = { version: string; detectContext(doc?: Document): Ctx; openWidget(): void; closeWidget(): void; destroy(): void };
const api = () => (window as unknown as { GiftFit: Api }).GiftFit;

function page(head: string, body = "", attrs = 'data-store="aurum"') {
  document.head.innerHTML = head;
  document.body.innerHTML = `${body}<script src="${APP}/giftfit.js" ${attrs} async></script>`;
}
function reset() {
  const w = window as unknown as { GiftFit?: { destroy?: () => void } };
  w.GiftFit?.destroy?.();
  delete w.GiftFit;
}
const run = () => new Function(SOURCE)();
const LD = (obj: unknown) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;
const widgetHost = () => document.querySelector("giftfit-widget") as HTMLElement | null;
const widgetFrame = () => widgetHost()!.shadowRoot!.querySelector("iframe")!;
const fromFrame = (data: unknown, origin = APP, source: unknown = widgetFrame().contentWindow) => window.dispatchEvent(new MessageEvent("message", { data, origin, source: source as Window }));
const msg = (type: string, extra: Record<string, unknown> = {}) => ({ source: "giftfit-widget", v: 1, type, ...extra });

beforeEach(() => {
  reset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ found: false }) })),
  );
});
afterEach(() => {
  reset();
  vi.unstubAllGlobals();
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("lang");
});

describe("detectContext", () => {
  it("JSON-LD Product first: offers, image arrays, relative URLs, @graph", () => {
    page(
      LD({
        "@graph": [
          { "@type": "WebPage" },
          { "@type": "Product", name: "Halo Drop Earrings", sku: "AUR-EAR-028", image: ["/img/halo.jpg"], url: "/p/halo?ref=x", offers: { "@type": "AggregateOffer", lowPrice: "199.00", priceCurrency: "usd", offers: [{ price: "245.00", priceCurrency: "USD" }] } },
        ],
      }) + '<meta property="og:type" content="product"><meta property="og:title" content="OG title">',
    );
    run();
    expect(api().detectContext()).toEqual({ title: "Halo Drop Earrings", price: 245, currency: "USD", image: "http://localhost:3000/img/halo.jpg", url: "http://localhost:3000/p/halo", sku: "AUR-EAR-028", source: "json-ld" });
  });

  it("then Open Graph product tags", () => {
    page(
      '<script type="application/ld+json">{broken</script><meta property="og:type" content="og:product"><meta property="og:title" content="Pearl Studs"><meta property="og:image" content="https://cdn.example/p.jpg"><meta property="product:price:amount" content="1.299,50"><meta property="product:price:currency" content="EUR"><meta property="og:url" content="https://shop.example/p/pearl#x"><meta property="product:retailer_item_id" content="PS-1">',
    );
    run();
    expect(api().detectContext()).toEqual({ title: "Pearl Studs", price: 1299.5, currency: "EUR", image: "https://cdn.example/p.jpg", url: "https://shop.example/p/pearl", sku: "PS-1", source: "open-graph" });
  });

  it("then a DOM heuristic (add-to-cart + h1), and null on other pages", () => {
    page("", '<main><h1> Gold  Hoops </h1><span class="product-price">$89.00</span><div class="product-gallery"><img src="/hoops.jpg"></div><button class="add-to-cart">Add</button></main>');
    run();
    expect(api().detectContext()).toMatchObject({ title: "Gold Hoops", price: 89, currency: "USD", image: "http://localhost:3000/hoops.jpg", source: "dom" });

    reset();
    page("<title>Blog</title>", "<h1>Our story</h1><p>No cart here.</p>");
    run();
    expect(api().detectContext()).toBeNull();
  });

  it("drops script URLs, control characters and absurd prices", () => {
    page(LD({ "@type": "Product", name: "Ring‮\u0000 X", image: "javascript:alert(1)", url: "data:text/html,x", offers: { price: "-3", priceCurrency: "dollars" } }));
    run();
    expect(api().detectContext()).toEqual({ title: "Ring X", source: "json-ld" });
  });
});

describe("widget iframe", () => {
  it("mounts an isolated, hidden launcher frame pointing at /w with the parent origin and language config", () => {
    page("", "", 'data-store="aurum" data-lang="vi" data-langs="en,vi"');
    run();
    const host = widgetHost()!;
    expect(host).not.toBeNull();
    expect(host.hasAttribute("data-ready")).toBe(false);
    expect(host.getAttribute("data-mode")).toBe("launcher");
    expect(host.shadowRoot!.querySelector("style")!.textContent).toContain(":host{all:initial");
    const src = new URL(widgetFrame().src);
    expect(src.origin + src.pathname).toBe(`${APP}/w`);
    expect(Object.fromEntries(src.searchParams)).toEqual({ store: "aurum", parent: window.location.origin, v: "1", lang: "vi", langs: "en,vi" });
    expect(document.querySelectorAll("iframe")).toHaveLength(0); // only inside the shadow root
  });

  it("survives a cold start: no hello for 45 s reloads the frame once; removed only after a second 45 s", () => {
    vi.useFakeTimers();
    try {
      page("");
      run();
      const frame = widgetFrame();
      const reloads: string[] = [];
      const desc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "src")!;
      Object.defineProperty(frame, "src", { configurable: true, get: () => desc.get!.call(frame), set: (v: string) => { reloads.push(v); desc.set!.call(frame, v); } });
      vi.advanceTimersByTime(20_000);
      expect(widgetHost()).not.toBeNull(); // the old 20 s limit no longer removes it
      vi.advanceTimersByTime(25_000);
      expect(reloads).toHaveLength(1);
      expect(widgetHost()).not.toBeNull();
      vi.advanceTimersByTime(45_000);
      expect(widgetHost()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a hello after the reload keeps the widget", () => {
    vi.useFakeTimers();
    try {
      page("");
      run();
      vi.advanceTimersByTime(46_000);
      fromFrame(msg("ready"));
      vi.advanceTimersByTime(60_000);
      expect(widgetHost()?.hasAttribute("data-ready")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("data-widget=off keeps v0.1 behaviour only", () => {
    page("", "", 'data-store="aurum" data-widget="off"');
    run();
    expect(widgetHost()).toBeNull();
  });

  it("answers `ready` with the sanitised context, posted to the app origin only", () => {
    document.documentElement.setAttribute("lang", "vi-VN");
    page(LD({ "@type": "Product", name: "Halo", sku: "AUR-EAR-028", offers: { price: 245, priceCurrency: "USD" } }));
    run();
    const post = vi.spyOn(widgetFrame().contentWindow!, "postMessage");
    fromFrame(msg("ready"));
    expect(widgetHost()!.hasAttribute("data-ready")).toBe(true);
    expect(post).toHaveBeenCalledTimes(1);
    const [data, target] = post.mock.calls[0] as unknown as [Record<string, unknown>, string];
    expect(target).toBe(APP);
    expect(data).toEqual({ source: "giftfit-widget", v: 1, type: "context", product: { title: "Halo", price: 245, currency: "USD", sku: "AUR-EAR-028", source: "json-ld" }, page: { lang: "vi-VN", url: `${window.location.origin}/` } });
  });

  it("only its own frame on the app origin can resize it or raise events", () => {
    page("");
    run();
    const events: string[] = [];
    window.addEventListener("giftfit:sent", () => events.push("sent"));
    window.addEventListener("giftfit:close", () => events.push("close"));

    fromFrame(msg("resize", { mode: "panel" }), "https://evil.example");
    fromFrame(msg("resize", { mode: "panel" }), APP, window);
    fromFrame({ ...msg("resize", { mode: "panel" }), v: 2 });
    fromFrame(msg("resize", { mode: "fullscreen" }));
    expect(widgetHost()!.getAttribute("data-mode")).toBe("launcher");

    fromFrame(msg("resize", { mode: "tip" }));
    expect(widgetHost()!.getAttribute("data-mode")).toBe("tip");
    fromFrame(msg("resize", { mode: "panel" }));
    expect(widgetHost()!.getAttribute("data-mode")).toBe("panel");

    fromFrame(msg("sent"), "https://evil.example");
    fromFrame(msg("sent"));
    fromFrame(msg("close"));
    expect(events).toEqual(["sent", "close"]);
    expect(widgetHost()!.getAttribute("data-mode")).toBe("launcher");
  });

  it("openWidget / closeWidget post to the frame; destroy removes it", () => {
    page("");
    run();
    const post = vi.spyOn(widgetFrame().contentWindow!, "postMessage");
    api().openWidget();
    api().closeWidget();
    expect(post.mock.calls.map((c) => [(c[0] as { type: string }).type, c[1]])).toEqual([
      ["open", APP],
      ["close", APP],
    ]);
    api().destroy();
    expect(widgetHost()).toBeNull();
  });

  it("a floating Gift it right button moves to the left when the widget owns the right corner", async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: async () => ({ found: true, product: { id: "1", title: "Halo" }, embedPath: "/embed?store=aurum&sku=halo" }) });
    page(LD({ "@type": "Product", sku: "AUR-EAR-028" }));
    run();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    const button = document.querySelector("giftfit-button")!;
    expect(button.hasAttribute("data-floating")).toBe(true);
    expect(button.hasAttribute("data-left")).toBe(true);
  });
});

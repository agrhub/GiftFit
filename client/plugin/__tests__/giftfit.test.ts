// @vitest-environment jsdom
/**
 * client/plugin/giftfit.js in a DOM (owner: A6): product detection, lookup, shadow-root button,
 * iframe overlay and origin-checked postMessage.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SOURCE = readFileSync(path.join(process.cwd(), "client", "plugin", "giftfit.js"), "utf8");
const APP = "https://app.giftfit.test";

type GiftFitApi = { version: string; detectProduct(doc?: Document): { sku: string | null; url: string | null; name: string | null; source: string } | null; open(): void; close(): void };
const api = () => (window as unknown as { GiftFit: GiftFitApi }).GiftFit;

function page(head: string, body = "") {
  document.head.innerHTML = head;
  document.body.innerHTML = `${body}<script src="${APP}/giftfit.js" data-store="aurum" async></script>`;
}

function reset() {
  const w = window as unknown as { GiftFit?: { destroy?: () => void } };
  w.GiftFit?.destroy?.();
  delete w.GiftFit;
}

function run() {
  new Function(SOURCE)();
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  reset();
  fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ found: true, product: { id: "id-1", title: "Halo Drop Earrings" }, embedPath: "/embed?store=aurum&sku=halo-drop-earrings" }),
  }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.documentElement.style.overflow = "";
});

const LD = (obj: unknown) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;

describe("detectProduct", () => {
  it("prefers data-giftfit-sku, then JSON-LD (incl. @graph), then Open Graph", () => {
    page(LD({ "@graph": [{ "@type": "Organization" }, { "@type": ["Thing", "Product"], sku: "AUR-EAR-028", name: "Halo" }] }));
    run();
    expect(api().detectProduct()).toEqual({ sku: "AUR-EAR-028", url: null, name: "Halo", source: "json-ld" });

    page(LD({ "@type": "Product", sku: "X" }), '<div data-giftfit-sku="AUR-NEC-037"></div>');
    expect(api().detectProduct()).toMatchObject({ sku: "AUR-NEC-037", source: "data-attribute" });

    page('<script type="application/ld+json">{not json</script><meta property="og:type" content="product"><meta property="og:url" content="https://s.example/p/halo-drop-earrings"><meta property="og:title" content="Halo Drop Earrings">');
    expect(api().detectProduct()).toEqual({ sku: null, url: "https://s.example/p/halo-drop-earrings", name: "Halo Drop Earrings", source: "open-graph" });

    page('<meta property="og:type" content="website">');
    expect(api().detectProduct()).toBeNull();
  });
});

describe("injection", () => {
  it("looks the product up on the app origin and injects an isolated button after add-to-cart", async () => {
    page(LD({ "@type": "Product", sku: "AUR-EAR-028" }), '<form action="/cart/add"><button type="submit" name="add">Add</button></form>');
    run();
    await flush();
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.origin).toBe(APP);
    expect(url.pathname).toBe("/api/retailer/lookup");
    expect(url.searchParams.get("store")).toBe("aurum");
    expect(url.searchParams.get("sku")).toBe("AUR-EAR-028");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: "omit" });

    const host = document.querySelector("giftfit-button")!;
    expect(host).not.toBeNull();
    expect(host.previousElementSibling?.getAttribute("name")).toBe("add");
    const button = host.shadowRoot!.querySelector("button")!;
    expect(button.textContent).toContain("Gift it right");
    expect(host.shadowRoot!.querySelector("style")!.textContent).toContain(":host{all:initial");
    // Not reachable by page selectors.
    expect(document.querySelectorAll("button").length).toBe(1);
  });

  it("uses [data-giftfit-mount], or floats when there is no anchor", async () => {
    page(LD({ "@type": "Product", sku: "A" }), "<section data-giftfit-mount></section>");
    run();
    await flush();
    expect(document.querySelector("[data-giftfit-mount] > giftfit-button")).not.toBeNull();

    reset();
    page(LD({ "@type": "Product", sku: "A" }));
    run();
    await flush();
    expect(document.querySelector("giftfit-button")?.hasAttribute("data-floating")).toBe(true);
  });

  it("adds nothing when the product is not in the catalog, or the page has no product", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ found: false, reason: "not_in_catalog" }) });
    page(LD({ "@type": "Product", sku: "NOPE" }));
    run();
    await flush();
    expect(document.querySelector("giftfit-button")).toBeNull();

    reset();
    fetchMock.mockClear();
    page("<title>No product</title>");
    run();
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("puts the button back when the page re-renders its mount (hydration, SPA)", async () => {
    page(LD({ "@type": "Product", sku: "A" }), "<section id=s><div data-giftfit-mount></div></section>");
    run();
    await flush();
    const host = document.querySelector("giftfit-button")!;
    document.getElementById("s")!.innerHTML = "<div data-giftfit-mount></div>";
    expect(host.isConnected).toBe(false);
    await new Promise((r) => setTimeout(r, 120));
    expect(host.isConnected).toBe(true);
    expect(document.querySelector("[data-giftfit-mount] > giftfit-button")).toBe(host);
  });

  it("runs once even if the tag is included twice", async () => {
    page(LD({ "@type": "Product", sku: "A" }));
    run();
    run();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("overlay and postMessage", () => {
  async function opened() {
    page(LD({ "@type": "Product", sku: "AUR-EAR-028" }));
    run();
    await flush();
    document.querySelector("giftfit-button")!.shadowRoot!.querySelector("button")!.click();
    const overlay = document.querySelector("giftfit-overlay")!;
    const frame = overlay.shadowRoot!.querySelector("iframe")!;
    return { overlay, frame };
  }

  it("opens the app's embed page with the parent origin", async () => {
    const { frame } = await opened();
    const src = new URL(frame.src);
    expect(src.origin).toBe(APP);
    expect(src.pathname).toBe("/embed");
    expect(src.searchParams.get("sku")).toBe("halo-drop-earrings");
    expect(src.searchParams.get("parent")).toBe(window.location.origin);
    expect(frame.title).toBe("Gift it right");
    expect(document.documentElement.style.overflow).toBe("hidden");
  });

  it("closes only on a message from the app origin and from its own frame", async () => {
    const { frame } = await opened();
    const events: string[] = [];
    window.addEventListener("giftfit:sent", () => events.push("sent"));
    window.addEventListener("giftfit:close", () => events.push("close"));
    const msg = (type: string) => ({ source: "giftfit", type });

    window.dispatchEvent(new MessageEvent("message", { data: msg("giftfit:close"), origin: "https://evil.example", source: frame.contentWindow }));
    window.dispatchEvent(new MessageEvent("message", { data: msg("giftfit:close"), origin: APP, source: window }));
    expect(document.querySelector("giftfit-overlay")).not.toBeNull();

    window.dispatchEvent(new MessageEvent("message", { data: msg("giftfit:sent"), origin: APP, source: frame.contentWindow }));
    window.dispatchEvent(new MessageEvent("message", { data: msg("giftfit:close"), origin: APP, source: frame.contentWindow }));
    expect(document.querySelector("giftfit-overlay")).toBeNull();
    expect(events).toEqual(["sent", "close"]);
    expect(document.documentElement.style.overflow).toBe("");
  });
});

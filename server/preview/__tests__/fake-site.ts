/**
 * Test helpers: an in-process "internet" for SafeFetcher (no sockets, no DNS). Every site is self-authored
 * and lives on reserved `.test` host names (docs/ingest-policy.md).
 */
import type { PinnedRequest, PinnedResponse, Resolver, SafeFetcherOptions, Transport } from "@/server/ingest/safe-fetch";
import { SafeFetchError } from "@/server/ingest/safe-fetch";

export interface Route {
  status?: number;
  type?: string;
  body?: string;
  headers?: Record<string, string>;
}

export const PUBLIC_IP = "93.184.215.14";

export interface FakeNet {
  transport: Transport;
  resolver: Resolver;
  calls: PinnedRequest[];
  /** Requested hrefs in order. */
  hrefs: () => string[];
  options: SafeFetcherOptions;
}

/**
 * routes: href → response (string = 200 body with a type guessed from the path). Unknown hrefs answer 404.
 * dns: hostname → addresses (default: PUBLIC_IP for every host).
 */
export function fakeNet(routes: Record<string, Route | string>, dns: Record<string, string[]> = {}): FakeNet {
  const calls: PinnedRequest[] = [];
  const transport: Transport = async (req): Promise<PinnedResponse> => {
    calls.push(req);
    const r = routes[req.url.href];
    if (r === undefined) return { status: 404, headers: { "content-type": "text/html" }, body: Buffer.alloc(0) };
    const route: Route = typeof r === "string" ? { body: r } : r;
    if (route.status === -1) throw new SafeFetchError("network", "connection refused");
    const status = route.status ?? 200;
    const type =
      route.type ??
      (/\.json(\?|$)|\/wp-json\//.test(req.url.href) ? "application/json; charset=utf-8" : /\.xml(\?|$)/.test(req.url.href) ? "application/xml" : /robots\.txt$/.test(req.url.href) ? "text/plain" : "text/html; charset=utf-8");
    const body = Buffer.from(route.body ?? "", "utf8");
    if (body.length > req.maxBytes) throw new SafeFetchError("too_large", "the response is too large");
    return { status, headers: { "content-type": type, ...(route.headers ?? {}) }, body: status >= 200 && status < 300 ? body : Buffer.alloc(0) };
  };
  const resolver: Resolver = async (host) => {
    const addrs = dns[host] ?? [PUBLIC_IP];
    if (!addrs.length) throw new Error("ENOTFOUND");
    return addrs.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
  return {
    transport,
    resolver,
    calls,
    hrefs: () => calls.map((c) => c.url.href),
    options: { transport, resolver, sleep: async () => {} },
  };
}

export const html = (head: string, body = "") => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

export const jsonLdPage = (p: { name: string; price?: number; currency?: string; image?: string; sku?: string; material?: string; category?: string }) =>
  html(
    `<title>${p.name}</title><script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Product",
      name: p.name,
      sku: p.sku,
      image: p.image ? [p.image] : undefined,
      material: p.material,
      category: p.category,
      offers: p.price !== undefined ? { "@type": "Offer", price: p.price, priceCurrency: p.currency ?? "EUR" } : undefined,
    })}</script>`,
    `<main><h1>${p.name}</h1></main>`,
  );

export function shopifyProducts(n: number, start = 1) {
  return Array.from({ length: n }, (_, i) => {
    const id = start + i;
    const isRing = id % 2 === 1;
    return {
      id: 7000 + id,
      title: isRing ? `Fixture Band Ring ${id}` : `Fixture Pendant Necklace ${id}`,
      handle: isRing ? `fixture-band-ring-${id}` : `fixture-pendant-necklace-${id}`,
      body_html: `<p>A <strong>dainty</strong> self-authored test piece number ${id}. ${"Long text. ".repeat(40)}</p>`,
      product_type: isRing ? "Rings" : "Necklaces",
      tags: ["gift", "style::minimal"],
      options: [{ name: "Metal" }, { name: "Size" }],
      variants: [
        { id: 1, price: `${100 + id}.00`, option1: "14k Yellow Gold", option2: "6", available: true },
        { id: 2, price: `${150 + id}.00`, option1: "Sterling Silver", option2: "7", available: false },
      ],
      images: [{ src: `https://cdn.shop-fixture.test/img/${id}.jpg?v=1` }, { src: `http://insecure.test/${id}.jpg` }],
    };
  });
}

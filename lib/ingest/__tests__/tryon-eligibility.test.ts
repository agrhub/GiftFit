/**
 * Try-on eligibility heuristics (A16). Pure rules plus probes through an injected function: no network, no AI,
 * no YouCam.
 */
import { describe, expect, it, vi } from "vitest";
import { candidateImages, checkImage, classifyProducts, classifyTryOn, imagesToProbe, MAX_IMAGE_PROBES, resizableUrl, sniffImage, tryOnReasonText, type ClassifiableProduct } from "../tryon-eligibility";

const img = (name: string, host = "cdn.shopify.com") => `https://${host}/s/files/1/products/${name}`;
const product = (over: Partial<ClassifiableProduct> = {}): ClassifiableProduct => ({
  title: "Halo Drop Earrings",
  category: "earring",
  categoryText: "Earrings",
  tags: [],
  images: [img("halo-drop.jpg")],
  imageMeta: [{ url: img("halo-drop.jpg"), width: 1200, height: 1200, position: 1 }],
  ...over,
});

/** Minimal headers for sniffing. */
function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  b[25] = 6; // RGBA
  return b;
}
function jpeg(w: number, h: number): Uint8Array {
  // SOI, APP0 (length 16), SOF0 (length 17): height, width.
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0)];
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 3, ...new Array(9).fill(0)];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof]);
}
const webp = () => new Uint8Array([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBPVP8X"), 10, 0, 0, 0, 0, 0, 0, 0, 0xff, 0x03, 0, 0xff, 0x03, 0, 0, 0]);

describe("sniffImage", () => {
  it("reads PNG, JPEG (SOF after APP0), GIF and WebP headers", () => {
    expect(sniffImage(png(1600, 1200))).toEqual({ format: "png", width: 1600, height: 1200 });
    expect(sniffImage(jpeg(1080, 1440))).toEqual({ format: "jpeg", width: 1080, height: 1440 });
    expect(sniffImage(new Uint8Array([...Buffer.from("GIF89a"), 0x20, 0x03, 0x58, 0x02]))).toEqual({ format: "gif", width: 800, height: 600 });
    expect(sniffImage(webp())).toMatchObject({ format: "webp", width: 1024, height: 1024 });
    expect(sniffImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')).format).toBe("svg");
    expect(sniffImage(new Uint8Array([1, 2, 3])).format).toBe("unknown");
    // A JPEG head cut before its SOF still says "jpeg", size unknown.
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))).toEqual({ format: "jpeg" });
  });
});

describe("classifyTryOn", () => {
  it("a 1200 px jpg packshot of an earring/necklace/ring/bracelet/watch is eligible", () => {
    for (const category of ["earring", "necklace", "ring", "bracelet", "watch"] as const) {
      expect(classifyTryOn(product({ category, title: "Piece" }))).toEqual({ category, tryOnEligible: true, tryOnReason: "ok", tryOnImage: img("halo-drop.jpg") });
    }
  });

  it("non-jewelry is 'other' and never eligible", () => {
    expect(classifyTryOn(product({ category: null, title: "Jasmine Tea Gift Box" }))).toEqual({ category: "other", tryOnEligible: false, tryOnReason: "not_jewelry" });
  });

  it("format: jpg/png only; webp, gif, svg are refused; no extension and no probe is unknown", () => {
    expect(classifyTryOn(product({ images: [img("a.png")], imageMeta: [] })).tryOnReason).toBe("ok_size_unknown");
    expect(classifyTryOn(product({ images: [img("a.webp")], imageMeta: [] })).tryOnReason).toBe("unsupported_format");
    expect(classifyTryOn(product({ images: [img("a.gif")], imageMeta: [] })).tryOnReason).toBe("unsupported_format");
    expect(classifyTryOn(product({ images: ["https://shop.test/image?id=7"], imageMeta: [] })).tryOnReason).toBe("format_unknown");
    // A probe settles an extension-less URL.
    const u = "https://shop.test/image?id=7";
    expect(classifyTryOn(product({ images: [u], imageMeta: [] }), new Map([[u, { format: "jpeg", width: 900, height: 900 }]]))).toMatchObject({ tryOnEligible: true, tryOnReason: "ok" });
  });

  it("pixel size and aspect: thumbnails and banners are refused; a too-large Shopify image is resized, others refused", () => {
    expect(classifyTryOn(product({ imageMeta: [{ url: img("halo-drop.jpg"), width: 300, height: 300 }] })).tryOnReason).toBe("image_too_small");
    expect(classifyTryOn(product({ imageMeta: [{ url: img("halo-drop.jpg"), width: 3000, height: 800 }] })).tryOnReason).toBe("odd_aspect");
    const big = classifyTryOn(product({ imageMeta: [{ url: img("halo-drop.jpg"), width: 5000, height: 5000 }] }));
    expect(big).toMatchObject({ tryOnEligible: true, tryOnReason: "ok" });
    expect(new URL(big.tryOnImage!).searchParams.get("width")).toBe("2048");
    const other = "https://img.shop.test/halo.jpg";
    expect(classifyTryOn(product({ images: [other], imageMeta: [{ url: other, width: 5000, height: 5000 }] })).tryOnReason).toBe("image_too_large");
    expect(resizableUrl("https://shop.test/cdn/shop/files/a.jpg?v=1")).toBe("https://shop.test/cdn/shop/files/a.jpg?v=1&width=2048");
    expect(resizableUrl("https://img.shop.test/a.jpg")).toBeNull();
  });

  it("worn/lifestyle photos (alt text or file name) are refused; the next image may still pass", () => {
    expect(classifyTryOn(product({ imageMeta: [{ url: img("halo-drop.jpg"), width: 1200, height: 1200, alt: "Model wearing Halo Drop Earrings" }] })).tryOnReason).toBe("worn_or_lifestyle");
    expect(classifyTryOn(product({ images: [img("halo-on-model.jpg")], imageMeta: [] })).tryOnReason).toBe("worn_or_lifestyle");
    const two = product({
      images: [img("lifestyle-beach.jpg"), img("halo-white.jpg")],
      imageMeta: [
        { url: img("lifestyle-beach.jpg"), width: 1200, height: 1500 },
        { url: img("halo-white.jpg"), width: 1200, height: 1200 },
      ],
    });
    expect(classifyTryOn(two)).toMatchObject({ tryOnEligible: true, tryOnImage: img("halo-white.jpg") });
  });

  it("only the first two images are candidates (later Shopify positions are usually lifestyle shots)", () => {
    const p = product({ images: [img("a.webp"), img("b.gif"), img("c.jpg")], imageMeta: [] });
    expect(candidateImages(p).map((c) => c.url)).toEqual([img("a.webp"), img("b.gif")]);
    expect(classifyTryOn(p)).toMatchObject({ tryOnEligible: false, tryOnReason: "unsupported_format" });
  });

  it("sets, stacks and bundles are refused; a single 'bezel-set' piece is not a set", () => {
    expect(classifyTryOn(product({ title: "Stacking Ring Set" })).tryOnReason).toBe("multiple_items");
    expect(classifyTryOn(product({ title: "Huggie Earring Trio" })).tryOnReason).toBe("multiple_items");
    expect(classifyTryOn(product({ title: "3-Piece Necklace Bundle", category: "necklace" })).tryOnReason).toBe("multiple_items");
    expect(classifyTryOn(product({ title: "Bezel Set Diamond Ring", category: "ring" })).tryOnEligible).toBe(true);
    expect(classifyTryOn(product({ title: "Prong-set Solitaire Studs" })).tryOnEligible).toBe(true);
  });

  it("accessories are refused: boxes, holders, cleaners, gift cards, watch straps sold alone", () => {
    expect(classifyTryOn(product({ title: "Velvet Ring Box", category: "ring" })).tryOnReason).toBe("accessory");
    expect(classifyTryOn(product({ title: "Jewelry Cleaner Kit", category: "ring" })).tryOnReason).toBe("accessory");
    expect(classifyTryOn(product({ title: "Gift Card $50", category: "necklace" })).tryOnReason).toBe("accessory");
    expect(classifyTryOn(product({ title: "Leather Strap 20 mm", category: "watch" })).tryOnReason).toBe("accessory");
    expect(classifyTryOn(product({ title: "Classic Watch with Leather Strap", category: "watch" })).tryOnEligible).toBe(true);
  });

  it("no image → no_image; the reason text never talks about the recipient", () => {
    expect(classifyTryOn(product({ images: [], imageMeta: [] })).tryOnReason).toBe("no_image");
    for (const r of ["not_jewelry", "worn_or_lifestyle", "multiple_items", "accessory", "image_too_small", "format_unknown", undefined] as const) {
      expect(tryOnReasonText(r)).not.toMatch(/undertone|skin|face|selfie/i);
    }
  });

  it("checkImage alone: the alt text decides worn shots even for a perfect file", () => {
    expect(checkImage({ url: img("p.png"), width: 1000, height: 1000, alt: "lifestyle" })).toEqual({ ok: false, reason: "worn_or_lifestyle" });
    expect(checkImage({ url: img("p.png"), width: 1000, height: 1000 })).toEqual({ ok: true, reason: "ok", image: img("p.png") });
  });
});

describe("classifyProducts (with probes)", () => {
  it("probes only jewelry images whose size or format is unknown, at most maxProbes, and strips imageMeta", async () => {
    const products = [
      product({ title: "Known", images: [img("known.jpg")], imageMeta: [{ url: img("known.jpg"), width: 1000, height: 1000 }] }),
      product({ title: "Unknown A", images: [img("a.jpg")], imageMeta: [] }),
      product({ title: "Unknown B", images: ["https://shop.test/img?b"], imageMeta: [] }),
      product({ title: "Tea", category: null, images: [img("tea.jpg")], imageMeta: [] }),
      product({ title: "Ring Box", category: "ring", images: [img("box.jpg")], imageMeta: [] }),
    ];
    expect(imagesToProbe(products)).toEqual([img("a.jpg"), "https://shop.test/img?b"]);
    const probe = vi.fn(async (u: string) => (u.endsWith("a.jpg") ? png(200, 200) : jpeg(1000, 1250)));
    const out = await classifyProducts(products, { probe, maxProbes: 5 });
    expect(probe).toHaveBeenCalledTimes(2);
    expect(out.map((p) => [p.title, p.tryOnEligible, p.tryOnReason])).toEqual([
      ["Known", true, "ok"],
      ["Unknown A", false, "image_too_small"], // the probe found a 200 px image behind the .jpg name
      ["Unknown B", true, "ok"],
      ["Tea", false, "not_jewelry"],
      ["Ring Box", false, "accessory"],
    ]);
    for (const p of out) expect(p).not.toHaveProperty("imageMeta");
  });

  it("stops at maxProbes or when told to stop; a failed probe falls back to the URL rules", async () => {
    const many = Array.from({ length: 10 }, (_, i) => product({ title: `P${i}`, images: [img(`p${i}.jpg`)], imageMeta: [] }));
    const probe = vi.fn(async () => {
      throw new Error("network");
    });
    const out = await classifyProducts(many, { probe });
    expect(probe).toHaveBeenCalledTimes(MAX_IMAGE_PROBES);
    expect(out.every((p) => p.tryOnReason === "ok_size_unknown")).toBe(true);
    let n = 0;
    const stopper = vi.fn(async () => null);
    await classifyProducts(many, { probe: stopper, shouldStop: () => n++ >= 2 });
    expect(stopper).toHaveBeenCalledTimes(2);
  });
});

describe("SafeFetcher.getImageHead (A16)", () => {
  it("a ranged, identity-encoded GET through the same guards; 404 → null; a non-image type is refused", async () => {
    const { fakeNet } = await import("@/lib/preview/__tests__/fake-site");
    const { SafeFetcher, IMAGE_HEAD_BYTES, isSafeFetchError } = await import("../safe-fetch");
    const head = Buffer.from(png(1200, 900));
    const net = fakeNet({
      "https://cdn.shop.test/robots.txt": "User-agent: *\nDisallow: /private/\n",
      "https://cdn.shop.test/a.png": { type: "image/png", body: head.toString("latin1"), headers: {} },
      "https://cdn.shop.test/page.png": { type: "text/html", body: "<html>" },
    });
    const f = new SafeFetcher(net.options);
    const r = await f.getImageHead("https://cdn.shop.test/a.png");
    expect(r?.contentType).toBe("image/png");
    const call = net.calls.find((c) => c.url.pathname === "/a.png")!;
    expect(call.headers).toMatchObject({ range: `bytes=0-${IMAGE_HEAD_BYTES - 1}`, "accept-encoding": "identity", accept: "image/jpeg,image/png" });
    expect(call.maxBytes).toBe(IMAGE_HEAD_BYTES);
    expect(call.truncate).toBe(true);
    expect(await f.getImageHead("https://cdn.shop.test/missing.jpg")).toBeNull();
    await expect(f.getImageHead("https://cdn.shop.test/page.png")).rejects.toSatisfy((e: unknown) => isSafeFetchError(e, "bad_content_type"));
    await expect(f.getImageHead("https://cdn.shop.test/private/x.png")).rejects.toSatisfy((e: unknown) => isSafeFetchError(e, "robots_disallowed"));
    await expect(f.getImageHead("http://cdn.shop.test/a.png")).rejects.toSatisfy((e: unknown) => isSafeFetchError(e, "blocked_url"));
  });
});

/**
 * Fixture store-URL previews for tests and the e2e seed route (owner: A6, ADR-055). Fictional stores on
 * reserved `.example` domains; product images point at the app's own public catalog images. Never
 * crawled, never real merchant data.
 */
import { PREVIEW_TTL_MS, type PreviewRecord } from "@/lib/preview/repo";
import { hashOwnerToken, newOwnerToken, newPreviewKey } from "@/lib/preview/tokens";
import type { PreviewProduct } from "@/lib/preview/types";

export type FixtureKind = "jewelry" | "generic";

const JEWELRY: Array<[string, string, number, PreviewProduct["category"], PreviewProduct["metal"], string]> = [
  ["1001", "Aria Gold Hoops", 180, "earring", "yellow_gold", "aur-ear-004.png"],
  ["1002", "Lumen Pearl Studs", 120, "earring", "white_gold", "aur-ear-002.png"],
  ["1003", "Petal Rose Drops", 210, "earring", "rose_gold", "aur-ear-006.png"],
  ["1004", "Silver Moon Huggies", 95, "earring", "silver", "aur-ear-010.png"],
  ["1005", "Halo Spark Drops", 260, "earring", "yellow_gold", "aur-ear-012.png"],
  ["1006", "Fern Leaf Studs", 140, "earring", "white_gold", "aur-ear-014.png"],
  ["1007", "Tide Bar Earrings", 155, "earring", "silver", "aur-ear-016.png"],
  ["1008", "Ember Teardrops", 230, "earring", "rose_gold", "aur-ear-018.png"],
  ["2001", "Solo Disc Pendant", 190, "necklace", "yellow_gold", "aur-nec-002.png"],
  ["2002", "Whisper Chain", 110, "necklace", "silver", "aur-nec-004.png"],
];

const GENERIC: Array<[string, string, number, string]> = [
  ["t1", "Jasmine Green Tea Gift Box", 24, "Tea"],
  ["t2", "Ceramic Teapot, Celadon", 58, "Teaware"],
  ["t3", "Oolong Sampler (6 tins)", 39, "Tea"],
  ["t4", "Bamboo Tea Tray", 45, "Teaware"],
  ["t5", "Chamomile Bedtime Blend", 16, "Tea"],
];

export function fixtureProducts(kind: FixtureKind, imageBase: string, domain: string): PreviewProduct[] {
  const base = imageBase.replace(/\/$/, "");
  if (kind === "jewelry") {
    return JEWELRY.map(([id, title, price, category, metal, img]) => ({
      id,
      title,
      url: `https://${domain}/products/${id}`,
      images: [`${base}/catalog/aurum/${img}`],
      price,
      currency: "USD",
      categoryText: category === "earring" ? "Earrings" : "Necklaces",
      category,
      metal,
      style: null,
      tags: [],
      summary: `${title}, a fictional test piece.`,
      available: true,
    }));
  }
  return GENERIC.map(([id, title, price, cat], i) => ({
    id,
    title,
    url: `https://${domain}/products/${id}`,
    images: [`${base}/catalog/aurum/aur-brc-00${(i % 5) + 1}.png`],
    price,
    currency: "USD",
    categoryText: cat,
    category: null,
    metal: null,
    style: null,
    tags: [cat.toLowerCase()],
    summary: null,
    available: true,
  }));
}

export interface FixturePreview {
  record: PreviewRecord;
  ownerToken: string;
}

export function fixturePreview(kind: FixtureKind, opts: { imageBase: string; nowMs?: number; state?: PreviewRecord["state"]; key?: string }): FixturePreview {
  const now = opts.nowMs ?? Date.now();
  const ownerToken = newOwnerToken();
  const domain = kind === "jewelry" ? "lumen-jewelry.example" : "teahouse.example";
  const state = opts.state ?? "ready";
  const products = state === "ready" ? fixtureProducts(kind, opts.imageBase, domain) : [];
  return {
    ownerToken,
    record: {
      key: opts.key ?? newPreviewKey(),
      domain,
      storeUrl: `https://${domain}`,
      state,
      reason: state === "refused" ? "not_a_store" : state === "failed" ? "unreachable" : null,
      storeName: kind === "jewelry" ? "Lumen Fine Jewelry" : "Teahouse",
      platform: "shopify",
      currency: "USD",
      products,
      productCount: products.length,
      fetches: 4,
      createdAt: new Date(now),
      updatedAt: new Date(now),
      expiresAt: new Date(now + PREVIEW_TTL_MS),
      ownerTokenHash: hashOwnerToken(ownerToken),
      runner: null,
      settings: { version: 0 },
    },
  };
}

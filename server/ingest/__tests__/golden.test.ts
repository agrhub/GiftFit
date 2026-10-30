/**
 * 20 golden extraction tests (MASTER_PLAN A10 target): each rendered page of the client-rendered Aurum
 * fixture store is extracted and normalised, then compared with the hand labels in
 * fixtures/ingest/aurum-sample/labels.json. Run for both Tier 3 extractors: the deterministic DOM
 * extractor and the Claude extractor fed by recorded responses (synthetic in P2, with deliberate
 * hallucinations that the grounding check must remove).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeExtractor, createRecordedClient } from "@/server/ingest/extract/claude";
import { HeuristicExtractor } from "@/server/ingest/extract/heuristic";
import type { Extractor } from "@/server/ingest/extract/types";
import { normaliseProduct } from "@/server/ingest/normalise";
import { SnapshotRenderer } from "@/server/ingest/render";
import type { IngestedSku } from "@/server/ingest/types";

interface Label {
  title: string;
  price: number | null;
  currency: string | null;
  metal: string | null;
  stone_contains: string | null;
  category: string;
  earring_shape?: string;
  necklace_style?: string;
  necklace_length_in?: number;
  images: number;
}

const ROOT = path.join(process.cwd(), "fixtures", "ingest", "aurum-sample");
const labels = (JSON.parse(readFileSync(path.join(ROOT, "labels.json"), "utf8")) as { pages: Record<string, Label> }).pages;
const slugs = Object.keys(labels);
const renderer = new SnapshotRenderer();
const urlOf = (slug: string) => `https://aurum-fixture.test/products/${slug}`;

const extractors: [string, Extractor][] = [
  ["heuristic DOM extractor", new HeuristicExtractor()],
  ["Claude extractor (recorded)", new ClaudeExtractor(createRecordedClient(path.join(ROOT, "claude")))],
];

async function run(ex: Extractor, slug: string) {
  const page = await renderer.render(urlOf(slug));
  const { product, dropped } = await ex.extract(page);
  const sku = normaliseProduct({ ...product, sourceUrl: page.url, externalId: slug, tier: 3, tags: [] });
  return { sku, dropped };
}

function expectMatchesLabel(sku: IngestedSku, slug: string, l: Label) {
  const a = sku.attributes;
  expect(sku.title).toBe(l.title);
  if (l.price === null) expect(sku.price).toBeNull();
  else expect(sku.price).toBeCloseTo(l.price, 2);
  expect(sku.currency).toBe(l.currency);
  expect(a.metal ?? null).toBe(l.metal);
  if (l.stone_contains === null) expect(a.stone).toBeUndefined();
  else expect(a.stone).toContain(l.stone_contains);
  expect(sku.category).toBe(l.category);
  expect(a.earring_shape).toBe(l.earring_shape);
  expect(a.necklace_style).toBe(l.necklace_style);
  if (l.necklace_length_in === undefined) expect(a.necklace_length_in).toBeUndefined();
  else expect(a.necklace_length_in).toBeCloseTo(l.necklace_length_in, 1);
  expect(sku.images).toHaveLength(l.images);
  for (const img of sku.images) expect(img).toContain(`/images/products/${slug}-`);
}

describe.each(extractors)("golden extraction: %s", (_name, ex) => {
  it("has 20 labelled pages", () => expect(slugs).toHaveLength(20));
  it.each(slugs)("%s", async (slug) => {
    const { sku } = await run(ex, slug);
    expectMatchesLabel(sku, slug, labels[slug]);
  });
});

describe("grounding removes what the page does not support (recorded Claude hallucinations)", () => {
  const claude = extractors[1][1];
  const droppedOf = async (slug: string) => (await run(claude, slug)).dropped;

  it("drops a metal borrowed from a 'you may also like' card", async () => {
    expect(await droppedOf("vela-emerald-pendant")).toContainEqual(expect.objectContaining({ field: "metal", value: "14k Yellow Gold" }));
  });
  it("drops a price and currency taken from a related product when the page says 'Price on request'", async () => {
    const d = await droppedOf("celeste-cluster-studs");
    expect(d).toContainEqual(expect.objectContaining({ field: "price", value: 185 }));
    expect(d).toContainEqual(expect.objectContaining({ field: "currency", value: "USD" }));
  });
  it("drops an image URL that is not on the page", async () => {
    expect(await droppedOf("orbit-watch")).toContainEqual(expect.objectContaining({ field: "images" }));
  });
  it("drops an invented SKU, an invented description and a unit-converted length", async () => {
    expect(await droppedOf("solene-diamond-studs")).toContainEqual(expect.objectContaining({ field: "sku", value: "AU-E-003" }));
    expect(await droppedOf("halo-solitaire-ring")).toContainEqual(expect.objectContaining({ field: "description" }));
    expect(await droppedOf("arden-long-chain")).toContainEqual(expect.objectContaining({ field: "length", value: "32 in" }));
  });
  it("keeps every field of a faithful extraction", async () => {
    expect(await droppedOf("aurora-pearl-drop-earrings")).toEqual([]);
  });
});

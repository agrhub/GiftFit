import { describe, expect, it, vi } from "vitest";
import { EMBEDDING_DIM } from "@/server/db/schema";
import { HashEmbedder, VoyageEmbedder, cosine, createEmbedder, skuEmbeddingText } from "@/server/ingest/embed";
import { InMemoryCatalogIndex, buildPgvectorQuery, toVectorLiteral, type IndexedSku } from "@/server/ingest/retrieve";

const emb = new HashEmbedder();

describe("embedders", () => {
  it("hash embedder is deterministic, unit-length and EMBEDDING_DIM wide", async () => {
    const [a, b] = await emb.embed(["pearl drop earrings", "pearl drop earrings"]);
    expect(a).toHaveLength(EMBEDDING_DIM);
    expect(a).toEqual(b);
    expect(Math.hypot(...a)).toBeCloseTo(1, 6);
    expect(cosine(emb.embedOne("gold pearl earrings"), emb.embedOne("pearl earrings gold"))).toBeGreaterThan(cosine(emb.embedOne("gold pearl earrings"), emb.embedOne("platinum watch")));
  });

  it("uses Voyage only with a key, and checks the returned width", async () => {
    expect(createEmbedder({}).name).toBe("hash");
    expect(createEmbedder({ VOYAGE_API_KEY: "k" }).name).toBe("voyage:voyage-3.5");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: new Array(EMBEDDING_DIM).fill(0.1) }] })));
    const v = new VoyageEmbedder("secret", fetchMock as unknown as typeof fetch);
    expect((await v.embed(["x"], "query"))[0]).toHaveLength(EMBEDDING_DIM);
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toMatchObject({ model: "voyage-3.5", input_type: "query", output_dimension: EMBEDDING_DIM });
    const bad = new VoyageEmbedder("secret", (async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2] }] }))) as unknown as typeof fetch);
    await expect(bad.embed(["x"])).rejects.toThrow(/dims/);
  });

  it("embeds canonical attributes in the SKU text", () => {
    expect(
      skuEmbeddingText({ title: "Luna Small Hoops", category: "earring", attributes: { metal: "silver", metal_tone: "cool", earring_shape: "hoop_small_medium", stone: "none", style: "minimal" } }),
    ).toBe("Luna Small Hoops · earring · silver · cool tone · hoop small medium · minimal");
  });
});

describe("hybrid retrieval", () => {
  const sku = (id: string, text: string, p: Partial<IndexedSku>): IndexedSku => ({
    id,
    storeId: "s1",
    category: "earring",
    price: 100,
    attributes: { metal: "yellow_gold", metal_tone: "warm", vto_spec_ok: true },
    embedding: emb.embedOne(text),
    ...p,
  });
  const idx = new InMemoryCatalogIndex();
  idx.upsert([
    sku("a", "pearl drop earrings yellow gold", {}),
    sku("b", "pearl stud earrings silver", { attributes: { metal: "silver", metal_tone: "cool", vto_spec_ok: true } }),
    sku("c", "pearl pendant necklace", { category: "necklace", price: 300 }),
    sku("d", "gold hoop earrings", { price: 40, attributes: { metal: "yellow_gold", metal_tone: "warm", vto_spec_ok: false } }),
    sku("e", "pearl drop earrings", { storeId: "s2" }),
  ]);

  it("filters on attributes first, then ranks by similarity", () => {
    const q = emb.embedOne("pearl drop earrings");
    const hits = idx.search(q, { storeId: "s1", categories: ["earring"], metalTones: ["warm"] }, 10);
    expect(hits.map((h) => h.id)).toEqual(["a", "d"]);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  it("applies price band, exclusions and try-on readiness; never leaks another store", () => {
    expect(idx.search(null, { storeId: "s1", priceMin: 50, priceMax: 200 }).map((h) => h.id)).toEqual(["a", "b"]);
    expect(idx.search(null, { storeId: "s1", excludeIds: ["a"], vtoReady: true, categories: ["earring"] }).map((h) => h.id)).toEqual(["b"]);
    expect(idx.search(emb.embedOne("pearl drop earrings"), { storeId: "s1" }).map((h) => h.id)).not.toContain("e");
  });

  it("builds the same search as parameterised pgvector SQL", () => {
    const q = buildPgvectorQuery([0.5, -0.25], { storeId: "s1", categories: ["earring"], metalTones: ["warm"], priceMax: 200, excludeIds: ["x"], vtoReady: true }, 6);
    expect(q.text).toBe(
      "SELECT id, 1 - (embedding <=> $6::vector) AS score FROM catalog WHERE store_id = $1 AND category = ANY($2::text[]) AND attributes->>'metal_tone' = ANY($3::text[]) AND price <= $4 AND NOT (id = ANY($5::uuid[])) AND attributes @> '{\"vto_spec_ok\": true}'::jsonb AND embedding IS NOT NULL ORDER BY embedding <=> $6::vector, id LIMIT 6",
    );
    expect(q.params).toEqual(["s1", ["earring"], ["warm"], 200, ["x"], "[0.5,-0.25]"]);
    expect(buildPgvectorQuery(null, {}, 1000).text).toBe("SELECT id, 0 AS score FROM catalog ORDER BY price ASC NULLS LAST, id LIMIT 200");
    expect(toVectorLiteral([NaN, 1])).toBe("[0,1]");
  });
});

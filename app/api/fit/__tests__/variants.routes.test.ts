/**
 * Metal variants through the giver routes (ADR-032), over the single store (MemoryPrivacyRepos).
 * The recipient side (A5) is not built yet, so hearts and wishes are written as PrivacyRepos rows
 * directly, using the reading convention in lib/fit/repository.ts parseHeartRows:
 * a design id, a variant id (`<designId>:<metal>`) or `wish:<designId>`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CreateFitRequestResponse, GiverReportStatus } from "@/lib/contracts/api";
import type { CatalogSku, MetalVariant } from "@/lib/contracts/giftfit";
import { configureFit, resetFitDeps } from "@/lib/fit/deps";
import { PrivacyFitRepository, StaticCatalog, WISH_PREFIX } from "@/lib/fit/repository";
import { carouselSwatches, swatchCap } from "@/lib/fit/variants";
import { fakeRules, makeCatalog, sku } from "@/lib/fit/__tests__/fixtures";
import { findGiverLeaks } from "@/lib/privacy/giver-guard";
import { MemoryPrivacyRepos } from "@/lib/privacy/repos/memory";
import { POST as reportPOST } from "../report/route";
import { POST as requestsPOST } from "../requests/route";

const T0 = new Date("2026-10-20T12:00:00Z");
let repos: MemoryPrivacyRepos;

const variant = (id: string, metal: MetalVariant["metal"], tone: MetalVariant["metal_tone"], price: number): MetalVariant => ({
  variantId: `${id}:${metal}`,
  metal,
  metal_tone: tone,
  price,
  images: [`/catalog/aurum/photo/variants/${id}-${metal}.jpg`],
  vto_image: `/catalog/aurum/photo/variants/${id}-${metal}.jpg`,
  vto_spec_ok: true,
});
const multi = (id: string, title: string, price: number, vs: MetalVariant[]): CatalogSku => ({ ...sku(id, { title, price }), variants: vs });

const HALO = multi("v-halo", "Halo Drop Earrings", 245, [
  variant("v-halo", "yellow_gold", "warm", 245),
  variant("v-halo", "white_gold", "cool", 265),
  variant("v-halo", "rose_gold", "warm", 249),
]);
const CHIME = multi("v-chime", "Chime Bell Drop Earrings", 259, [variant("v-chime", "rose_gold", "warm", 259), variant("v-chime", "yellow_gold", "warm", 259)]);
const SILVER_ONLY = sku("v-silver", { title: "Moon Silver Studs", price: 90, attributes: { metal: "silver", metal_tone: "cool" } });
// Other multi-metal earrings in the same price band, so decoys can match swatch counts.
const M1 = multi("v-m1", "Aria Drop Earrings", 250, [variant("v-m1", "yellow_gold", "warm", 250), variant("v-m1", "white_gold", "cool", 270), variant("v-m1", "rose_gold", "warm", 255)]);
const M2 = multi("v-m2", "Bloom Drop Earrings", 255, [variant("v-m2", "rose_gold", "warm", 255), variant("v-m2", "yellow_gold", "warm", 255)]);
const M3 = multi("v-m3", "Crest Drop Earrings", 262, [variant("v-m3", "yellow_gold", "warm", 262), variant("v-m3", "white_gold", "cool", 280)]);
const CATALOG: CatalogSku[] = [HALO, CHIME, SILVER_ONLY, M1, M2, M3, ...makeCatalog(200, "variant-routes")];

const post = (body: unknown) => new Request("http://localhost/api/fit/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function create(body: Record<string, unknown>) {
  const res = await requestsPOST(post({ occasion: "anniversary", budgetMax: 300, currency: "USD", ...body }));
  return { res, body: (await res.json()) as CreateFitRequestResponse & { error?: string } };
}

async function report(giverToken: string) {
  const res = await reportPOST(post({ giverToken }));
  const text = await res.text();
  return { res, text, body: JSON.parse(text) as GiverReportStatus };
}

async function complete(id: string, heartRows: string[], undertone: { estimate: "warm" | "cool" | "neutral"; confidence: number } = { estimate: "neutral", confidence: 0.2 }) {
  await repos.profiles.upsert({
    fitRequestId: id,
    undertoneEstimate: undertone.estimate,
    undertoneConfidence: undertone.confidence,
    undertoneOverride: null,
    faceShape: "Oval",
    hasHandCapture: false,
    consentAt: T0,
    expiresAt: new Date(T0.getTime() + 72 * 3600_000),
  });
  for (const row of heartRows) await repos.hearts.add(id, row);
  await repos.fitRequests.setStatus(id, "completed");
}

beforeEach(() => {
  resetFitDeps();
  repos = new MemoryPrivacyRepos(() => T0);
  configureFit({
    repository: new PrivacyFitRepository(async () => repos, new StaticCatalog(CATALOG)),
    rules: fakeRules,
    explainer: null,
    decoySecret: "variant-secret",
    now: () => T0,
  });
});
afterEach(() => resetFitDeps());

describe("POST /api/fit/requests with variants", () => {
  it("accepts a cap without budgetMin and stores the metal lock with the request", async () => {
    const { res, body } = await create({ shortlistIds: ["v-halo"], metalLock: ["yellow_gold", "rose_gold"] });
    expect(res.status).toBe(201);
    const row = repos.requests.get(body.fitRequestId)! as unknown as { budgetMin: number | null; metalLock?: string[]; decoyIds: string[] };
    expect(row.budgetMin).toBeNull();
    expect(row.metalLock).toEqual(["yellow_gold", "rose_gold"]);
    // Decoys obey the same lock: every decoy has at least one gold swatch.
    const decoys = CATALOG.filter((s) => row.decoyIds.includes(s.id));
    const req = { budgetMax: 300, currency: "USD", metalLock: ["yellow_gold", "rose_gold"] as const };
    for (const d of decoys) {
      const shown = carouselSwatches([HALO], [d], { ...req, metalLock: [...req.metalLock] }).get(d.id)!;
      expect(shown.length).toBeGreaterThan(0);
      expect(shown.every((v) => v.metal === "yellow_gold" || v.metal === "rose_gold")).toBe(true);
    }
  });

  it("422 no_eligible_variant when a design has no metal under the cap or inside the lock", async () => {
    const overCap = await create({ shortlistIds: ["v-halo"], budgetMax: 200 });
    expect(overCap.res.status).toBe(422);
    expect(overCap.body.error).toBe("no_eligible_variant");
    const locked = await create({ shortlistIds: ["v-halo", "v-silver"], metalLock: ["yellow_gold"] });
    expect(locked.res.status).toBe(422);
    expect(repos.requests.size).toBe(0);
  });

  it("400 for an unknown or duplicated metal in the lock", async () => {
    expect((await create({ shortlistIds: ["v-halo"], metalLock: ["gold"] })).res.status).toBe(400);
    expect((await create({ shortlistIds: ["v-halo"], metalLock: ["silver", "silver"] })).res.status).toBe(400);
    expect((await create({ shortlistIds: ["v-halo"], metalLock: [] })).res.status).toBe(400);
  });
});

describe("POST /api/fit/report with variants", () => {
  it("reports the hearted variant's metal and price; other metals and wishes stay on the shortlist only", async () => {
    const { body: created } = await create({ shortlistIds: ["v-halo", "v-chime", "v-silver"] });
    const row = repos.requests.get(created.fitRequestId)!;
    // Pin the decoys (selection is seeded by a random request id): matching swatch counts 3, 2, 1, so
    // the swatch cap is 3 and every Halo metal was visible to the recipient.
    row.decoyIds = ["v-m1", "v-m2", CATALOG[6].id];
    // Hearted Halo in white gold; wished Chime came in another metal; also hearted and wished on a decoy.
    await complete(row.id, ["v-halo:white_gold", `${WISH_PREFIX}v-chime`, row.decoyIds[0], `${WISH_PREFIX}${row.decoyIds[1]}`]);
    const { res, text, body } = await report(created.giverToken);
    expect(res.status).toBe(200);
    expect(body.status).toBe("completed");
    const halo = body.results!.find((r) => r.skuId === "v-halo")!;
    const chime = body.results!.find((r) => r.skuId === "v-chime")!;
    expect(halo).toMatchObject({ variantId: "v-halo:white_gold", metal: "white_gold", price: 265 });
    expect(halo.breakdown.hearts).toBe(60);
    expect(halo.wishOtherMetal).toBeUndefined();
    expect(chime).toMatchObject({ wishOtherMetal: true });
    expect(chime.breakdown.hearts).toBe(30); // 0.5 × 60
    expect(body.heartedShortlistIds).toEqual(["v-halo"]);
    expect(body.otherMetalWishes).toEqual(["v-chime"]);
    // Decoy hearts and wishes are never revealed; no images or face data.
    for (const id of row.decoyIds) expect(text).not.toContain(id);
    expect(text).not.toMatch(/\.jpg|\.png|https?:|#[0-9a-f]{6}|hueDeg|undertoneConfidence|0\.2\b/i);
    expect(findGiverLeaks(body)).toEqual([]);
  });

  it("a heart can only be on a visible swatch: with single-swatch decoys every design shows one metal", async () => {
    const { body: created } = await create({ shortlistIds: ["v-halo", "v-chime"] });
    const row = repos.requests.get(created.fitRequestId)!;
    row.decoyIds = CATALOG.slice(6, 10).map((s) => s.id); // all single-variant → swatch cap 1
    await complete(row.id, ["v-halo:yellow_gold"]);
    const { body } = await report(created.giverToken);
    const halo = body.results!.find((r) => r.skuId === "v-halo")!;
    expect(halo).toMatchObject({ variantId: "v-halo:yellow_gold", metal: "yellow_gold", price: 245 });
    const chime = body.results!.find((r) => r.skuId === "v-chime")!;
    expect(chime.metal).toBe("rose_gold"); // its only visible swatch (listing order)
  });

  it("without hearts it reports the best-scoring visible variant, never one outside the cap", async () => {
    const { body: created } = await create({ shortlistIds: ["v-halo", "v-chime"], budgetMax: 260 });
    await complete(created.fitRequestId, [], { estimate: "cool", confidence: 1 });
    const { body } = await report(created.giverToken);
    const halo = body.results!.find((r) => r.skuId === "v-halo")!;
    // White gold ($265) is over the $260 cap, so a cool estimate still gets a gold variant.
    expect(halo.metal).not.toBe("white_gold");
    expect(halo.price).toBeLessThanOrEqual(260);
    expect(body.otherMetalWishes).toBeUndefined();
  });

  it("a hearted design with no variant recorded (legacy row) still reports a variant", async () => {
    const { body: created } = await create({ shortlistIds: ["v-halo"] });
    await complete(created.fitRequestId, ["v-halo"]);
    const { body } = await report(created.giverToken);
    expect(body.results![0]).toMatchObject({ skuId: "v-halo", variantId: expect.stringMatching(/^v-halo:/) });
    expect(body.results![0].breakdown.hearts).toBe(60);
    expect(body.heartedShortlistIds).toEqual(["v-halo"]);
  });
});

describe("swatch leveling assumption for the recipient side (A5)", () => {
  it("caps swatches so the most-metals design is not only a shortlist item", () => {
    const req = { budgetMax: 300, currency: "USD" };
    const singles = CATALOG.slice(6, 9);
    expect(swatchCap([HALO], singles, req)).toBe(1); // no multi-metal decoy → everyone shows one swatch
    expect(swatchCap([HALO, singles[0], singles[1]], [CHIME, singles[2], CATALOG[7]], req)).toBe(2); // Halo shows 2, like Chime
    expect(carouselSwatches([HALO], [CHIME], req).get("v-halo")!.map((v) => v.metal)).toEqual(["yellow_gold", "white_gold"]);
  });
});

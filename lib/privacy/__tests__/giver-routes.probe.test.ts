/**
 * Dynamic proof for the giver routes that exist today (A3's app/api/fit/*): call each route
 * handler for a recipient with a full profile, with an adversarial explainer that tries to
 * smuggle a hex value, a blob URL and face data into the reasons, and run every response
 * through findGiverLeaks. If A3 changes a route's request shape, update the probe here.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { CatalogSku, JewelryRules, RuleScore } from "@/lib/contracts/giftfit";
import { configureFit, resetFitDeps } from "@/lib/fit/deps";
import { InMemoryFitRepository } from "@/lib/fit/repository";
import { POST as decoysPOST } from "@/app/api/fit/decoys/route";
import { POST as reportPOST } from "@/app/api/fit/report/route";
import { GET as weightsGET } from "@/app/api/fit/weights/route";
import { findGiverLeaks } from "../giver-guard";
import { ROUTE_MANIFEST } from "../route-manifest";

const rule: RuleScore = { strength: "recommended", weight: 1, sources: ["probe-1", "probe-2"], singleSource: false };
const rules: JewelryRules = {
  estimateUndertone: () => ({ undertone: "warm", confidence: 0.9, lab: { L: 61, a: 14, b: 21 }, hueDeg: 56 }),
  metalFit: () => rule,
  styleFit: () => rule,
};

function sku(id: string, price: number): CatalogSku {
  return {
    id,
    storeId: "aurum",
    title: `Probe ${id}`,
    category: "earring",
    price,
    currency: "USD",
    images: [`/catalog/${id}.png`],
    attributes: {
      category: "earring",
      metal: "yellow_gold",
      metal_tone: "warm",
      style: "classic",
      earring_shape: "drop_teardrop",
      occasions: ["anniversary"],
      vto_spec_ok: true,
      vto_image: `/catalog/${id}.png`,
    },
  };
}

const GIVER_TOKEN = "giver-token-probe-0123456789abcdef";
const skus = ["e1", "e2", "e3", "e4", "e5", "e6"].map((id, i) => sku(id, 180 + i * 5));

/** An explainer that tries to leak recipient data through the reasons. */
const leakyExplainer = {
  model: "probe",
  async explain(req: { items: Array<{ skuId: string }> }) {
    return {
      items: req.items.map((i) => ({
        skuId: i.skuId,
        reason1: "Matches their skin #c68e6b perfectly",
        reason2: "See https://x.private.blob.vercel-storage.com/tryon/1.png",
        caution: "faceAspectRatio 1.42 and L* 61",
      })),
    };
  },
};

afterEach(() => resetFitDeps());

function configure() {
  const repository = new InMemoryFitRepository({
    skus,
    requests: [
      {
        giverToken: GIVER_TOKEN,
        request: {
          id: "req-probe",
          storeId: "aurum",
          input: { occasion: "anniversary", budgetMin: 150, budgetMax: 300, currency: "USD", shortlistIds: ["e1", "e2"] },
          decoyIds: ["e3", "e4"],
          status: "completed",
          expiresAt: new Date(Date.now() + 3600_000),
          profile: { undertoneEstimate: "warm", undertoneConfidence: 0.9, undertoneOverride: "cool", faceShape: "Oval", heartedSkuIds: ["e1", "e3"] },
        },
      },
    ],
  });
  configureFit({ repository, rules, explainer: leakyExplainer as never, decoySecret: "probe-secret", now: () => new Date() });
}

describe("giver routes leak nothing (dynamic probe)", () => {
  it("probes every giver route in the manifest", () => {
    const giver = Object.entries(ROUTE_MANIFEST).filter(([, e]) => e.audience === "giver").map(([f]) => f).sort();
    // POST /api/fit/requests (A3, ADR-021) is covered by the static scan; its response holds only
    // giver-supplied data and links. The other three are probed below.
    // POST /api/demo/seed (A5) is probed in app/api/demo/__tests__/seed.test.ts.
    // POST /api/concierge (A7) is probed in app/api/concierge/__tests__/route.test.ts (every NDJSON event).
    // POST /api/widget/send-card and /api/widget/notify (A6) are probed in app/api/widget/__tests__/routes.test.ts.
    const elsewhere = ["app/api/demo/seed/route.ts", "app/api/concierge/route.ts", "app/api/widget/send-card/route.ts", "app/api/widget/notify/route.ts"];
    expect(giver.filter((f) => !elsewhere.includes(f))).toEqual(["app/api/fit/decoys/route.ts", "app/api/fit/report/route.ts", "app/api/fit/requests/route.ts", "app/api/fit/weights/route.ts"]);
  });

  it("POST /api/fit/report", async () => {
    configure();
    const res = await reportPOST(new Request("http://x/api/fit/report", { method: "POST", headers: { "x-giver-token": GIVER_TOKEN } }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(findGiverLeaks(body)).toEqual([]);
    expect(JSON.stringify(body)).not.toMatch(/c68e6b|blob\.vercel|faceAspectRatio|L\*/);
  });

  it("POST /api/fit/decoys", async () => {
    configure();
    const res = await decoysPOST(new Request("http://x/api/fit/decoys", { method: "POST", body: JSON.stringify({ shortlistIds: ["e1", "e2"] }) }));
    expect(res.status).toBe(200);
    expect(findGiverLeaks(await res.json())).toEqual([]);
  });

  it("GET /api/fit/weights", async () => {
    const res = await weightsGET();
    expect(findGiverLeaks(await res.json())).toEqual([]);
  });

  it("error responses leak nothing either", async () => {
    configure();
    for (const init of [{ headers: { "x-giver-token": "unknown-token-0123456789" } }, { body: "{" }]) {
      const res = await reportPOST(new Request("http://x/api/fit/report", { method: "POST", ...init }));
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(findGiverLeaks(await res.json())).toEqual([]);
    }
  });
});

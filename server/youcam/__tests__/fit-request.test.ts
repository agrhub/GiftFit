import path from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryAuditSink } from "../audit";
import { YoucamClient } from "../client";
import type { YoucamConfig } from "../config";
import { analyzeRecipient, fitRequestPlan, runTryOns, type TryOnItem } from "../fit-request";
import { FakeYoucamApi, json } from "./fake-api";

const FIXTURES = path.join(process.cwd(), "fixtures", "youcam");
const face = { bytes: new Uint8Array([0xff, 0xd8, 0xff, 9]), contentType: "image/jpeg" as const };
const hand = { bytes: new Uint8Array([0xff, 0xd8, 0xff, 7]), contentType: "image/jpeg" as const };
const product = { url: "https://shop.test/p.png" };

const mock = () => new YoucamClient({ config: { mock: true, fixturesDir: FIXTURES }, audit: new MemoryAuditSink(), cache: null });
const real = (api: FakeYoucamApi, cfg: Partial<YoucamConfig> = {}) =>
  new YoucamClient({
    config: { mock: false, allowPaid: true, apiKey: "k", baseUrl: "https://api.test", reserveUnits: 300, maxUnitsPerRun: 40, pollIntervalMs: 1, maxPolls: 3, ...cfg },
    fetch: api.fetch,
    sleep: async () => {},
    audit: new MemoryAuditSink(),
    cache: null,
    limiter: null,
    state: "isolated",
    retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1 },
  });

const items: TryOnItem[] = [
  { id: "e1", kind: "earring", product },
  { id: "n1", kind: "necklace", product },
  { id: "r1", kind: "ring", product: [product, product] },
];

describe("analyzeRecipient", () => {
  it("returns raw hex colors and face shape, no undertone (mock: 30 units expected)", async () => {
    const r = await analyzeRecipient(mock(), face);
    expect(r.colors.skin_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(r.faceShape).toBe("Oval");
    expect(r.units).toEqual({ expected: 30, charged: 0 });
    expect(r.source).toEqual({ mock: true, synthetic: true });
    expect(r).not.toHaveProperty("undertone");
    expect(JSON.stringify(r)).not.toMatch(/undertone/i);
  });

  it("sends strictness high and exactly the 5 GiftFit features (real, fake API)", async () => {
    const api = new FakeYoucamApi({
      runningPolls: 0,
      results: { "skin-tone-analysis": { color: { skin_color: "#aa8877" } }, "face-attr-analysis": { faceshape: "Round", face_quality: { has_face: true } } },
    });
    const c = real(api);
    const r = await analyzeRecipient(c, face, { faceAngleStrictness: "medium" });
    expect(api.callsTo("POST", /task\/skin-tone-analysis$/)[0].body).toMatchObject({ face_angle_strictness_level: "medium" });
    expect(api.callsTo("POST", /task\/face-attr-analysis$/)[0].body).toMatchObject({
      features: ["faceShape", "faceAspectRatio", "cheekbones", "eyeDistance", "noseWidth"],
    });
    expect(r).toMatchObject({ faceShape: "Round", faceQuality: { has_face: true }, units: { expected: 30, charged: 30 }, source: { mock: false } });
  });
});

describe("runTryOns", () => {
  it("routes hand jewelry to the hand photo and skips it without one", async () => {
    const withHand = await runTryOns(mock(), { face, hand }, items, { concurrency: 2 });
    expect(withHand.map((t) => t.ok)).toEqual([true, true, true]);
    expect(withHand[2]).toMatchObject({ kind: "ring", ok: true, url: expect.stringContaining("mock-hand-vto") });
    const noHand = await runTryOns(mock(), { face }, items);
    expect(noHand[2]).toEqual({ id: "r1", kind: "ring", ok: false, error: expect.any(String), code: "hand_photo_required" });
    expect(await runTryOns(mock(), { face }, [])).toEqual([]);
  });

  it("reports per-item failures with their codes and keeps the rest", async () => {
    const api = new FakeYoucamApi({ runningPolls: 0 });
    const c = real(api);
    api.override = (call) => {
      if (call.method === "POST" && call.url.endsWith("/2d-vto/earring")) return json({ error: "bad body", error_code: "InvalidParameters" }, 400);
      if (call.method === "POST" && call.url.endsWith("/2d-vto/necklace")) return json({ error: "boom" }, 500);
      if (call.method === "GET" && /2d-vto\/ring\//.test(call.url)) {
        return json({ data: { task_status: "error", error: "PHOTO_DETECTION_FAIL", error_message: "no hand" } });
      }
      return undefined;
    };
    const r = await runTryOns(c, { face, hand }, [...items, { id: "w1", kind: "watch", product }], { jewelryBodyVariant: "B" });
    expect(r[0]).toMatchObject({ ok: false, code: "InvalidParameters" });
    expect(r[1]).toMatchObject({ ok: false, code: "500" });
    expect(r[2]).toMatchObject({ ok: false, code: "PHOTO_DETECTION_FAIL" });
    expect(r[3]).toMatchObject({ ok: true, unitsCharged: 1 });
    expect(api.callsTo("POST", /2d-vto\/watch$/)[0].body).not.toHaveProperty("src_file_id");
    expect(c.guard.unitsCharged).toBe(1);
  });

  it("maps guard refusals and timeouts, and rethrows unexpected errors", async () => {
    const poor = new FakeYoucamApi({ balance: 40 });
    const [refused] = await runTryOns(real(poor), { face }, [items[0]]);
    expect(refused).toMatchObject({ ok: false, code: "reserve_floor" });
    const slow = new FakeYoucamApi({ runningPolls: 99 });
    const [timeout] = await runTryOns(real(slow), { face }, [items[0]]);
    expect(timeout).toMatchObject({ ok: false, code: "timeout" });
    const broken = mock();
    broken.jewelryVto = async () => {
      throw new TypeError("bug");
    };
    await expect(runTryOns(broken, { face }, [items[0]])).rejects.toThrow("bug");
  });
});

describe("fitRequestPlan", () => {
  it("prices one Fit Request: 30 + 1 per single item (+2 stacked)", () => {
    const c = mock();
    const plan = fitRequestPlan(items);
    expect(plan.map((p) => p.feature)).toEqual(["skin-tone-analysis", "face-attr-analysis", "2d-vto/earring", "2d-vto/necklace", "2d-vto/ring"]);
    expect(plan.reduce((s, p) => s + (c.estimateUnits(p.feature, p.params as never) ?? 0), 0)).toBe(34);
    const six = fitRequestPlan(Array.from({ length: 6 }, (_, i) => ({ kind: i % 2 ? "earring" : "necklace", product }) as const));
    expect(six.reduce((s, p) => s + (c.estimateUnits(p.feature, p.params as never) ?? 0), 0)).toBe(36);
  });
});

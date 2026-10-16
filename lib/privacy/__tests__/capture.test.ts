import { describe, expect, it, vi } from "vitest";
import type { JewelryRules } from "@/lib/contracts/giftfit";
import { MemoryAuditSink } from "@/lib/youcam/audit";
import { MemoryResultCache } from "@/lib/youcam/cache";
import { createYoucamClient } from "@/lib/youcam/client";
import { runCapture, youcamCapturePorts, type CapturePorts } from "../capture";
import { deleteEverything } from "../delete-everything";
import { verifyTryOnSignature } from "../signed-url";
import { newFitRequestTokens } from "../tokens";
import { hex64, makeStack, type TestStack } from "./helpers";

const rules: Pick<JewelryRules, "estimateUndertone"> = {
  estimateUndertone: () => ({ undertone: "warm", confidence: 0.8, lab: { L: 60, a: 12, b: 20 }, hueDeg: 59 }),
};
const SELFIE = { bytes: new Uint8Array([0xff, 0xd8, 1, 2, 3]), contentType: "image/jpeg" as const };
const HAND = { bytes: new Uint8Array([0xff, 0xd8, 4, 5, 6]), contentType: "image/jpeg" as const };

async function newRequest(stack: TestStack) {
  const t = newFitRequestTokens();
  const request = await stack.repos.fitRequests.create({
    storeId: null,
    giverTokenHash: t.giverTokenHash,
    recipientTokenHash: t.recipientTokenHash,
    occasion: "birthday",
    budgetMin: 100,
    budgetMax: 200,
    currency: "USD",
    shortlistIds: ["e1"],
    decoyIds: ["e2", "n1"],
  });
  return { request, token: t.recipientToken };
}

function fakePorts(overrides: Partial<CapturePorts> = {}): CapturePorts {
  let n = 0;
  return {
    analyze: async () => ({
      colors: { skin_color: "#c68e6b", lip_color: "#a0524d" },
      faceShape: "Oval",
      tasks: [
        { feature: "skin-tone-analysis", taskId: "task_tones", cacheKey: hex64("1"), unitsCharged: 20 },
        { feature: "face-attr-analysis", taskId: "task_attrs", cacheKey: hex64("2"), unitsCharged: 10 },
      ],
    }),
    render: async (kind, _src, catalogId) => {
      n++;
      return { catalogId, kind, ok: true, url: `https://yce.example/result/${n}.png`, feature: `2d-vto/${kind}`, taskId: `task_vto_${n}`, cacheKey: hex64(String(n + 2)), unitsCharged: 1 };
    },
    fetchImage: async () => ({ bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), contentType: "image/png" }),
    ...overrides,
  };
}

const items = [
  { catalogId: "e1", kind: "earring" as const, productImage: "/catalog/e1.png" },
  { catalogId: "n1", kind: "necklace" as const, productImage: "/catalog/n1.png" },
  { catalogId: "r1", kind: "ring" as const, productImage: "/catalog/r1.png" },
];

describe("runCapture photo lifecycle", () => {
  it("deletes the input photos right after rendering and keeps only signed, session-bound renders", async () => {
    const stack = makeStack();
    const { request, token } = await newRequest(stack);
    const put = vi.spyOn(stack.photos, "put");
    const view = await runCapture(stack.deps, fakePorts(), { request, sessionToken: token, selfie: SELFIE, items, rules, consentAt: stack.deps.now() });

    // Input photos were stored with a TTL <= 1 h, then deleted.
    const inputs = put.mock.calls.filter((c) => c[0].kind === "selfie" || c[0].kind === "hand");
    expect(inputs).toHaveLength(1);
    const keys = stack.photos.keys();
    expect(keys.every((k) => k.startsWith(`tryon/${request.id}/`))).toBe(true);
    expect(keys).toHaveLength(2);
    expect(view.photosDeleted).toBe(true);

    // Profile holds estimates only.
    const profile = await stack.repos.profiles.get(request.id);
    expect(profile).toMatchObject({ undertoneEstimate: "warm", undertoneConfidence: 0.8, faceShape: "Oval", hasHandCapture: false });
    expect(JSON.stringify(profile)).not.toMatch(/#[0-9a-f]{6}/i);

    // Every YouCam task is recorded for later deletion; renders reference the store only.
    const rows = await stack.repos.tryons.listForRequest(request.id);
    expect(rows.map((r) => r.taskId).sort()).toEqual(["task_attrs", "task_tones", "task_vto_1", "task_vto_2"]);
    for (const r of rows.filter((r) => r.feature.startsWith("2d-vto/"))) expect(r.resultRef).toMatch(/^store:tryon\//);

    // The recipient sees their hex once (not stored) and signed URLs bound to their token.
    expect(view.skinHex).toBe("#c68e6b");
    const ok = view.tryOns.filter((t) => t.ok);
    expect(ok).toHaveLength(2);
    expect(view.tryOns.find((t) => t.catalogId === "r1")).toEqual({ catalogId: "r1", kind: "ring", ok: false, code: "hand_photo_required" });
    for (const t of ok) {
      if (!t.ok) continue;
      const u = new URL(t.imageUrl, "http://x");
      const args = { tryOnId: t.tryOnId, exp: u.searchParams.get("exp"), sig: u.searchParams.get("sig"), secret: stack.deps.signingSecret, nowMs: stack.deps.now().getTime() };
      expect(verifyTryOnSignature({ ...args, sessionToken: token }).ok).toBe(true);
      expect(verifyTryOnSignature({ ...args, sessionToken: "someone-else-token-xxxxxxxx" }).ok).toBe(false);
    }
    expect((await stack.repos.fitRequests.findById(request.id))?.status).toBe("tried_on");
  });

  it("uses the hand photo for hand jewelry and still deletes both photos", async () => {
    const stack = makeStack();
    const { request, token } = await newRequest(stack);
    const view = await runCapture(stack.deps, fakePorts(), { request, sessionToken: token, selfie: SELFIE, hand: HAND, items, rules, consentAt: stack.deps.now() });
    expect(view.tryOns.filter((t) => t.ok)).toHaveLength(3);
    expect(stack.photos.keys().some((k) => k.startsWith("recipient/"))).toBe(false);
    expect((await stack.repos.profiles.get(request.id))?.hasHandCapture).toBe(true);
  });

  it("deletes the input photos even when analysis fails", async () => {
    const stack = makeStack();
    const { request, token } = await newRequest(stack);
    const ports = fakePorts({ analyze: async () => Promise.reject(new Error("face not found")) });
    await expect(runCapture(stack.deps, ports, { request, sessionToken: token, selfie: SELFIE, hand: HAND, items, rules, consentAt: stack.deps.now() })).rejects.toThrow(/face not found/);
    expect(stack.photos.keys()).toEqual([]);
  });

  it("shows a failed render as unavailable but still records its task for deletion", async () => {
    const stack = makeStack();
    const { request, token } = await newRequest(stack);
    const ports = fakePorts({ fetchImage: async () => Promise.reject(new Error("410")) });
    const view = await runCapture(stack.deps, ports, { request, sessionToken: token, selfie: SELFIE, items: items.slice(0, 1), rules, consentAt: stack.deps.now() });
    expect(view.tryOns).toEqual([{ catalogId: "e1", kind: "earring", ok: false, code: "render_unavailable" }]);
    expect((await stack.repos.tryons.listForRequest(request.id)).map((r) => r.taskId)).toContain("task_vto_1");
  });

  it("keepInputs keeps the photo for swatches, but dropInputs (Delete my photo now) wins in finally", async () => {
    const stack = makeStack();
    const { request, token } = await newRequest(stack);
    const base = { request, sessionToken: token, selfie: SELFIE, items: items.slice(0, 1), rules, consentAt: stack.deps.now(), keepInputs: { selfie: true } };
    const kept = await runCapture(stack.deps, fakePorts(), base);
    expect(kept.photosDeleted).toBe(false);
    expect(stack.photos.keys().filter((k) => k.startsWith("recipient/"))).toHaveLength(1);
    // The photo is re-stored by the next capture; a delete request that lands mid-capture still wins.
    await runCapture(stack.deps, fakePorts(), { ...base, dropInputs: async () => true });
    expect(stack.photos.keys().filter((k) => k.startsWith("recipient/"))).toEqual([]);
    // A failing check fails closed (drops).
    await runCapture(stack.deps, fakePorts(), { ...base, dropInputs: async () => Promise.reject(new Error("db down")) });
    expect(stack.photos.keys().filter((k) => k.startsWith("recipient/"))).toEqual([]);
  });

  it("keeps the recipient's earlier override when re-capturing", async () => {
    const stack = makeStack();
    const { request, token } = await newRequest(stack);
    await runCapture(stack.deps, fakePorts(), { request, sessionToken: token, selfie: SELFIE, items: [], rules, consentAt: stack.deps.now() });
    await stack.repos.profiles.setOverride(request.id, "cool");
    await runCapture(stack.deps, fakePorts(), { request, sessionToken: token, selfie: SELFIE, items: [], rules, consentAt: stack.deps.now() });
    expect((await stack.repos.profiles.get(request.id))?.undertoneOverride).toBe("cool");
  });
});

describe("youcamCapturePorts over the lib/youcam mock client", () => {
  it("records real cache keys and task ids, and deleteEverything then empties the client's cache", async () => {
    const cache = new MemoryResultCache();
    const client = createYoucamClient({ config: { mock: true, allowPaid: false }, cache, audit: new MemoryAuditSink(), limiter: null });
    const fetchSpy = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }));
    const ports = youcamCapturePorts(client, { fetch: fetchSpy as unknown as typeof fetch, baseUrl: "http://localhost:3000" });
    const stack = makeStack();
    stack.deps.youcam = { deleteTask: (id) => client.deleteTask(id), deleteCachedResult: (k) => cache.delete(k) };
    const { request, token } = await newRequest(stack);

    const view = await runCapture(stack.deps, ports, { request, sessionToken: token, selfie: SELFIE, items: items.slice(0, 2), rules, consentAt: stack.deps.now() });
    expect(view.tryOns.filter((t) => t.ok)).toHaveLength(2);
    expect(String((fetchSpy.mock.calls[0] as unknown[])[0])).toMatch(/^http:\/\/localhost:3000\/api\/youcam\/mock-asset\//);
    const rows = await stack.repos.tryons.listForRequest(request.id);
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => /^[a-f0-9]{64}$/.test(r.cacheKey) && r.taskId?.startsWith("mock_"))).toBe(true);
    // Mock mode does not write the cache; real mode writes one entry per key (client.ts). Simulate that.
    for (const r of rows) await cache.set(r.cacheKey, { feature: r.feature, taskId: r.taskId!, result: { color: { skin_color: "#c68e6b" } }, unitsCharged: 0, createdAt: "x" });

    const receipt = await deleteEverything(stack.deps, request.id);
    expect(receipt.verified).toBe(true);
    for (const r of rows) expect(await cache.get(r.cacheKey), r.feature).toBeUndefined();
    expect(stack.photos.keys()).toEqual([]);
  });
});

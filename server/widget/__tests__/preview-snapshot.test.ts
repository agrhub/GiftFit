import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FirestorePreviewRepo, MemoryPreviewRepo } from "@/server/preview/repo";
import { FirestorePrivacyRepos } from "@/server/privacy/repos/firestore";
import { newFitRequestTokens } from "@/server/privacy/tokens";
import { FakeFirestore } from "@/server/store/__tests__/fake-firestore";
import { previewStoreView } from "../preview";
import { fixturePreview } from "../preview-fixtures";
import { extendedPreviewExpiry, extendPreviewForRequest, isPreviewGone, PREVIEW_MAX_LIFETIME_MS, previewSnapshot } from "../preview-snapshot";

const H = 3_600_000;
const T0 = Date.parse("2026-10-27T08:00:00Z");
// Freeze Date at T0: some reads use the wall clock, and T0 + 72 h is already in the past.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());
const at = (h: number) => new Date(T0 + h * H);

describe("preview lifetime extension", () => {
  it("max(current, min(request expiry, createdAt + 72 h)); never shorter", () => {
    expect(extendedPreviewExpiry(at(24), at(0), at(2 + 72))).toEqual(at(72)); // capped
    expect(extendedPreviewExpiry(at(24), at(0), at(30))).toEqual(at(30)); // extended
    expect(extendedPreviewExpiry(at(24), at(0), at(10))).toEqual(at(24)); // never shortened
    expect(extendedPreviewExpiry(at(72), at(0), at(100))).toEqual(at(72));
    expect(PREVIEW_MAX_LIFETIME_MS).toBe(72 * H);
  });

  it.each([
    ["memory", () => new MemoryPreviewRepo()],
    ["firestore", () => {
      const db = new FakeFirestore();
      return new FirestorePreviewRepo(async () => db);
    }],
  ])("%s: several requests extend up to the cap; unknown and non-preview stores are ignored", async (_n, make) => {
    const repo = make();
    const f = fixturePreview("jewelry", { imageBase: "https://giftfit.example", nowMs: T0 });
    await repo.create(f.record);
    const store = `preview:${f.record.key}`;
    // First request 1 h after the preview: its link expires at 73 h → capped at 72 h.
    expect(await extendPreviewForRequest(store, at(1 + 72), repo, T0 + H)).toEqual(at(72));
    // A later, earlier-expiring request never shortens it.
    expect(await extendPreviewForRequest(store, at(30), repo, T0 + 2 * H)).toEqual(at(72));
    expect((await repo.get(f.record.key, T0 + 71 * H))?.expiresAt).toEqual(at(72));
    // Still gone after the cap (reads treat expiresAt as the TTL).
    expect(await repo.get(f.record.key, T0 + 72 * H + 1)).toBeNull();
    expect(await extendPreviewForRequest("aurum", at(10), repo, T0)).toBeNull();
    expect(await extendPreviewForRequest(`preview:${"Z".repeat(22)}`, at(10), repo, T0)).toBeNull();
  });
});

describe("product snapshot", () => {
  afterEach(() => undefined);
  it("freezes name, price, currency, first https image and merchant URL of every giftable piece", async () => {
    const repo = new MemoryPreviewRepo();
    const f = fixturePreview("jewelry", { imageBase: "https://giftfit.example" });
    f.record.products[0].images = ["http://insecure.example/a.jpg", "https://cdn.example/a.jpg"];
    await repo.create(f.record);
    const snap = (await previewSnapshot(`preview:${f.record.key}`, repo))!;
    const view = previewStoreView(f.record);
    expect(snap).toHaveLength(view.skus.length);
    expect(snap[0]).toEqual({ catalogId: view.skus[0].id, title: "Aria Gold Hoops", price: 180, currency: "USD", image: "https://cdn.example/a.jpg", url: "https://lumen-jewelry.example/products/1001" });
    expect(await previewSnapshot("aurum", repo)).toBeUndefined();
    expect(await isPreviewGone(`preview:${f.record.key}`, repo)).toBe(false);
    await repo.delete(f.record.key);
    expect(await isPreviewGone(`preview:${f.record.key}`, repo)).toBe(true);
    expect(await isPreviewGone("aurum", repo)).toBe(false);
  });

  it("Firestore keeps the snapshot on the fit request", async () => {
    const repos = new FirestorePrivacyRepos(new FakeFirestore());
    const t = newFitRequestTokens();
    const productSnapshot = [{ catalogId: "k~pv-0-1", title: "Aria", price: 180, currency: "USD", image: "https://cdn.example/a.jpg", url: "https://shop.example/p/1" }];
    const rec = await repos.fitRequests.create({ storeId: "preview:x", giverTokenHash: t.giverTokenHash, recipientTokenHash: t.recipientTokenHash, occasion: "birthday", budgetMin: null, budgetMax: 300, currency: "USD", shortlistIds: ["k~pv-0-1"], decoyIds: [], productSnapshot });
    expect((await repos.fitRequests.findById(rec.id))?.productSnapshot).toEqual(productSnapshot);
  });
});

describe("giver guard: exact merchant image URLs only", () => {
  it("allows a listed URL under a product-image key, nothing else", async () => {
    const { findGiverLeaks } = await import("@/server/privacy/giver-guard");
    const ok = "https://cdn.shop.example/a.jpg";
    expect(findGiverLeaks({ products: [{ image: ok }] }, { allowedImageUrls: [ok] })).toEqual([]);
    expect(findGiverLeaks({ products: [{ image: "https://cdn.shop.example/b.jpg" }] }, { allowedImageUrls: [ok] })).toHaveLength(1);
    expect(findGiverLeaks({ reasons: [ok] }, { allowedImageUrls: [ok] })).toHaveLength(1);
    const tryon = "https://giftfit.example/api/recipient/tryon/1.jpg";
    expect(findGiverLeaks({ products: [{ image: tryon }] }, { allowedImageUrls: [tryon] })).toHaveLength(1);
  });
});

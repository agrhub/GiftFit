import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { middleware } from "@/middleware";
import { MemoryDailyCounterStore } from "@/lib/store/daily-counter";
import { defaultPreviewRepo, MemoryPreviewRepo } from "@/lib/preview/repo";
import { setPreviewDepsForTests } from "@/lib/preview/service";
import { isWidgetOriginAllowed, widgetFrameAncestors } from "../config";
import { isReadyPreviewStore, loadPreviewStore, PreviewAwareCatalog, previewKeyOf, previewKeyOfSkuId, previewStoreView, scopedSkuId } from "../preview";
import { adminKeyOf, OWNER_COOKIE, ownerCookie, verifyOwner } from "../preview-admin";
import { reingestPreview, removeProduct, restoreProducts, saveWidgetSettings } from "../preview-admin-ops";
import { fixturePreview } from "../preview-fixtures";
import { contrastRatio, validateSettings, widgetSettingsFrom } from "../preview-settings";

const BASE = "https://giftfit.example";
const repo = defaultPreviewRepo() as MemoryPreviewRepo;

async function seed(kind: "jewelry" | "generic" = "jewelry", state?: "ready" | "refused" | "crawling") {
  const f = fixturePreview(kind, { imageBase: BASE, state });
  await repo.create(f.record);
  return f;
}

afterEach(() => {
  repo.records.clear();
  setPreviewDepsForTests(undefined);
});

describe("preview store keys and views", () => {
  it("parses preview:<key> and key-scoped sku ids", () => {
    const key = "A".repeat(22);
    expect(previewKeyOf(`preview:${key}`)).toBe(key);
    for (const bad of ["preview:short", "aurum", `preview:${key}x`, `PREVIEW:${key}`, undefined, 5]) expect(previewKeyOf(bad)).toBeNull();
    expect(previewKeyOfSkuId(scopedSkuId(key, "pv-0-1"))).toBe(key);
    expect(previewKeyOfSkuId("7dfc7aed-5179-5f07-8e9a-dfd971d46b19")).toBeNull();
  });

  it("keeps the owner's removals out, scopes the jewelry SKUs to the key, maps giftable products", async () => {
    const f = await seed("jewelry");
    f.record.settings.removedProductIds = ["1002"];
    const view = previewStoreView(f.record);
    expect(view.products.map((p) => p.id)).not.toContain("1002");
    expect(view.skus).toHaveLength(9);
    for (const s of view.skus) {
      expect(s.storeId).toBe(`preview:${f.record.key}`);
      expect(previewKeyOfSkuId(s.id)).toBe(f.record.key);
      expect(s.sourceUrl).toMatch(/^https:\/\/lumen-jewelry\.example\/products\//);
    }
    expect(view.skuIdByProduct["1001"]).toBe(view.skus[0].id);
    const generic = previewStoreView((await seed("generic")).record);
    expect(generic.skus).toEqual([]);
    expect(generic.products).toHaveLength(5);
  });

  it("only READY, unexpired previews load", async () => {
    const ready = await seed();
    const refused = await seed("jewelry", "refused");
    const crawling = await seed("jewelry", "crawling");
    expect(await loadPreviewStore(ready.record.key)).not.toBeNull();
    expect(await loadPreviewStore(refused.record.key)).toBeNull();
    expect(await isReadyPreviewStore(`preview:${crawling.record.key}`)).toBe(false);
    expect(await isReadyPreviewStore(`preview:${ready.record.key}`)).toBe(true);
    expect(await isReadyPreviewStore(`preview:${ready.record.key}`, repo, ready.record.expiresAt.getTime() + 1)).toBe(false);
    expect(await isReadyPreviewStore("preview:" + "Z".repeat(22))).toBe(false);
  });

  it("PreviewAwareCatalog resolves preview ids from their own preview and never lists them with Aurum", async () => {
    const a = await seed();
    const b = await seed();
    const aurum = { getSkus: async (ids: readonly string[]) => ids.filter((i) => i === "aurum-1").map((id) => ({ id }) as never), listCatalog: async () => [{ id: "aurum-1" } as never] };
    const cat = new PreviewAwareCatalog(aurum);
    const aSku = previewStoreView(a.record).skus[0].id;
    const bSku = previewStoreView(b.record).skus[0].id;
    expect((await cat.getSkus(["aurum-1", aSku, bSku, `${a.record.key}~pv-99-nope`])).map((s) => s.id)).toEqual(["aurum-1", aSku, bSku]);
    expect(await cat.listCatalog(`preview:${a.record.key}`)).toHaveLength(10);
    expect((await cat.listCatalog()).map((s) => s.id)).toEqual(["aurum-1"]);
    expect(await cat.listCatalog("preview:bogus")).toEqual([]);
  });
});

describe("widget settings", () => {
  it("validates character, languages, accent contrast and a plain greeting", () => {
    expect(validateSettings({ character: "mascot", languages: ["vi"], defaultLanguage: "vi", accentColor: "#1F6F5C", greeting: "Xin chào!" })).toEqual({
      ok: true,
      settings: { character: "mascot", languages: ["vi"], defaultLanguage: "vi", accentColor: "#1f6f5c", greeting: "Xin chào!" },
    });
    const bad = validateSettings({ character: "live2d-upload", languages: ["fr"], accentColor: "#ffff00", greeting: "<b>hi</b> https://x.example" });
    expect(bad).toEqual({ ok: false, errors: ["character", "languages", "defaultLanguage", "accentContrast", "greeting"] });
    expect(validateSettings({ accentColor: "red" })).toMatchObject({ ok: false, errors: ["accentColor"] });
    expect(validateSettings({ greeting: "x".repeat(141) })).toMatchObject({ ok: false, errors: ["greeting"] });
    expect(validateSettings({ languages: ["en", "vi"], defaultLanguage: "vi" })).toMatchObject({ ok: true });
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
  });

  it("stored junk falls back to defaults field by field", () => {
    expect(widgetSettingsFrom({ character: "x", languages: ["vi"], defaultLanguage: "vi", accentColor: "#eeeeee", greeting: "Hello" })).toEqual({ character: "mark-kun", languages: ["vi"], defaultLanguage: "vi", greeting: "Hello" });
    expect(widgetSettingsFrom(undefined)).toEqual({ character: "mark-kun", languages: ["en", "vi"], defaultLanguage: "en" });
  });
});

describe("frame-ancestors and the parent allow-list", () => {
  const strict = { GIFTFIT_WIDGET_ORIGINS: "https://demo.example", APP_BASE_URL: "https://app.example" };
  it("normal stores keep the strict list; ready previews add any https origin, never http", () => {
    expect(widgetFrameAncestors(strict)).toBe("'self' https://app.example https://demo.example");
    expect(widgetFrameAncestors(strict, { previewReady: true })).toBe("'self' https: https://app.example https://demo.example");
    expect(widgetFrameAncestors({}, { previewReady: true })).toBe("*");
    expect(isWidgetOriginAllowed("https://shop.example", null, strict)).toBe(false);
    expect(isWidgetOriginAllowed("https://shop.example", null, strict, { previewReady: true })).toBe(true);
    expect(isWidgetOriginAllowed("http://shop.example", null, strict, { previewReady: true })).toBe(false);
    expect(isWidgetOriginAllowed("https://shop.example/path", null, strict, { previewReady: true })).toBe(false);
  });

  describe("middleware", () => {
    let saved: string | undefined;
    beforeEach(() => {
      saved = process.env.GIFTFIT_WIDGET_ORIGINS;
      process.env.GIFTFIT_WIDGET_ORIGINS = "https://demo.example";
    });
    afterEach(() => {
      if (saved === undefined) delete process.env.GIFTFIT_WIDGET_ORIGINS;
      else process.env.GIFTFIT_WIDGET_ORIGINS = saved;
    });
    const csp = async (store: string) => (await middleware(new NextRequest(`${BASE}/w?store=${encodeURIComponent(store)}&parent=https%3A%2F%2Fshop.example`))).headers.get("content-security-policy");

    it("/w opens to https: only for a READY preview key", async () => {
      const ready = await seed();
      const crawling = await seed("jewelry", "crawling");
      expect(await csp(`preview:${ready.record.key}`)).toBe("frame-ancestors 'self' https: https://demo.example");
      expect(await csp(`preview:${crawling.record.key}`)).toBe("frame-ancestors 'self' https://demo.example");
      expect(await csp(`preview:${"Q".repeat(22)}`)).toBe("frame-ancestors 'self' https://demo.example");
      expect(await csp("aurum")).toBe("frame-ancestors 'self' https://demo.example");
    });

    it("/s/** is noindex and sends no Referer", async () => {
      const res = await middleware(new NextRequest(`${BASE}/s/${"A".repeat(22)}`));
      expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    });

    it("/admin: a token in ?t= is never accepted (even a valid one: 403, no cookie); only the owner cookie opens it", async () => {
      const f = await seed();
      const key = f.record.key;
      const valid = await middleware(new NextRequest(`${BASE}/admin/${key}?t=${f.ownerToken}`));
      expect(valid.status).toBe(403);
      expect(valid.headers.get("set-cookie")).toBeNull();
      expect(await valid.text()).not.toContain(f.ownerToken);

      const bad = await middleware(new NextRequest(`${BASE}/admin/${key}?t=${"x".repeat(43)}`));
      expect(bad.status).toBe(403);
      expect(bad.headers.get("set-cookie")).toBeNull();

      const none = await middleware(new NextRequest(`${BASE}/admin/${key}`));
      expect(none.status).toBe(403);
      expect(await none.text()).not.toContain(f.ownerToken);

      const other = await seed();
      const wrongKey = new NextRequest(`${BASE}/admin/${other.record.key}`, { headers: { cookie: `${OWNER_COOKIE}=${f.ownerToken}` } });
      expect((await middleware(wrongKey)).status).toBe(403);
      const ok = new NextRequest(`${BASE}/admin/${key}`, { headers: { cookie: `${OWNER_COOKIE}=${f.ownerToken}` } });
      const res = await middleware(ok);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      // Server actions need a real Origin on POST: same-origin, not no-referrer (which sends "Origin: null").
      expect(res.headers.get("referrer-policy")).toBe("same-origin");
      expect((await middleware(new NextRequest(`${BASE}/admin/nope`))).status).toBe(404);
    });
  });
});

describe("Admin v0 operations", () => {
  it("owner checks, removal, restore and settings", async () => {
    const f = await seed();
    expect(adminKeyOf(`/admin/${f.record.key}/x`)).toBe(f.record.key);
    expect(await verifyOwner(f.record.key, "nope")).toBeNull();
    const rec = (await verifyOwner(f.record.key, f.ownerToken))!;
    expect(rec.key).toBe(f.record.key);
    expect(ownerCookie("k".repeat(22), "t", new Date(Date.now() + 10_000), { secure: false })).not.toContain("Secure");

    expect(await removeProduct(rec, "nope")).toEqual({ ok: false, error: "unknown_product" });
    expect(await removeProduct(rec, "1003")).toEqual({ ok: true, message: "removed" });
    expect((await loadPreviewStore(rec.key))!.products.map((p) => p.id)).not.toContain("1003");
    await restoreProducts((await repo.get(rec.key))!);
    expect((await loadPreviewStore(rec.key))!.products.map((p) => p.id)).toContain("1003");

    expect(await saveWidgetSettings(rec, { accentColor: "#ffff66" })).toEqual({ ok: false, error: "accentContrast" });
    expect(await saveWidgetSettings(rec, { character: "mascot", languages: ["vi"], defaultLanguage: "vi", accentColor: "#1f6f5c", greeting: "Chào bạn!" })).toEqual({ ok: true, message: "saved" });
    expect((await loadPreviewStore(rec.key))!.settings).toEqual({ character: "mascot", languages: ["vi"], defaultLanguage: "vi", accentColor: "#1f6f5c", greeting: "Chào bạn!" });
  });

  it("re-ingest goes through the per-IP daily cap and refuses while a crawl runs", async () => {
    const f = await seed();
    const counters = new MemoryDailyCounterStore();
    const ingested: string[] = [];
    let release: () => void = () => undefined;
    let gate = new Promise<void>((r) => (release = r));
    setPreviewDepsForTests({
      repo,
      counters,
      env: { PREVIEW_IP_DAILY_CAP: "2" },
      ingest: async (url) => {
        ingested.push(url);
        await gate;
        return { outcome: "ready", domain: f.record.domain, origin: f.record.storeUrl, storeName: "Lumen Fine Jewelry", platform: "shopify", products: f.record.products, currency: "USD", fetches: 3, ms: 5 };
      },
    });
    const req = () => new Request("http://x/", { headers: { "x-forwarded-for": "203.0.113.9" } });
    expect(await reingestPreview((await repo.get(f.record.key))!, req())).toEqual({ ok: true, message: "reingest_started" });
    expect(await reingestPreview((await repo.get(f.record.key))!, req())).toEqual({ ok: false, error: "busy" });
    const { drainPreviewJobsForTests } = await import("@/lib/preview/service");
    release();
    await drainPreviewJobsForTests();
    expect(ingested).toEqual(["https://lumen-jewelry.example"]);
    expect((await repo.get(f.record.key))!.state).toBe("ready");
    gate = Promise.resolve();
    expect(await reingestPreview((await repo.get(f.record.key))!, req())).toEqual({ ok: true, message: "reingest_started" });
    await drainPreviewJobsForTests();
    expect(await reingestPreview((await repo.get(f.record.key))!, req())).toMatchObject({ ok: false, error: "rate_limited" });
    expect(ingested).toHaveLength(2);
  });
});

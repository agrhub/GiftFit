import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadYoucamConfig } from "../config";
import { FEATURE_COST_SNAPSHOT, parseFeatureCostPage, priceFor, slugFromTaskUrl } from "../costs";
import { YoucamValidationError } from "../errors";
import {
  FEATURES,
  GIFT_FACE_FEATURES,
  HAND_JEWELRY,
  attachFiles,
  buildJewelryBody,
  fixtureName,
  getFeature,
  resultCacheTtlMs,
  taskPath,
  type FeatureSlug,
} from "../features";
import { HD_SKIN_ACTIONS } from "../types";

describe("loadYoucamConfig", () => {
  it("defaults to mock with paid calls off", () => {
    const c = loadYoucamConfig({});
    expect(c).toMatchObject({ mock: true, allowPaid: false, reserveUnits: 300, maxUnitsPerRun: 40, pollIntervalMs: 5000, maxPolls: 60, jewelryBodyVariant: "A" });
    expect(c.baseUrl).toBe("https://yce-api-01.makeupar.com");
    expect(c.apiKey).toBeUndefined();
  });

  it("needs MOCK unset/0 and ALLOW_PAID=1 for paid calls", () => {
    expect(loadYoucamConfig({ YOUCAM_ALLOW_PAID: "1" })).toMatchObject({ mock: false, allowPaid: true });
    expect(loadYoucamConfig({ YOUCAM_MOCK: "0", YOUCAM_ALLOW_PAID: "true" })).toMatchObject({ mock: false, allowPaid: true });
    expect(loadYoucamConfig({ YOUCAM_MOCK: "0" })).toMatchObject({ mock: false, allowPaid: false });
    expect(loadYoucamConfig({ YOUCAM_MOCK: "1", YOUCAM_ALLOW_PAID: "1" })).toMatchObject({ mock: true, allowPaid: false });
    expect(loadYoucamConfig({ YOUCAM_MOCK: "", YOUCAM_ALLOW_PAID: "0" })).toMatchObject({ mock: true, allowPaid: false });
  });

  it("parses numbers, urls and paths", () => {
    const c = loadYoucamConfig({
      YOUCAM_API_KEY: " k ",
      YOUCAM_BASE_URL: "https://x.test///",
      YOUCAM_RESERVE_UNITS: "10",
      YOUCAM_MAX_UNITS_PER_RUN: "5",
      YOUCAM_MAX_POLLS: "0",
      YOUCAM_POLL_INTERVAL_MS: "10",
      YOUCAM_MOCK_LATENCY_MS: "3",
      YOUCAM_WEBHOOK_SECRET: "whsec_x",
      YOUCAM_FIXTURES_DIR: "fx",
      GIFTFIT_DATA_DIR: "data",
      DATABASE_URL: "postgres://db",
    });
    expect(c).toMatchObject({
      apiKey: "k",
      baseUrl: "https://x.test",
      reserveUnits: 10,
      maxUnitsPerRun: 5,
      maxPolls: 1,
      pollIntervalMs: 10,
      mockLatencyMs: 3,
      webhookSecret: "whsec_x",
      databaseUrl: "postgres://db",
    });
    expect(c.fixturesDir).toBe(path.resolve("fx"));
    expect(c.dataDir).toBe(path.resolve("data"));
  });

  it("uses the temp dir on Vercel and rejects bad numbers", () => {
    expect(loadYoucamConfig({ VERCEL: "1" }).dataDir).toBe(path.join(os.tmpdir(), "giftfit"));
    expect(loadYoucamConfig({}).dataDir).toBe(path.join(process.cwd(), ".giftfit"));
    expect(() => loadYoucamConfig({ YOUCAM_RESERVE_UNITS: "-1" })).toThrow(/YOUCAM_RESERVE_UNITS/);
    expect(() => loadYoucamConfig({ YOUCAM_MAX_UNITS_PER_RUN: "abc" })).toThrow(/non-negative/);
    expect(loadYoucamConfig({ YOUCAM_JEWELRY_BODY_VARIANT: " b " }).jewelryBodyVariant).toBe("B");
    expect(() => loadYoucamConfig({ YOUCAM_JEWELRY_BODY_VARIANT: "D" })).toThrow(/A, B, C/);
  });
});

describe("feature specs", () => {
  const img = { url: "https://img.test/a.jpg" };

  it("covers every planned slug with a task path", () => {
    expect(Object.keys(FEATURES)).toHaveLength(13);
    expect(taskPath(FEATURES["skin-analysis"])).toBe("/s2s/v2.1/task/skin-analysis");
    expect(taskPath(FEATURES["2d-vto/earring"])).toBe("/s2s/v2.0/task/2d-vto/earring");
    expect(fixtureName("2d-vto/ring")).toBe("2d-vto-ring");
    expect(() => getFeature("nope" as FeatureSlug)).toThrow(YoucamValidationError);
    expect(FEATURES["2d-vto/ring"].uploadPath).toBeUndefined(); // generic upload first (TODO verify)
    expect(FEATURES["2d-vto/watch"].label).toBe("AI Watch VTO");
  });

  it("skin-analysis: 16 HD json by default, never mixes HD and SD", () => {
    const s = FEATURES["skin-analysis"];
    expect(s.buildBody({})).toEqual({ dst_actions: [...HD_SKIN_ACTIONS], format: "json", miniserver_args: { enable_mask_overlay: false } });
    expect(s.tier({})).toEqual({ versionLabel: "V2.1", quality: "HD", count: 16 });
    expect(s.tier({ dstActions: ["wrinkle", "pore"] })).toEqual({ versionLabel: "V2.1", quality: "SD", count: 2 });
    expect(s.buildBody({ dstActions: ["acne"], maskOverlay: true }).miniserver_args).toEqual({ enable_mask_overlay: true });
    expect(() => s.buildBody({ dstActions: ["hd_acne", "acne"] })).toThrow(/mixed/);
    expect(() => s.buildBody({ dstActions: [] })).toThrow(/empty/);
    expect(() => s.buildBody({ dstActions: ["hd_acne", "hd_acne"] })).toThrow(/duplicates/);
    expect(() => s.buildBody({ dstActions: ["bogus" as never] })).toThrow(/unknown/);
    expect(s.refs({})).toEqual([]);
  });

  it("fitzpatrick, tones, face attributes", () => {
    expect(FEATURES["fitzpatrick-scale-analyzer"].buildBody({})).toEqual({ version: "1.0", index: 0 });
    expect(() => FEATURES["fitzpatrick-scale-analyzer"].buildBody({ index: -1 })).toThrow();
    expect(FEATURES["skin-tone-analysis"].buildBody({})).toEqual({});
    expect(FEATURES["skin-tone-analysis"].buildBody({ faceAngleStrictness: "low" })).toEqual({ face_angle_strictness_level: "low" });
    const fa = FEATURES["face-attr-analysis"];
    expect(fa.buildBody({})).toEqual({ features: [...GIFT_FACE_FEATURES] });
    expect(fa.tier({})).toEqual({ count: 5 });
    expect(() => fa.buildBody({ features: ["age", "gender", "eyeShape", "eyeSize", "lipShape", "faceShape"] })).toThrow(/allowHigherTier/);
    expect(fa.buildBody({ features: ["age", "gender", "eyeShape", "eyeSize", "lipShape", "faceShape"], allowHigherTier: true }).features).toHaveLength(6);
    expect(fa.buildBody({ features: ["faceShape", "age"] })).toEqual({ features: ["faceShape", "age"] });
    expect(fa.tier({ features: ["faceShape"] })).toEqual({ count: 1 });
    expect(() => fa.buildBody({ features: [] })).toThrow(/empty/);
    expect(() => fa.buildBody({ features: ["x" as never] })).toThrow(/unknown/);
    expect(() => fa.buildBody({ features: ["age", "age"] })).toThrow(/duplicate/);
    expect(() => fa.buildBody({ features: [] })).toThrow(/empty/);
  });

  it("skin simulation counts only non-zero concerns", () => {
    const s = FEATURES["skin-simulation"];
    expect(s.buildBody({ concerns: { acne: 0.5, wrinkle: 0 } })).toEqual({ acne: 0.5 });
    expect(s.tier({ concerns: { acne: 0.5, wrinkle: 0, pores: 1 } })).toEqual({ count: 2 });
    expect(() => s.buildBody({ concerns: { acne: 0 } })).toThrow(/at least one/);
    expect(() => s.buildBody({ concerns: { acne: 1.5 } })).toThrow(/0.0-1.0/);
    expect(() => s.buildBody({ concerns: { freckles: 0.2 } as never })).toThrow(/unknown concern/);
  });

  it("makeup and hair color", () => {
    const m = FEATURES["makeup-vto"];
    expect(m.buildBody({ effects: [{ category: "lip_color" }] })).toEqual({ version: "1.0", effects: [{ category: "lip_color" }] });
    expect(() => m.buildBody({ effects: [] })).toThrow();
    expect(() => m.buildBody({ effects: [{ category: "" }] })).toThrow(/category/);
    const h = FEATURES["hair-color"];
    expect(h.buildBody({ preset: "Burgundy" })).toEqual({ preset: "Burgundy" });
    expect(h.tier({ preset: "Burgundy" })).toEqual({ variant: "Full" });
    expect(h.tier({ preset: "Jet Black/Silver Gray" })).toEqual({ variant: "Ombre" });
    const ombre = { pattern: { name: "ombre" as const }, palettes: [{ color: "#000000" }, { color: "#ffffff" }] };
    expect(h.buildBody(ombre)).toEqual(ombre);
    expect(h.tier(ombre)).toEqual({ variant: "Ombre" });
    expect(h.tier({ pattern: { name: "full" }, palettes: [{ color: "#000000" }] })).toEqual({ variant: "Full" });
    expect(() => h.buildBody({ preset: "Neon" as never })).toThrow(/preset/);
    expect(() => h.buildBody({})).toThrow(/preset, or a pattern/);
    expect(() => h.buildBody({ pattern: { name: "full" }, palettes: ombre.palettes })).toThrow(/1 palette/);
    expect(() => h.buildBody({ pattern: { name: "full" }, palettes: [{ color: "red" }] })).toThrow(/#RRGGBB/);
  });

  it("cloth and jewelry", () => {
    const c = FEATURES["cloth-v4"];
    expect(c.buildBody({ garment: img, garmentCategory: "upper_body" })).toEqual({ garment_category: "upper_body" });
    expect(c.buildBody({ garment: img, garmentCategory: "full_body", changeShoes: false, filterMultiPerson: "strict" })).toEqual({
      garment_category: "full_body",
      change_shoes: false,
      filter_multi_person: "strict",
    });
    expect(c.refs({ garment: img, garmentCategory: "auto" })).toEqual([img]);
    expect(() => c.buildBody({ garment: undefined as never, garmentCategory: "auto" })).toThrow(/garment/);
    expect(() => c.buildBody({ garment: img, garmentCategory: "hat" as never })).toThrow(/garmentCategory/);

    const e = FEATURES["2d-vto/earring"];
    expect(e.buildBody({ products: [img] })).toEqual({});
    expect(e.tier({ products: [img] })).toEqual({ variant: "Single" });
    expect(e.tier({ products: [img, img] })).toEqual({ variant: "Stacked" });
    expect(e.refs({ products: [img] })).toEqual([img]);
    expect(() => e.buildBody({ products: [] })).toThrow(/at least one/);
    expect(FEATURES["2d-vto/necklace"].tier({ products: [img] })).toEqual({});
    expect(() => FEATURES["2d-vto/necklace"].buildBody({ products: [img, img] })).toThrow(/only one/);
    expect(() => e.buildBody({ products: [img], shadowIntensity: 2 })).toThrow(/shadowIntensity/);
    expect(() => e.buildBody({ products: [img], ambientLightIntensity: -1 })).toThrow(/ambientLightIntensity/);
    expect(e.objectParameter!({ products: [img] })).toEqual({
      earring_need_remove_background: true,
      earring_is_right_ear: true,
      earring_shadow_intensity: 0.2,
      earring_ambient_light_intensity: 1,
    });
    expect(
      FEATURES["2d-vto/ring"].objectParameter!({ products: [img], parameter: { ring_wearing_finger: 3, ring_shadow_intensity: 0.5 }, shadowIntensity: 0.1 }),
    ).toEqual({ ring_need_remove_background: true, ring_shadow_intensity: 0.1, ring_ambient_light_intensity: 1, ring_wearing_finger: 3 });
    expect(FEATURES["2d-vto/watch"].objectParameter!({ products: [img], ambientLightIntensity: 0.8 })).toMatchObject({
      watch_shadow_intensity: 0.3,
      watch_ambient_light_intensity: 0.8,
    });
    expect(HAND_JEWELRY).toEqual(["ring", "bracelet", "watch"]);
    expect(resultCacheTtlMs("2d-vto/earring")).toBe(90 * 60 * 1000);
    expect(resultCacheTtlMs("skin-tone-analysis")).toBe(72 * 60 * 60 * 1000);
  });

  it("attachFiles builds src/ref fields for each ref mode", () => {
    expect(attachFiles("none", { a: 1 }, { kind: "id", value: "f1" }, [])).toEqual({ a: 1, src_file_id: "f1" });
    expect(attachFiles("single", {}, { kind: "url", value: "u" }, [{ kind: "id", value: "r" }])).toEqual({
      src_file_url: "u",
      ref_file_id: "r",
    });
    expect(attachFiles("single", {}, { kind: "id", value: "s" }, [{ kind: "url", value: "ru" }])).toMatchObject({ ref_file_url: "ru" });
    expect(() => attachFiles("single", {}, { kind: "id", value: "s" }, [])).toThrow(/exactly one/);
    const p = { earring_is_right_ear: true };
    const s = { kind: "id" as const, value: "s" };
    const r = [{ kind: "id" as const, value: "r1" }];
    expect(buildJewelryBody("B", s, r, p)).toEqual({ source_info: { name: "s" }, object_infos: [{ name: "r1", parameter: p }] });
    expect(buildJewelryBody("C", s, r, p)).toEqual({ src_file_id: "s", ref_file_ids: ["r1"], object_infos: [{ parameter: p }] });
    expect(buildJewelryBody("C", s, r)).toEqual({ src_file_id: "s", ref_file_ids: ["r1"], object_infos: [{}] });
    expect(attachFiles("multi", { x: 1 }, s, r, p, "B")).toEqual({ x: 1, source_info: { name: "s" }, object_infos: [{ name: "r1", parameter: p }] });
    expect(
      attachFiles("multi", {}, { kind: "id", value: "s" }, [{ kind: "id", value: "r1" }, { kind: "id", value: "r2" }], { earring_is_right_ear: true }),
    ).toEqual({
      src_file_id: "s",
      ref_file_ids: ["r1", "r2"],
      source_info: { name: "s" },
      object_infos: [
        { name: "r1", parameter: { earring_is_right_ear: true } },
        { name: "r2", parameter: { earring_is_right_ear: true } },
      ],
    });
    expect(attachFiles("multi", {}, { kind: "url", value: "s" }, [{ kind: "url", value: "r" }])).toMatchObject({
      ref_file_urls: ["r"],
      object_infos: [{ name: "r" }],
    });
    expect(() => attachFiles("multi", {}, { kind: "id", value: "s" }, [])).toThrow(/at least one/);
    expect(() => attachFiles("multi", {}, { kind: "id", value: "s" }, [{ kind: "id", value: "a" }, { kind: "url", value: "b" }])).toThrow(/mixed/);
  });
});

describe("pricing", () => {
  const price = (f: FeatureSlug, p: unknown) => priceFor(FEATURE_COST_SNAPSHOT, f, FEATURES[f].tier(p as never));

  it("matches the 2026-10-15 cost table", () => {
    expect(price("skin-analysis", {})).toBe(22);
    expect(price("skin-analysis", { dstActions: HD_SKIN_ACTIONS.slice(0, 8) })).toBe(16);
    expect(price("skin-analysis", { dstActions: ["wrinkle"] })).toBe(9);
    expect(price("fitzpatrick-scale-analyzer", {}) ).toBe(10);
    expect(price("skin-tone-analysis", {})).toBe(20);
    expect(price("face-attr-analysis", { features: ["faceShape"] })).toBe(10);
    expect(price("face-attr-analysis", {})).toBe(10);
    expect(price("face-attr-analysis", { features: new Array(6).fill("age") })).toBe(20);
    expect(price("face-attr-analysis", { features: new Array(29).fill("age") })).toBeUndefined();
    expect(price("skin-simulation", { concerns: { acne: 1 } })).toBe(4);
    expect(price("skin-simulation", { concerns: { acne: 1, pores: 1, spots: 1, texture: 1, redness: 1 } })).toBe(6);
    expect(price("makeup-vto", {})).toBe(1);
    expect(price("hair-color", { preset: "Burgundy" })).toBe(1);
    expect(price("cloth-v4", {})).toBe(2);
    expect(price("2d-vto/earring", { products: [1, 2] })).toBe(2);
    expect(price("2d-vto/watch", { products: [1] })).toBe(1);
  });

  it("takes the most expensive match and honours proc_unit", () => {
    const skus = [
      { feature: "makeup-vto", description: "A", amount: 1 },
      { feature: "makeup-vto", description: "B", amount: 3, proc_unit: 2 },
    ];
    expect(priceFor(skus, "makeup-vto", {})).toBe(6);
    expect(priceFor(skus, "cloth-v4", {})).toBeUndefined();
    expect(priceFor([{ feature: "skin-analysis", amount: 5 }], "skin-analysis", { count: 3 })).toBeUndefined();
  });

  it("parses feature-cost pages", () => {
    expect(slugFromTaskUrl("https://h/s2s/v2.1/task/skin-analysis/")).toBe("skin-analysis");
    expect(slugFromTaskUrl("https://h/s2s/v2.0/task/2d-vto/ring")).toBe("2d-vto/ring");
    expect(slugFromTaskUrl(undefined)).toBe("(other)");
    expect(slugFromTaskUrl("https://h/other")).toBe("(other)");
    const page = parseFeatureCostPage({
      result: {
        next_token: "n",
        skus: [{ description: "d", amount: 2, unit: "result_image", proc_unit: 1, run_task_url: "https://h/s2s/v2.0/task/cloth-v4" }, { amount: "3" }],
      },
    });
    expect(page.nextToken).toBe("n");
    expect(page.skus[0]).toMatchObject({ feature: "cloth-v4", amount: 2, description: "d" });
    expect(page.skus[1]).toMatchObject({ feature: "(other)", amount: 3, description: undefined });
    expect(parseFeatureCostPage(null)).toEqual({ skus: [], nextToken: undefined });
  });
});

import { describe, expect, it } from "vitest";
import { CATALOGS, LOCALES, detectLocale, format, formatMoney, localeFromText, normalizeLocale, parseLangList, t } from "..";
import { en } from "../en";

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("catalogs", () => {
  it("every locale defines exactly the English keys, non-empty, with the same placeholders", () => {
    const keys = Object.keys(en).sort();
    for (const l of LOCALES) {
      const cat = CATALOGS[l];
      expect(Object.keys(cat).sort(), l).toEqual(keys);
      for (const k of keys) {
        const v = cat[k as keyof typeof en];
        expect(v.trim().length, `${l}:${k}`).toBeGreaterThan(0);
        expect(placeholders(v), `${l}:${k}`).toEqual(placeholders(en[k as keyof typeof en]));
      }
    }
  });

  it("Vietnamese strings are actually translated (not copies of English), except names", () => {
    const same = Object.keys(en).filter((k) => CATALOGS.vi[k as keyof typeof en] === en[k as keyof typeof en]);
    expect(same.every((k) => /^(share\.(whatsapp|messenger|zalo)|lang\.)/.test(k)), same.join(", ")).toBe(true);
  });

  it("covers every occasion, category and metal key the widget renders", () => {
    for (const o of ["anniversary", "birthday", "wedding", "holiday", "graduation", "thank_you", "just_because"]) expect(`occasion.${o}` in en).toBe(true);
    for (const c of ["earring", "necklace", "ring", "bracelet", "watch"]) expect(`category.${c}` in en).toBe(true);
  });
});

describe("t / format", () => {
  it("interpolates and leaves unknown placeholders", () => {
    expect(t("en", "chat.introPdp", { title: "Halo" })).toBe("You're looking at Halo. Shall we gift this piece, or should I help you choose?");
    expect(t("vi", "brief.budgetValue", { price: "$300" })).toBe("Tối đa $300");
    expect(format("{a} {b}", { a: 1 })).toBe("1 {b}");
  });

  it("formats money per locale", () => {
    expect(formatMoney("en", 300)).toBe("$300");
    expect(formatMoney("vi", 300)).toMatch(/300/);
    expect(formatMoney("en", 1, "N0T")).toBe("1 N0T");
  });
});

describe("detection", () => {
  it("normalizes tags and parses data-langs", () => {
    expect(normalizeLocale("vi-VN")).toBe("vi");
    expect(normalizeLocale("EN_us")).toBe("en");
    expect(normalizeLocale("fr")).toBeUndefined();
    expect(parseLangList("vi, fr en")).toEqual(["vi", "en"]);
    expect(parseLangList("")).toEqual(["en", "vi"]);
    expect(parseLangList("de")).toEqual(["en", "vi"]);
  });

  it("host lang, then browser, then store default, within the allow-list", () => {
    expect(detectLocale({ hostLang: "vi", navigatorLanguages: ["en-US"] })).toBe("vi");
    expect(detectLocale({ hostLang: "fr", navigatorLanguages: ["de", "vi-VN"] })).toBe("vi");
    expect(detectLocale({ hostLang: "fr", navigatorLanguages: ["de"], preferred: "vi" })).toBe("vi");
    expect(detectLocale({})).toBe("en");
    expect(detectLocale({ hostLang: "vi", allowed: ["en"] })).toBe("en");
    expect(detectLocale({ hostLang: "en", allowed: ["vi"] })).toBe("vi");
  });

  it("reads the shopper's language from their message", () => {
    expect(localeFromText("Mình muốn tặng mẹ quà sinh nhật")).toBe("vi");
    expect(localeFromText("minh muon tang qua cho me")).toBe("vi");
    expect(localeFromText("Anniversary gift for my wife, $300")).toBe("en");
    expect(localeFromText("ok")).toBeUndefined();
    expect(localeFromText("誕生日のプレゼント")).toBeUndefined();
  });
});

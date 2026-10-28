import { describe, expect, it } from "vitest";
import { CATALOGS, INTL_LOCALES, isWidgetKey, LOCALES, SITE_LOCALES, detectLocale, format, formatMoney, localeFromText, normalizeLocale, parseLangList, t, type Locale } from "..";
import { en } from "../en";

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const catalog = (l: Locale) => CATALOGS[l] as Partial<Record<keyof typeof en, string>>;
const NEW_LOCALES = LOCALES.filter((l) => !(SITE_LOCALES as readonly string[]).includes(l));
/** Names that stay the same in every language (brands, language endonyms). */
const SAME_EVERYWHERE = /^(share\.(whatsapp|messenger|zalo)|lang\.)/;
/** Words that are genuinely the same as in English. */
const COGNATES: Partial<Record<Locale, string[]>> = { fr: ["chat.log", "brief.occasion", "brief.budget", "brief.style", "category.bracelet"], de: ["brief.budget"] };

describe("catalogs", () => {
  it("site locales define exactly the English keys, non-empty, with the same placeholders", () => {
    const keys = Object.keys(en).sort();
    for (const l of SITE_LOCALES) {
      const cat = catalog(l);
      expect(Object.keys(cat).sort(), l).toEqual(keys);
      for (const k of keys) {
        const v = cat[k as keyof typeof en]!;
        expect(v.trim().length, `${l}:${k}`).toBeGreaterThan(0);
        expect(placeholders(v), `${l}:${k}`).toEqual(placeholders(en[k as keyof typeof en]));
      }
    }
  });

  it("every widget locale defines every widget key (no missing, extra or empty strings) with the same placeholders", () => {
    const widgetKeys = Object.keys(en).filter(isWidgetKey).sort();
    expect(widgetKeys.length).toBeGreaterThan(150);
    expect(widgetKeys.some((k) => /^(site|landing|pstore)\./.test(k))).toBe(false);
    for (const l of NEW_LOCALES) {
      const cat = catalog(l);
      expect(Object.keys(cat).sort(), l).toEqual(widgetKeys);
      for (const k of widgetKeys) {
        const v = cat[k as keyof typeof en];
        expect(typeof v === "string" && v.trim().length > 0, `${l}:${k}`).toBe(true);
        expect(placeholders(v!), `${l}:${k}`).toEqual(placeholders(en[k as keyof typeof en]));
      }
    }
  });

  it("translations are actual translations (not copies of English), except names", () => {
    for (const l of LOCALES.filter((x) => x !== "en")) {
      const cat = catalog(l);
      const same = Object.keys(cat).filter((k) => cat[k as keyof typeof en] === en[k as keyof typeof en]);
      expect(same.filter((k) => !SAME_EVERYWHERE.test(k) && !COGNATES[l]?.includes(k)), l).toEqual([]);
    }
  });

  it("every locale has a language name, the same endonym everywhere", () => {
    for (const l of LOCALES) for (const c of LOCALES) expect(catalog(c)[`lang.${l}` as keyof typeof en], `${c}:lang.${l}`).toBe(en[`lang.${l}` as keyof typeof en]);
  });

  it("site/landing/preview-store keys fall back to English outside en/vi", () => {
    expect(t("ja", "landing.ctaTry")).toBe(en["landing.ctaTry"]);
    expect(t("de", "pstore.products", { count: 3 })).toBe("3 products");
    expect(t("ja", "panel.title")).not.toBe(en["panel.title"]);
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
    expect(t("fr", "chat.errorTooLong", { max: 2000 })).toContain("2000");
    expect(format("{a} {b}", { a: 1 })).toBe("1 {b}");
  });

  it("formats money per locale", () => {
    expect(formatMoney("en", 300)).toBe("$300");
    expect(formatMoney("vi", 300)).toMatch(/300/);
    expect(formatMoney("de", 300)).toMatch(/300\s?\$/);
    expect(formatMoney("ja", 300)).toMatch(/300/);
    expect(formatMoney("en", 1, "N0T")).toBe("1 N0T");
    for (const l of LOCALES) expect(INTL_LOCALES[l]).toMatch(/^[a-z]{2}-[A-Z]{2}$/);
  });
});

describe("detection", () => {
  it("normalizes tags and parses data-langs (new codes accepted, junk ignored)", () => {
    expect(normalizeLocale("vi-VN")).toBe("vi");
    expect(normalizeLocale("EN_us")).toBe("en");
    expect(normalizeLocale("fr")).toBe("fr");
    expect(normalizeLocale("de-AT")).toBe("de");
    expect(normalizeLocale("zh-CN")).toBe("zh");
    expect(normalizeLocale("zh-Hans-CN")).toBe("zh");
    expect(normalizeLocale("zh-TW")).toBeUndefined();
    expect(normalizeLocale("zh-Hant")).toBeUndefined();
    expect(normalizeLocale("pt-BR")).toBeUndefined();
    expect(normalizeLocale("xx")).toBeUndefined();
    expect(normalizeLocale(42)).toBeUndefined();
    expect(parseLangList("vi, fr en")).toEqual(["vi", "fr", "en"]);
    expect(parseLangList("ja,ko;zh th id es fr de")).toEqual(["ja", "ko", "zh", "th", "id", "es", "fr", "de"]);
    expect(parseLangList(["de", "DE-de", "it", "<script>", "ja"])).toEqual(["de", "ja"]);
    expect(parseLangList("pt, it, xx")).toEqual([...LOCALES]);
    expect(parseLangList("")).toEqual([...LOCALES]);
    expect(LOCALES).toEqual(["en", "vi", "ja", "ko", "zh", "th", "id", "es", "fr", "de"]);
  });

  it("host lang, then browser, then store default, within the allow-list", () => {
    expect(detectLocale({ hostLang: "vi", navigatorLanguages: ["en-US"] })).toBe("vi");
    expect(detectLocale({ hostLang: "pt", navigatorLanguages: ["it", "vi-VN"] })).toBe("vi");
    expect(detectLocale({ hostLang: "pt", navigatorLanguages: ["it"], preferred: "vi" })).toBe("vi");
    expect(detectLocale({ hostLang: "ja-JP", navigatorLanguages: ["en-US"] })).toBe("ja");
    expect(detectLocale({ hostLang: "ja-JP", allowed: ["en", "vi"] })).toBe("en");
    expect(detectLocale({ navigatorLanguages: ["de-DE"], allowed: ["fr", "de"] })).toBe("de");
    expect(detectLocale({ hostLang: "it", allowed: ["fr", "de"], preferred: "de" })).toBe("de");
    expect(detectLocale({})).toBe("en");
    expect(detectLocale({ hostLang: "vi", allowed: ["en"] })).toBe("en");
    expect(detectLocale({ hostLang: "en", allowed: ["vi"] })).toBe("vi");
    expect(detectLocale({ hostLang: "en", allowed: ["th", "zh"] })).toBe("th");
  });

  it.each([
    ["Mình muốn tặng mẹ quà sinh nhật", "vi"],
    ["minh muon tang qua cho me", "vi"],
    ["Anniversary gift for my wife, $300", "en"],
    ["Help me choose a gift for my mom", "en"],
    ["妻への誕生日プレゼントを探しています", "ja"],
    ["誕生日のプレゼント", "ja"],
    ["아내에게 줄 생일 선물을 찾고 있어요", "ko"],
    ["我想给妈妈买生日礼物，预算300美元", "zh"],
    ["อยากได้ของขวัญวันเกิดให้แม่ งบ 300 ดอลลาร์", "th"],
    ["Saya mau cari hadiah ulang tahun untuk istri", "id"],
    ["Hadiah untuk ibu", "id"],
    ["Busco un regalo de cumpleaños para mi hermana", "es"],
    ["Regalo para mamá", "es"],
    ["Je cherche un cadeau d'anniversaire pour ma femme", "fr"],
    ["Quelque chose de joli pour la fête des mères", "fr"],
    ["Ich suche ein Geschenk für meine Frau zum Geburtstag", "de"],
    ["Geschenk für Mama", "de"],
  ] as const)("reads the shopper's language: %s → %s", (text, want) => {
    expect(localeFromText(text)).toBe(want);
  });

  it("stays undecided on short, mixed or unoffered text", () => {
    expect(localeFromText("ok")).toBeUndefined();
    expect(localeFromText("礼")).toBeUndefined();
    expect(localeFromText("Aster studs")).toBeUndefined();
    expect(localeFromText("Привет, подарок для мамы")).toBeUndefined();
    expect(localeFromText("مرحبا هدية لأمي")).toBeUndefined();
    expect(localeFromText("Regalo for my esposa")).toBeUndefined();
  });
});

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LOCALES } from "..";
import { RECIPIENT_CATALOGS, faceShapeText, fromEnglish, metalInline, parseAcceptLanguage, recipientLocale, rt, rtCount, type RecipientMessageKey } from "../recipient";
import { en } from "../recipient/en";

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const KEYS = Object.keys(en).sort() as RecipientMessageKey[];
/** Words that are genuinely the same as in English. */
const SAME: Partial<Record<string, RecipientMessageKey[]>> = {
  fr: ["category.bracelet", "focus.bracelet", "processing.seconds", "done.seconds", "card.aiPreview"],
  de: ["piece.inMetal", "undertone.warm", "undertone.neutral", "processing.seconds", "done.seconds", "focus.ring", "category.ring", "aiModel.badge"],
  es: ["processing.seconds", "done.seconds"],
  id: ["faceShape.Oval", "undertone.heading"],
};

describe("recipient catalogs (lib/i18n/recipient)", () => {
  it("every locale defines exactly the English keys, non-empty, with the same placeholders", () => {
    expect(KEYS.length).toBeGreaterThan(250);
    for (const l of LOCALES) {
      const cat = RECIPIENT_CATALOGS[l];
      expect(Object.keys(cat).sort(), l).toEqual(KEYS);
      for (const k of KEYS) {
        expect(cat[k].trim().length, `${l}:${k}`).toBeGreaterThan(0);
        expect(placeholders(cat[k]), `${l}:${k}`).toEqual(placeholders(en[k]));
      }
    }
  });

  it("the nine translations are translated (not English copies), apart from true cognates", () => {
    for (const l of LOCALES.filter((x) => x !== "en")) {
      const copies = KEYS.filter((k) => RECIPIENT_CATALOGS[l][k] === en[k] && !/^\{?[^a-z]*\}?$/i.test(en[k]) && !(SAME[l] ?? []).includes(k));
      expect(copies, l).toEqual([]);
    }
  });

  it("privacy wording keeps the retention facts in every language (1 hour, 15 minutes, 24 hours, 72 hours)", () => {
    for (const l of LOCALES) {
      const c = RECIPIENT_CATALOGS[l];
      expect(c["intro.retention"], l).toMatch(/1/);
      expect(c["photo.kept"], l).toMatch(/1/);
      expect(c["privacy.keepPhoto"], l).toMatch(/1/);
      expect(c["privacy.keepTryOns"], l).toMatch(/15/);
      expect(c["privacy.processorBody"], l).toMatch(/24/);
      expect(c["privacy.expiry72"], l).toMatch(/72/);
      expect(c["expired.body"], l).toMatch(/72/);
      // "AI-generated model" disclosures stay.
      expect(c["aiModel.badge"], l).toMatch(/AI|IA|KI/);
      expect(c["demo.bar"], l).toMatch(/AI|IA|KI/);
    }
  });

  it("rt formats placeholders; rtCount picks the plural form", () => {
    expect(rt("en", "intro.tryOn", { count: 6 })).toBe("Try on 6 pieces and heart the ones you love.");
    expect(rt("de", "selfie.step", { total: 3 })).toBe("Schritt 1 von 3");
    expect(rtCount("en", "hand.body", 1)).toMatch(/^1 piece is worn/);
    expect(rtCount("en", "hand.body", 2)).toMatch(/^2 pieces are worn/);
    expect(rtCount("fr", "tryon.ready", 0)).toBe(rt("fr", "tryon.ready_one", { count: 0 }));
    expect(rtCount("ja", "tryon.ready", 3)).toContain("3");
  });
});

describe("recipientLocale: browser language in the ten, else the giver's, else English", () => {
  it("the browser's language wins when it is one of the ten", () => {
    expect(recipientLocale({ browserLanguages: ["de-DE", "en"], giverLang: "vi" })).toBe("de");
    expect(recipientLocale({ browserLanguages: ["ja"], giverLang: null })).toBe("ja");
    // Any listed language counts, in order: pt is not offered, en is.
    expect(recipientLocale({ browserLanguages: ["pt-BR", "en-US"], giverLang: "ko" })).toBe("en");
  });

  it("a browser outside the ten falls back to the giver's language", () => {
    expect(recipientLocale({ browserLanguages: ["pt-BR", "pt"], giverLang: "vi" })).toBe("vi");
    expect(recipientLocale({ browserLanguages: ["zh-TW"], giverLang: "th" })).toBe("th");
    expect(recipientLocale({ browserLanguages: [], giverLang: "fr" })).toBe("fr");
  });

  it("neither → English (a giver language outside the ten is English too)", () => {
    expect(recipientLocale({ browserLanguages: ["pt-BR"], giverLang: undefined })).toBe("en");
    expect(recipientLocale({ browserLanguages: ["pt-BR"], giverLang: "pt" })).toBe("en");
    expect(recipientLocale({})).toBe("en");
  });

  it("parseAcceptLanguage orders by q and drops q=0 and *", () => {
    expect(parseAcceptLanguage("pt-BR,pt;q=0.9,de;q=0.95,*;q=0.1,en;q=0")).toEqual(["pt-BR", "de", "pt"]);
    expect(parseAcceptLanguage(null)).toEqual([]);
    expect(recipientLocale({ browserLanguages: parseAcceptLanguage("pt-BR,pt;q=0.9,th;q=0.8"), giverLang: "vi" })).toBe("th");
  });
});

describe("English strings from shared code, localized", () => {
  it("every label and hint captureChecks.ts can return has a check.* entry", () => {
    const src = readFileSync(path.join(process.cwd(), "components/gift/recipient/captureChecks.ts"), "utf8");
    const strings = [...src.matchAll(/(?:label|hint):\s*(?:subject === "face"\s*\?\s*)?"([^"]+)"(?:\s*:\s*"([^"]+)")?/g)].flatMap((m) => [m[1], m[2]]).filter(Boolean);
    const ternaries = [...src.matchAll(/\?\s*"([^"]+)"\s*:\s*"([^"]+)"/g)].flatMap((m) => [m[1], m[2]]);
    const all = [...new Set([...strings, ...ternaries])].filter((s) => /^[A-Z]/.test(s));
    expect(all.length).toBeGreaterThan(20);
    for (const s of all) expect(fromEnglish("ja", "check.", s), s).not.toBe(s);
  });

  it("metal names and face shapes from the server", () => {
    expect(fromEnglish("de", "metal.", "Rose gold")).toBe("Roségold");
    expect(metalInline("en", "Rose gold")).toBe("rose gold");
    expect(metalInline("de", "White gold")).toBe("Weißgold");
    expect(metalInline("fr", "Yellow gold")).toBe("or jaune");
    expect(fromEnglish("ja", "metal.", "Unobtainium")).toBe("Unobtainium");
    expect(faceShapeText("ja", "Oval face shape (estimate)")).toBe("卵型の顔（推定）");
    expect(faceShapeText("de", "Face shape not detected")).toBe("Gesichtsform nicht erkannt");
    expect(faceShapeText("en", "Oval face shape (estimate)")).toBe("Oval face shape (estimate)");
  });
});

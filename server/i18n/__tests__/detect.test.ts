/**
 * Language detection for any language (ADR-057 "language follows what the shopper types or says"):
 * scripts, Latin stop words, mixed and very short input, and the conversation fallback.
 */
import { describe, expect, it } from "vitest";
import { baseLanguage, conversationLanguage, detectLanguage, languageName, localeFromText, LOCALES, uiLocaleFor } from "..";

describe("detectLanguage: the ten widget languages", () => {
  it.each([
    ["Anniversary gift for my wife, $300", "en"],
    ["Mình muốn tặng mẹ quà sinh nhật", "vi"],
    ["minh muon tang qua cho me", "vi"],
    ["妻への誕生日プレゼントを探しています", "ja"],
    ["아내에게 줄 생일 선물을 찾고 있어요", "ko"],
    ["我想给妈妈买生日礼物，预算300美元", "zh"],
    ["อยากได้ของขวัญวันเกิดให้แม่ งบ 300 ดอลลาร์", "th"],
    ["Saya mau cari hadiah ulang tahun untuk istri", "id"],
    ["Busco un regalo de cumpleaños para mi hermana", "es"],
    ["Je cherche un cadeau d'anniversaire pour ma femme", "fr"],
    ["Ich suche ein Geschenk für meine Frau zum Geburtstag", "de"],
  ] as const)("%s → %s", (text, want) => {
    expect(detectLanguage(text)).toBe(want);
  });
});

describe("detectLanguage: languages outside the ten", () => {
  it.each([
    ["Quero um presente de aniversário para a minha mãe", "pt"],
    ["Procuro um colar para a minha namorada, até 200 dólares", "pt"],
    ["Cerco un regalo di compleanno per mia moglie", "it"],
    ["Vorrei una collana per la mia fidanzata", "it"],
    ["Ищу подарок для мамы на день рождения", "ru"],
    ["Шукаю подарунок для дружини, щось із сріблом", "uk"],
    ["أبحث عن هدية عيد ميلاد لأمي", "ar"],
    ["دنبال یک هدیه برای مادرم هستم", "fa"],
    ["मैं अपनी पत्नी के लिए जन्मदिन का उपहार ढूंढ रहा हूं", "hi"],
    ["אני מחפש מתנה ליום הולדת של אמא", "he"],
    ["Ψάχνω ένα δώρο γενεθλίων για τη μητέρα μου", "el"],
    ["Ik zoek een cadeau voor mijn vrouw", "nl"],
    ["Szukam prezentu dla mojej żony", "pl"],
    ["Annem için bir doğum günü hediyesi arıyorum", "tr"],
    ["Jag söker en present till min fru", "sv"],
    ["Caut un cadou pentru soția mea", "ro"],
  ] as const)("%s → %s", (text, want) => {
    expect(detectLanguage(text)).toBe(want);
  });

  it("never reports them as a widget locale (the UI must not switch to a missing locale)", () => {
    for (const t of ["Quero um presente para a minha mãe", "Cerco un regalo per mia moglie", "Ищу подарок для мамы", "أبحث عن هدية لأمي"]) {
      expect(localeFromText(t)).toBeUndefined();
      expect(uiLocaleFor(detectLanguage(t))).toBe("en");
    }
  });
});

describe("detectLanguage: unclear input stays undecided", () => {
  it.each([
    ["ok"],
    ["OK!"],
    ["$150"],
    ["150"],
    ["2.000.000"],
    ["🎁💍"],
    ["👍"],
    ["   "],
    [""],
    ["thanks"],
    ["Aster studs"],
    ["Halo Drop Earrings"],
    ["Aster Solitaire Studs – 14k"],
    ["https://shop.example/products/aria-ring"],
    ["me@example.com"],
    ["礼"],
    ["Regalo for my esposa"],
  ])("%j → undefined", (text) => {
    expect(detectLanguage(text)).toBeUndefined();
  });

  it("mixed Vietnamese and English reads as Vietnamese (Vietnamese letters are decisive)", () => {
    expect(detectLanguage("Mình muốn mua earrings cho vợ, budget 5 triệu")).toBe("vi");
    expect(detectLanguage("gift cho mẹ")).toBe("vi");
  });

  it("a CJK or Thai message with a Latin product name keeps its script's language", () => {
    expect(detectLanguage("Aster Solitaire Studs をプレゼントしたい")).toBe("ja");
    expect(detectLanguage("我想送 Halo Drop Earrings 给妈妈")).toBe("zh");
    expect(detectLanguage("อยากได้ Aster Studs ให้แม่")).toBe("th");
  });

  it("emoji and numbers around clear words don't hide the language", () => {
    expect(detectLanguage("🎁 Un regalo para mi mamá, $150 💍")).toBe("es");
    expect(detectLanguage("Quà sinh nhật 🎂 500k")).toBe("vi");
  });
});

describe("conversationLanguage", () => {
  it("the newest clear message wins; unclear ones keep the earlier language", () => {
    expect(conversationLanguage(["Quà cho mẹ", "ok"])).toBe("vi");
    expect(conversationLanguage(["Busco un regalo para mi hermana", "$150", "👍"])).toBe("es");
    expect(conversationLanguage(["Busco un regalo para mi hermana", "Actually, something for my wife please"])).toBe("en");
    expect(conversationLanguage(["Quero um presente para a minha mãe", "Aster studs"])).toBe("pt");
  });

  it("falls back to the page/browser hint, then undefined", () => {
    expect(conversationLanguage(["$150"], "ja-JP")).toBe("ja");
    expect(conversationLanguage(["ok"], "pt-BR")).toBe("pt");
    expect(conversationLanguage(["ok"], "not a tag!")).toBeUndefined();
    expect(conversationLanguage(["ok"])).toBeUndefined();
    expect(conversationLanguage([], "vi")).toBe("vi");
  });
});

describe("helpers", () => {
  it("baseLanguage maps tags and legacy/macro codes", () => {
    expect(baseLanguage("pt-BR")).toBe("pt");
    expect(baseLanguage("cmn-Hans-CN")).toBe("zh");
    expect(baseLanguage("iw-IL")).toBe("he");
    expect(baseLanguage("no")).toBe("nb");
    expect(baseLanguage("fil-PH")).toBe("fil");
    expect(baseLanguage("x")).toBeUndefined();
    expect(baseLanguage(42)).toBeUndefined();
  });

  it("uiLocaleFor: one of the ten, else English", () => {
    for (const l of LOCALES) expect(uiLocaleFor(l)).toBe(l);
    expect(uiLocaleFor("vi-VN")).toBe("vi");
    for (const l of ["pt", "it", "ru", "ar", "hi", "zh-TW", undefined, null, ""]) expect(uiLocaleFor(l)).toBe("en");
  });

  it("languageName gives English names for prompts", () => {
    expect(languageName("pt")).toBe("Portuguese");
    expect(languageName("vi")).toBe("Vietnamese");
    expect(languageName("zz")).toBe("zz");
  });
});

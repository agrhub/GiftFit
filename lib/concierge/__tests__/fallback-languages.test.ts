/**
 * The deterministic parser (fallback.ts parseGiftText / parseBudgetUsd) in the ten widget languages:
 * a natural request per language yields occasion, category, metal, budget and recipient; unspaced
 * scripts (ja, ko, zh, th) match substrings without the usual false positives.
 */
import { describe, expect, it } from "vitest";
import { defaultConciergeCatalog } from "../catalog";
import { fallbackAnswer, parseBudgetUsd, parseGiftText } from "../fallback";
import { fallbackCopy } from "../fallback-text";

const catalog = defaultConciergeCatalog();
const user = (content: string) => [{ role: "user" as const, content }];

describe("a natural request in each widget language", () => {
  it.each([
    ["en", "Birthday earrings in gold for my mom, under $150", "birthday", "earring", "yellow_gold", 150, "feminine"],
    ["vi", "Quà sinh nhật cho mẹ, bông tai vàng, khoảng 150 đô", "birthday", "earring", "yellow_gold", 150, "feminine"],
    ["ja", "母の誕生日に金のピアス、150ドル以内", "birthday", "earring", "yellow_gold", 150, "feminine"],
    ["ko", "엄마 생일 선물로 로즈골드 귀걸이, 150달러 이하", "birthday", "earring", "rose_gold", 150, "feminine"],
    ["zh", "给老公的结婚纪念日礼物，铂金戒指，150美元以内", "anniversary", "ring", "platinum", 150, "masculine"],
    ["th", "ของขวัญวันเกิดให้แม่ ต่างหูทอง ไม่เกิน 150 ดอลลาร์", "birthday", "earring", "yellow_gold", 150, "feminine"],
    ["id", "Hadiah ulang tahun untuk istri, kalung emas putih, maksimal 150 dolar", "birthday", "necklace", "white_gold", 150, "feminine"],
    ["es", "Regalo de cumpleaños para mi madre, pendientes de oro, hasta 150 dólares", "birthday", "earring", "yellow_gold", 150, "feminine"],
    ["fr", "Cadeau d'anniversaire pour mon mari, une montre en argent, 150 $ maximum", "birthday", "watch", "silver", 150, "masculine"],
    ["de", "Geburtstagsgeschenk für meine Mutter, Goldohrringe, bis 150 €", "birthday", "earring", "yellow_gold", 150, "feminine"],
  ] as const)("%s: %s", (lang, text, occasion, category, metal, usd, gender) => {
    const p = parseGiftText(text);
    expect(p).toMatchObject({ lang, occasion, categories: [category], metals: [metal], gender, giftSignal: true });
    expect(p.budget).toEqual({ usd, fromVnd: false });
  });
});

describe("occasions", () => {
  it.each([
    ["ja", ["誕生日", "結婚記念日", "結婚式", "卒業祝い", "母の日", "バレンタイン", "クリスマス", "特に理由はないけどサプライズ"]],
    ["ko", ["생일", "결혼기념일", "결혼식", "졸업", "어버이날", "발렌타인데이", "크리스마스", "그냥 깜짝 선물"]],
    ["zh", ["生日", "结婚纪念日", "婚礼", "毕业", "母亲节", "情人节", "圣诞节", "给她一个惊喜"]],
    ["th", ["วันเกิด", "ครบรอบแต่งงาน", "งานแต่งงาน", "รับปริญญา", "วันแม่", "วาเลนไทน์", "คริสต์มาส", "เซอร์ไพรส์"]],
    ["id", ["ulang tahun", "ulang tahun pernikahan", "pernikahan", "wisuda", "hari ibu", "valentine", "natal", "kejutan tanpa alasan"]],
    ["es", ["cumpleaños", "aniversario", "boda", "graduación", "día de la madre", "san valentín", "navidad", "sin motivo"]],
    ["fr", ["anniversaire", "anniversaire de mariage", "mariage", "remise des diplômes", "fête des mères", "saint-valentin", "noël", "sans raison"]],
    ["de", ["Geburtstag", "Hochzeitstag", "Hochzeitsgeschenk", "Schulabschluss", "Muttertag", "Valentinstag", "Weihnachtsgeschenk", "einfach so"]],
  ] as const)("%s", (_lang, [birthday, anniversary, wedding, graduation, mothersDay, valentine, christmas, justBecause]) => {
    expect(parseGiftText(birthday).occasion).toBe("birthday");
    expect(parseGiftText(anniversary).occasion).toBe("anniversary");
    expect(parseGiftText(wedding).occasion).toBe("wedding");
    expect(parseGiftText(graduation).occasion).toBe("graduation");
    expect(parseGiftText(mothersDay).occasion).toBe("holiday");
    expect(parseGiftText(valentine).occasion).toBe("holiday");
    expect(parseGiftText(christmas).occasion).toBe("holiday");
    expect(parseGiftText(justBecause).occasion).toBe("just_because");
  });
});

describe("categories, metals, styles and recipients", () => {
  it.each([
    ["ja", ["ピアス", "ネックレス", "指輪", "ブレスレット"], ["ローズゴールド", "ホワイトゴールド", "シルバー", "プラチナ", "K18"], ["シンプル", "クラシック", "存在感", "ボヘミアン"], ["妻", "姉", "彼女"], ["夫", "彼氏", "父"]],
    ["ko", ["귀걸이", "목걸이", "반지", "팔찌"], ["로즈 골드", "화이트골드", "실버", "백금", "골드"], ["미니멀", "클래식", "화려한", "보헤미안"], ["아내", "여동생", "여자친구"], ["남편", "남자친구", "아빠"]],
    ["zh", ["耳环", "项链", "戒指", "手链"], ["玫瑰金", "18K白金", "银饰", "铂金", "黄金"], ["简约", "经典", "醒目", "波西米亚"], ["老婆", "妹妹", "女朋友"], ["老公", "男朋友", "爸爸"]],
    ["th", ["ต่างหู", "สร้อยคอ", "แหวน", "สร้อยข้อมือ"], ["โรสโกลด์", "ทองคำขาว", "เงินแท้", "แพลทินัม", "ทองคำ"], ["มินิมอล", "คลาสสิก", "โดดเด่น", "โบฮีเมียน"], ["ภรรยา", "น้องสาว", "แฟนสาว"], ["สามี", "แฟนหนุ่ม", "พ่อ"]],
    ["id", ["anting", "kalung", "cincin", "gelang"], ["emas mawar", "emas putih", "perak", "platina", "emas"], ["minimalis", "klasik", "mencolok", "boho"], ["istri", "kakak perempuan", "ibu"], ["suami", "pacar laki-laki", "ayah"]],
    ["es", ["pendientes", "collar", "anillo", "pulsera"], ["oro rosa", "oro blanco", "plata", "platino", "oro"], ["minimalista", "clásico", "llamativo", "bohemio"], ["esposa", "hermana", "novia"], ["marido", "novio", "papá"]],
    ["fr", ["boucles d’oreilles", "collier", "bague", "bracelet"], ["or rose", "or blanc", "en argent", "platine", "en or"], ["minimaliste", "classique", "audacieux", "bohème"], ["femme", "sœur", "copine"], ["mari", "petit ami", "père"]],
    ["de", ["Ohrringe", "Halskette", "Ring", "Armband"], ["Roségold", "Weißgold", "Silber", "Platin", "Gold"], ["schlicht", "klassisch", "auffällig", "Boho"], ["Frau", "Schwester", "Freundin"], ["Mann", "Freund", "Vater"]],
  ] as const)("%s", (_lang, cats, metals, styles, fem, masc) => {
    expect(cats.map((c) => parseGiftText(c).categories)).toEqual([["earring"], ["necklace"], ["ring"], ["bracelet"]]);
    expect(metals.map((m) => parseGiftText(m).metals)).toEqual([["rose_gold"], ["white_gold"], ["silver"], ["platinum"], ["yellow_gold"]]);
    expect(styles.map((s) => parseGiftText(s).styles)).toEqual([["minimal"], ["classic"], ["statement"], ["boho"]]);
    for (const f of fem) expect(parseGiftText(f).gender, f).toBe("feminine");
    for (const m of masc) expect(parseGiftText(m).gender, m).toBe("masculine");
  });

  it("a friend is a gift signal without a gender", () => {
    for (const f of ["友達へ", "친구에게", "送朋友", "ให้เพื่อน", "untuk teman", "pour un ami"]) {
      expect(parseGiftText(f), f).toMatchObject({ giftSignal: true, gender: undefined });
    }
  });
});

describe("budgets", () => {
  it.each([
    ["150ドル", 150],
    ["予算は１５０ドルまで", 150],
    ["150달러", 150],
    ["예산 200 이하", 200],
    ["150美元", 150],
    ["预算300以内", 300],
    ["150 ดอลลาร์", 150],
    ["ไม่เกิน 200", 200],
    ["150 dolar", 150],
    ["maksimal $120", 120],
    ["150 dólares", 150],
    ["hasta 90", 90],
    ["150 dollars", 150],
    ["150 $", 150],
    ["moins de 80 €", 80],
    ["150 Dollar", 150],
    ["150 €", 150],
    ["bis 1.200 Euro", 1200],
    ["höchstens 99,50 €", 99.5],
  ])("%s → $%d", (text, usd) => {
    expect(parseBudgetUsd(text)?.usd).toBe(usd);
  });
});

describe("no false positives", () => {
  it("money, particles and look-alike words are not metals, categories or recipients", () => {
    // Japanese / Chinese 金 alone is money; 銀行 / 银行 is a bank; Korean 은 is a particle; Thai เงิน is money.
    expect(parseGiftText("お金がないので安いものを").metals).toEqual([]);
    expect(parseGiftText("预算金额不多").metals).toEqual([]);
    expect(parseGiftText("銀行で払います").metals).toEqual([]);
    expect(parseGiftText("엄마는 지금 금요일에 와요").metals).toEqual([]);
    expect(parseGiftText("มีเงินไม่มาก").metals).toEqual([]);
    // French "argent" (money) and "or" (but / gold) only count with en / massif / jaune …
    expect(parseGiftText("je n'ai pas beaucoup d'argent, or c'est pour ma mère").metals).toEqual([]);
    // イヤリング ends in リング but is not a ring; an Armbanduhr is a watch, not a bracelet.
    expect(parseGiftText("イヤリング").categories).toEqual(["earring"]);
    expect(parseGiftText("eine Armbanduhr").categories).toEqual(["watch"]);
    // 大丈夫 holds 夫, その他 holds 他; Spanish "son" / "he" and German "man" are not English pronouns.
    expect(parseGiftText("大丈夫です、その他の色も").gender).toBeUndefined();
    expect(parseGiftText("Son para mi hermana, he pensado en algo").gender).toBe("feminine");
    expect(parseGiftText("Was kann man meiner Mutter schenken?").gender).toBe("feminine");
    // A date or a quantity is not a budget.
    expect(parseBudgetUsd("12月まで")).toBeUndefined();
    expect(parseBudgetUsd("3개 이상")).toBeUndefined();
  });

  it("plain chat in another language is no gift signal", () => {
    for (const t of ["今日はいい天気ですね", "오늘 날씨 좋네요", "今天天气很好", "วันนี้อากาศดี", "Cuaca hari ini bagus", "Hace buen tiempo hoy", "Il fait beau aujourd'hui", "Das Wetter ist schön"]) {
      expect(parseGiftText(t).giftSignal, t).toBe(false);
    }
  });
});

describe("the fallback answer uses what was parsed, in the shopper's language", () => {
  it.each([
    ["ja", "母の誕生日に金のピアス、150ドル以内"],
    ["ko", "엄마 생일 선물로 귀걸이, 150달러 이하"],
    ["zh", "给妈妈的生日礼物，金色项链，150美元以内"],
    ["th", "ของขวัญวันเกิดให้แม่ ต่างหูทอง ไม่เกิน 150 ดอลลาร์"],
    ["id", "Hadiah ulang tahun untuk ibu, anting emas, maksimal 150 dolar"],
    ["es", "Regalo de cumpleaños para mi madre, pendientes de oro, hasta 150 dólares"],
    ["fr", "Cadeau d'anniversaire pour ma mère, boucles d'oreilles en or, 150 $ maximum"],
    ["de", "Geburtstagsgeschenk für meine Mutter, Ohrringe aus Gold, bis 150 €"],
  ] as const)("%s", (lang, text) => {
    const a = fallbackAnswer(user(text), catalog);
    expect(a.brief).toMatchObject({ occasion: "birthday", budgetMax: 150, genderPresentation: "feminine" });
    // Budget and occasion were understood: no "assumed" notes.
    expect(a.notes).toEqual([]);
    expect(a.text).toBe(fallbackCopy(lang).answer({ count: a.suggestions.length, occasion: "birthday", budgetMax: 150, currency: a.brief!.currency, tryOn: true }));
  });

  it("answers in English for a language the widget does not offer", () => {
    const a = fallbackAnswer(user("Quero um presente de aniversário para a minha mãe, até $150"), catalog);
    expect(a.text).toMatch(/^Here are \d ideas/);
  });
});

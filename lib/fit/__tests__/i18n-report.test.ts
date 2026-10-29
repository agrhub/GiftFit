/**
 * A22: the Fit Report in the giver's language (lib/i18n/report). Templates (reasons, cautions, taste
 * summary) are written in each of the ten UI locales and pass every guard; the no-try-on guard catches
 * undertone / skin / face-shape / estimate / try-on claims in every language, without flagging ordinary
 * jewelry words; the model is asked for the giver's language and a text in the wrong script is replaced.
 */
import { describe, expect, it } from "vitest";
import { LOCALES, type Locale, formatMoney } from "@/lib/i18n";
import { REPORT_CATALOGS } from "@/lib/i18n/report";
import { en } from "@/lib/i18n/report/en";
import { type ExplainClient, type ExplainRequest, NO_TRYON_WORDS, checkText, explainFit, localizeSystem, validateExplanation, wordCount } from "../explain";
import { NO_TRYON_WORDS_BY_LOCALE, mentionsPhoto, mentionsTryOn } from "../guardWords";
import { fitScore, scoreSkus } from "../score";
import { buildTasteInput, checkTasteText, templateTasteSummary } from "../taste";
import { fakeRules, profile, request, sku } from "./fixtures";

const NON_EN = LOCALES.filter((l): l is Exclude<Locale, "en"> => l !== "en");

const tried = sku("tried", { category: "earring", price: 200, attributes: { metal: "yellow_gold", earring_shape: "drop_teardrop" } });
const untried = sku("untried", { category: "earring", price: 200, attributes: { metal: "yellow_gold", earring_shape: "drop_teardrop", tryon_eligible: false } });
const plain = sku("plain", { category: "earring", price: 340, attributes: { metal: "white_gold", earring_shape: "stud_statement", occasions: [] } });
const neck = sku("neck", { category: "necklace", price: 120, attributes: { category: "necklace", metal: "rose_gold", occasions: [] } });
const SKUS = [tried, untried, plain, neck];
// Low confidence and a Heart face: every metal, confidence and style template shows up somewhere.
const P = profile({ undertoneEstimate: "warm", undertoneConfidence: 0.4, faceShape: "Heart", heartedSkuIds: ["tried", "untried"] });
const REQ = request({ shortlistIds: SKUS.map((s) => s.id), budgetMin: 150, budgetMax: 300 });

const mixed = (locale: Locale) => scoreSkus(P, SKUS, REQ, fakeRules, { noTryOnIds: new Set(["untried"]), locale });
const noTryOn = (locale: Locale) => scoreSkus(P, SKUS, REQ, fakeRules, { noTryOn: true, locale });
const texts = (r: { reasons: string[]; caution?: string }) => [...r.reasons, r.caution ?? ""];

/** English giveaway words for the Latin-script locales (loanwords like "budget" are fine in fr and de). */
const ENGLISH = /\b(they|their|your|the|hearted|piece|within|suits|tried|giftable|shortlist|styling|stylists)\b/i;
/** Latin letters left in a CJK / Thai text once the allowed tokens are removed. */
const latinIn = (s: string) => s.replace(/US\$|\bAI\b|\bTA\b/g, "").match(/[A-Za-z]{2,}/g) ?? [];
const noEnglish = (locale: Locale, s: string) => (/^(ja|zh|ko|th)$/.test(locale) ? latinIn(s) : (s.match(ENGLISH) ?? []));

describe("report catalogs", () => {
  it("every locale defines every key with the same {placeholders}", () => {
    const ph = (s: string) => new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
    for (const l of LOCALES) {
      const cat = REPORT_CATALOGS[l];
      expect(Object.keys(cat).sort(), l).toEqual(Object.keys(en).sort());
      for (const k of Object.keys(en) as (keyof typeof en)[]) {
        // `aFace` ("an oval face") is an English helper: other languages use `face` instead.
        const want = ph(en[k]);
        const allowed = new Set([...want, ...(want.has("aFace") ? ["face"] : [])]);
        const got = ph(cat[k]);
        for (const p of want) if (p !== "aFace") expect(got.has(p), `${l} ${k} lacks {${p}}`).toBe(true);
        for (const p of got) expect(allowed.has(p), `${l} ${k} has unknown {${p}}`).toBe(true);
      }
    }
  });

  it("English output is unchanged (the engine's original sentences)", () => {
    const s = mixed("en");
    expect(s.find((x) => x.skuId === "tried")!.reasons).toContain("They hearted this piece during their try-on.");
    const one = fitScore(P, plain, REQ, fakeRules, {});
    expect(one.signals.find((g) => g.factor === "budget")!.text).toBe("$40 over your $150–$300 budget.");
    expect(one.signals.find((g) => g.factor === "style")!.text).toBe("Stylists often steer heart-shaped face shapes away from statement studs.");
    expect(fitScore(null, neck, request({ occasion: "birthday", budgetMin: 0, budgetMax: 300 }), fakeRules).reasons).toEqual(["Within your $300 budget.", "Not tagged for a birthday, but still giftable."]);
  });
});

describe("templates in every locale", () => {
  it.each(NON_EN)("%s: reasons and cautions are localized, short, and free of English", (locale) => {
    for (const r of [...mixed(locale), ...noTryOn(locale)]) {
      for (const t of texts(r)) {
        expect(noEnglish(locale, t), `${locale}: ${t}`).toEqual([]);
        expect(wordCount(t), `${locale}: ${t}`).toBeLessThanOrEqual(locale === "vi" ? 30 : 20);
        expect(checkText(t, r.skuId, { allowedIds: SKUS.map((s) => s.id), locale }), `${locale}: ${t}`).toEqual([]);
      }
    }
  });

  it.each(LOCALES)("%s: an untried piece (mixed set) and a whole no-try-on report never claim undertone, face shape, an estimate or a try-on", (locale) => {
    const u = mixed(locale).find((r) => r.skuId === "untried")!;
    expect(u.tryOn).toBe(false);
    for (const t of texts(u)) {
      expect(mentionsTryOn(t), `${locale}: ${t}`).toBe(false);
      expect(checkText(t, "untried", { allowedIds: ["untried"], noTryOn: true, locale }), `${locale}: ${t}`).toEqual([]);
    }
    for (const r of noTryOn(locale)) for (const t of texts(r)) expect(mentionsTryOn(t), `${locale}: ${t}`).toBe(false);
  });

  it.each(NON_EN)("%s: the tried piece keeps its undertone / face-shape template (as in English)", (locale) => {
    const t = mixed(locale).find((r) => r.skuId === "tried")!;
    expect(texts(t).some((x) => NO_TRYON_WORDS_BY_LOCALE[locale].test(x)), texts(t).join(" | ")).toBe(true);
  });

  it("prices use the locale's Intl format", () => {
    const req = request({ occasion: "birthday", budgetMin: 0, budgetMax: 300 });
    for (const locale of NON_EN) {
      const r = fitScore(null, neck, req, fakeRules, { locale });
      expect(r.reasons.join(" "), locale).toContain(formatMoney(locale, 300, "USD"));
    }
    expect(fitScore(null, neck, req, fakeRules, { locale: "de" }).reasons[0]).toBe(`Innerhalb deines Budgets von ${formatMoney("de", 300, "USD")}.`);
    expect(formatMoney("de", 300, "USD")).toMatch(/^300\s\$$/);
    expect(fitScore(null, neck, req, fakeRules, { locale: "ja" }).reasons[0]).toBe("ご予算$300の範囲内です。");
  });

  it.each(LOCALES)("%s: the taste summary template is localized and passes the taste checks", (locale) => {
    const input = buildTasteInput([{ sku: tried, metal: "yellow_gold" }, { sku: neck, metal: "rose_gold" }], 6, 1);
    const none = buildTasteInput([], 6, 1);
    for (const s of [templateTasteSummary(input, { locale }), templateTasteSummary(none, { locale, noTryOn: true }), templateTasteSummary(none, { locale })]) {
      expect(checkTasteText(s, [], locale), `${locale}: ${s}`).toEqual([]);
      if (locale !== "en") expect(noEnglish(locale, s), `${locale}: ${s}`).toEqual([]);
    }
    if (locale === "en") expect(templateTasteSummary(input)).toBe("They hearted 2 of 6 pieces. Their hearts lean classic, mostly in yellow gold and rose gold, with a liking for drop earrings and pendants. They also loved a style but wished for another metal.");
  });
});

/** A sentence per locale claiming undertone / skin, face shape, an estimate and a try-on. */
const CLAIMS: Record<Locale, string[]> = {
  en: ["Their warm undertone estimate suits this piece.", "Flatters their face shape.", "They tried it on and loved it."],
  vi: ["Tông da ấm của họ rất hợp với món này.", "Hợp với khuôn mặt trái xoan của họ.", "Theo ước tính, món này rất hợp.", "Họ đã thử món này và rất thích."],
  ja: ["お相手の肌の色にこのアイテムが似合います。", "顔型に合うデザインです。", "推定ではよく似合います。", "試着で気に入っていました。"],
  ko: ["받는 분의 피부 톤에 잘 어울려요.", "얼굴형에 잘 어울려요.", "추정으로는 잘 어울려요.", "착용해 보니 잘 어울렸어요.", "웜톤에 잘 맞아요."],
  zh: ["这件饰品很适合 TA 的肤色。", "适合 TA 的脸型。", "根据估计很合适。", "TA 试戴后很喜欢。"],
  th: ["ชิ้นนี้เข้ากับสีผิวของผู้รับ", "เหมาะกับรูปหน้าของผู้รับ", "จากการประเมิน ชิ้นนี้เหมาะมาก", "ผู้รับลองสวมแล้วชอบมาก"],
  id: ["Perhiasan ini cocok dengan warna kulit penerima.", "Cocok untuk bentuk wajah penerima.", "Menurut perkiraan, ini cocok.", "Penerima sudah mencobanya dan suka."],
  es: ["Esta pieza favorece su tono de piel.", "Favorece la forma del rostro.", "Según la estimación, encaja bien.", "Se la probó y le encantó."],
  fr: ["Cette pièce flatte son teint.", "Flatte la forme du visage.", "D'après l'estimation, elle convient.", "La personne l'a essayée et l'a adorée."],
  de: ["Dieses Stück passt zu ihrem Hautton.", "Passt gut zur Gesichtsform.", "Laut Schätzung passt es gut.", "Die Person hat es anprobiert und mochte es."],
};

/** Ordinary jewelry sentences that share letters with the guard words (none may be flagged). */
const ORDINARY: Record<Locale, string[]> = {
  en: ["A natural fit for an anniversary.", "Within your $300 budget."],
  vi: ["Mặt dây chuyền vàng rất hợp dịp kỷ niệm.", "Đồng hồ dây da cổ điển, dễ phối đồ.", "Phong cách tối giản chịu ảnh hưởng cổ điển."],
  ja: ["華奢なチェーンが記念日にぴったりです。", "ご予算の範囲内です。"],
  ko: ["착용감이 편안한 귀걸이예요.", "예산 안에 들어와요."],
  zh: ["金色调的耳环很优雅。", "在你的预算之内。"],
  th: ["เหมาะสำหรับฉลองวันครบรอบ", "อยู่ในงบประมาณของคุณ", "ตัวเรือนผิวเงางาม"],
  id: ["Gelang kulit dengan gaya klasik.", "Cara manis untuk merayakan hari jadi."],
  es: ["Pulsera de piel con cierre dorado.", "Una pieza cara pero muy especial.", "Reloj a prueba de agua."],
  fr: ["Un style haut de gamme.", "Idéal pour un anniversaire."],
  de: ["Ein geschätztes Geschenk zum Jahrestag.", "Passt gut zum Anlass."],
};

describe("the no-try-on guard in every language", () => {
  it.each(LOCALES)("%s: catches undertone, skin, face-shape, estimate and try-on claims", (locale) => {
    for (const s of CLAIMS[locale]) expect(mentionsTryOn(s), `${locale}: ${s}`).toBe(true);
  });

  it.each(LOCALES)("%s: leaves ordinary jewelry words alone", (locale) => {
    for (const s of ORDINARY[locale]) {
      expect(mentionsTryOn(s), `${locale}: ${s}`).toBe(false);
      expect(mentionsPhoto(s), `${locale}: ${s}`).toBe(false);
    }
  });

  it("the English list is the engine's original", () => {
    expect(NO_TRYON_WORDS.source).toBe(NO_TRYON_WORDS_BY_LOCALE.en.source);
  });

  it.each(LOCALES)("%s: a leaking model sentence for the untried piece is replaced by that locale's template; the tried piece keeps it", (locale) => {
    const s = mixed(locale);
    const tmpl = Object.fromEntries(s.map((r) => [r.skuId, r]));
    const claim = CLAIMS[locale][0];
    const raw = { items: s.map((x) => ({ skuId: x.skuId, reason1: claim, reason2: CLAIMS[locale][1], caution: CLAIMS[locale][CLAIMS[locale].length - 1] })) };
    const v = validateExplanation(raw, s, { locale });
    const u = v.results.find((r) => r.skuId === "untried")!;
    expect(u.reasons).toEqual(tmpl.untried.reasons);
    expect(u.caution).toBe(tmpl.untried.caution);
    for (const t of texts(u)) expect(mentionsTryOn(t)).toBe(false);
    expect(v.issues).toContainEqual(expect.objectContaining({ skuId: "untried", code: "leak_tryon" }));
    expect(v.results.find((r) => r.skuId === "tried")!.reasons[0]).toBe(claim);
  });

  it.each(LOCALES)("%s: a whole no-try-on report replaces every claim", (locale) => {
    const s = noTryOn(locale);
    const raw = { items: s.map((x) => ({ skuId: x.skuId, reason1: CLAIMS[locale][0], reason2: CLAIMS[locale][1], caution: CLAIMS[locale][2] ?? CLAIMS[locale][0] })) };
    const v = validateExplanation(raw, s, { noTryOn: true, locale });
    for (const r of v.results) for (const t of texts(r)) expect(mentionsTryOn(t), `${locale}: ${t}`).toBe(false);
  });

  it("a claim in another language than the report's is still caught", () => {
    const s = mixed("ja");
    const raw = { items: s.map((x) => ({ skuId: x.skuId, reason1: "Tông da ấm của họ rất hợp.", reason2: "ご予算の範囲内です。", caution: "ご予算の範囲内です。" })) };
    const v = validateExplanation(raw, s, { locale: "ja" });
    expect(v.issues).toContainEqual(expect.objectContaining({ skuId: "untried", code: "leak_tryon" }));
  });
});

describe("the model writes in the giver's language", () => {
  it("explainFit sends the language; English text for a Japanese report falls back to the Japanese template", async () => {
    const s = mixed("ja").map((x) => ({ ...x, category: "earring" as const }));
    const calls: ExplainRequest[] = [];
    const client: ExplainClient = {
      model: "mock",
      explain: async (req) => {
        calls.push(req);
        return { items: req.items.map((i) => ({ skuId: i.skuId, reason1: "ご予算の範囲内です。", reason2: "This piece fits the occasion.", caution: "サイズをご確認ください。" })) };
      },
    };
    const out = await explainFit(s, { client, locale: "ja" });
    expect(calls[0].language).toEqual({ code: "ja", name: "Japanese" });
    for (const it of calls[0].items) expect(Object.keys(it)).not.toContain("language");
    const first = out.results[0];
    expect(first.reasons[0]).toBe("ご予算の範囲内です。");
    expect(first.reasons[1]).toBe(s[0].reasons[1]);
    expect(out.issues).toContainEqual(expect.objectContaining({ code: "wrong_language", field: "reason2" }));
    // English requests are unchanged: no language field.
    calls.length = 0;
    await explainFit(mixed("en").map((x) => ({ ...x, category: "earring" as const })), { client, locale: "en" });
    expect(calls[0].language).toBeUndefined();
  });

  it("the system prompt names the language and code, keeps the JSON shape, and budgets characters for ja / zh / th", () => {
    const sys = "Write two reasons, each at most 20 words, in plain English.";
    expect(localizeSystem(sys)).toBe(sys);
    const vi = localizeSystem(sys, { code: "vi", name: "Vietnamese" });
    expect(vi).toContain("in plain Vietnamese");
    expect(vi).toContain('"vi"');
    expect(vi).toMatch(/JSON keys/);
    expect(localizeSystem(sys, { code: "th", name: "Thai" })).toContain("about 100 characters");
    expect(localizeSystem(sys, { code: "ja", name: "Japanese" })).toContain("about 50 characters");
  });

  it("Vietnamese gets more whitespace tokens (one per syllable) before 'too_long'", () => {
    const s = "Món này rất hợp với phong cách tối giản mà người nhận đã thả tim, và nằm trong ngân sách của bạn.";
    expect(wordCount(s)).toBeGreaterThan(20);
    expect(checkText(s, "x", { allowedIds: ["x"], locale: "vi" })).toEqual([]);
    expect(checkText(s, "x", { allowedIds: ["x"] })).toContain("too_long");
  });
});

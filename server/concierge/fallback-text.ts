/**
 * Copy of the longer deterministic fallback answer (fallback.ts fallbackAnswer) in every widget language
 * (owner: A17, ADR-057; en/vi are A7's original text). Any other language gets English. Category, metal,
 * occasion and button names come from the widget catalogs so the text matches the cards and buttons.
 * The ja, ko, zh, th, id, es, fr and de lines are machine-translated, not yet reviewed by native speakers.
 */
import type { StyleFamily } from "@/server/contracts/api";
import type { JewelryCategory, Metal, Occasion } from "@/server/contracts/giftfit";
import { formatMoney, INTL_LOCALES, t, type Locale, type MessageKey } from "@/server/i18n";

export interface ReasonInput {
  style: string;
  category: JewelryCategory;
  occasion: Occasion;
  metals: Metal[];
}

export interface AnswerInput {
  count: number;
  occasion: Occasion;
  budgetMax: number;
  currency: string;
  tryOn: boolean;
}

interface FallbackCopy {
  budgetAssumed(usd: number): string;
  converted(vndPerUsd: number): string;
  occasionAssumed: string;
  noBudget: string;
  reason(i: ReasonInput): string;
  answer(i: AnswerInput): string;
}

const STYLE_VI: Record<string, string> = { classic: "cổ điển", minimal: "tối giản", statement: "nổi bật", modern: "hiện đại", boho: "boho", vintage: "vintage", sport: "thể thao" };
const CATEGORY_VI: Record<JewelryCategory, string> = { earring: "bông tai", necklace: "dây chuyền", ring: "nhẫn", bracelet: "vòng tay", watch: "đồng hồ" };
const OCCASION_EN: Record<Occasion, string> = { anniversary: "anniversary", birthday: "birthday", wedding: "wedding", holiday: "holiday", graduation: "graduation", thank_you: "thank-you", just_because: "just-because" };
const OCCASION_VI: Record<Occasion, string> = { anniversary: "kỷ niệm", birthday: "sinh nhật", wedding: "đám cưới", holiday: "dịp lễ", graduation: "tốt nghiệp", thank_you: "cảm ơn", just_because: "bất ngờ" };
const METAL_EN: Record<Metal, string> = { yellow_gold: "yellow gold", rose_gold: "rose gold", white_gold: "white gold", silver: "silver", platinum: "platinum", mixed_two_tone: "two-tone" };
const METAL_VI: Record<Metal, string> = { yellow_gold: "vàng", rose_gold: "vàng hồng", white_gold: "vàng trắng", silver: "bạc", platinum: "bạch kim", mixed_two_tone: "hai màu" };

type OtherLocale = Exclude<Locale, "en" | "vi">;

/** Style names for the machine-translated locales (the catalog has no style keys). */
const STYLES: Record<OtherLocale, Record<StyleFamily, string>> = {
  ja: { classic: "クラシック", minimal: "ミニマル", statement: "存在感のある", modern: "モダン", boho: "ボヘミアン", vintage: "ヴィンテージ", sport: "スポーティ" },
  ko: { classic: "클래식", minimal: "미니멀", statement: "포인트", modern: "모던", boho: "보헤미안", vintage: "빈티지", sport: "스포티" },
  zh: { classic: "经典", minimal: "简约", statement: "醒目", modern: "现代", boho: "波西米亚", vintage: "复古", sport: "运动" },
  th: { classic: "คลาสสิก", minimal: "มินิมอล", statement: "โดดเด่น", modern: "โมเดิร์น", boho: "โบฮีเมียน", vintage: "วินเทจ", sport: "สปอร์ต" },
  id: { classic: "klasik", minimal: "minimalis", statement: "mencolok", modern: "modern", boho: "boho", vintage: "vintage", sport: "sporty" },
  es: { classic: "clásico", minimal: "minimalista", statement: "llamativo", modern: "moderno", boho: "boho", vintage: "vintage", sport: "deportivo" },
  fr: { classic: "classique", minimal: "minimaliste", statement: "affirmé", modern: "moderne", boho: "bohème", vintage: "vintage", sport: "sportif" },
  de: { classic: "klassisch", minimal: "minimalistisch", statement: "auffällig", modern: "modern", boho: "Boho", vintage: "Vintage", sport: "sportlich" },
};

const OR: Record<OtherLocale, string> = { ja: "または", ko: " 또는 ", zh: "或", th: " หรือ ", id: " atau ", es: " o ", fr: " ou ", de: " oder " };
/** Locales whose catalog labels are capitalised nouns that read lower-case inside a sentence. */
const LOWER_IN_SENTENCE = new Set<Locale>(["es", "fr", "id"]);

function labels(l: OtherLocale) {
  const low = (s: string) => (LOWER_IN_SENTENCE.has(l) ? s.toLocaleLowerCase(INTL_LOCALES[l]) : s);
  return {
    occasion: (o: Occasion) => t(l, `occasion.${o}` as MessageKey),
    category: (c: JewelryCategory) => t(l, `category.${c}` as MessageKey),
    metals: (ms: Metal[]) => ms.map((m) => low(t(l, `metal.${m}` as MessageKey))).join(OR[l]),
    style: (s: string) => STYLES[l][s as StyleFamily] ?? s,
    help: t(l, "chat.helpChoose"),
    use: t(l, "chat.useBrief"),
    money: (n: number, currency: string) => formatMoney(l, n, currency),
    rate: (n: number) => n.toLocaleString(INTL_LOCALES[l]),
  };
}

function other(l: OtherLocale, copy: (L: ReturnType<typeof labels>) => FallbackCopy): FallbackCopy {
  return copy(labels(l));
}

const COPY: Record<Locale, FallbackCopy> = {
  en: {
    budgetAssumed: (usd) => `Budget assumed: $${usd}`,
    converted: (r) => `Converted at about ${r.toLocaleString("en-US")} VND per USD`,
    occasionAssumed: "Occasion not given: just because",
    noBudget: "I couldn't find a design within that budget. Could you raise it a little?",
    reason: (i) => `A ${i.style} ${i.category} that suits a ${OCCASION_EN[i.occasion]} gift, in ${i.metals.map((m) => METAL_EN[m]).join(" or ")} within your budget.`,
    answer: (i) =>
      `Here are ${i.count} ideas for a ${OCCASION_EN[i.occasion]} gift within $${i.budgetMax}. I've drafted a "Help me choose" brief: GiftFit will pick 6–8 pieces within your budget for them to ${i.tryOn ? "try on" : "look through and heart"}. Review it and tap "Use this brief".`,
  },
  vi: {
    budgetAssumed: (usd) => `Ngân sách tạm tính: $${usd}`,
    converted: (r) => `Đã quy đổi khoảng ${r.toLocaleString("vi-VN")}đ = 1 USD`,
    occasionAssumed: "Dịp: chưa rõ, chọn 'bất ngờ'",
    noBudget: "Mình chưa tìm thấy mẫu nào trong ngân sách này. Bạn thử tăng ngân sách một chút nhé?",
    reason: (i) => `Mẫu ${CATEGORY_VI[i.category]} phong cách ${STYLE_VI[i.style] ?? i.style}, có ${i.metals.map((m) => METAL_VI[m]).join(" và ")} trong ngân sách.`,
    answer: (i) =>
      `Đây là ${i.count} gợi ý cho dịp ${OCCASION_VI[i.occasion]}, trong ngân sách $${i.budgetMax}. Mình đã soạn sẵn yêu cầu "Giúp tôi chọn": GiftFit sẽ chọn 6–8 mẫu trong ngân sách để người nhận ${i.tryOn ? "thử" : "xem và thả tim"}. Bạn xem lại rồi bấm "Dùng yêu cầu này" nhé.`,
  },
  ja: other("ja", (L) => ({
    budgetAssumed: (usd) => `ご予算は仮に$${usd}としました`,
    converted: (r) => `約${L.rate(r)} VND = 1 USDで換算しました`,
    occasionAssumed: `機会の指定がないため「${L.occasion("just_because")}」にしました`,
    noBudget: "このご予算内ではデザインが見つかりませんでした。少しだけ予算を上げられますか？",
    reason: (i) => `${L.style(i.style)}な${L.category(i.category)}。${L.metals(i.metals)}でご予算内です。`,
    answer: (i) =>
      `ご予算${L.money(i.budgetMax, i.currency)}以内で、${i.count}つのアイデアをご用意しました（${L.occasion(i.occasion)}）。「${L.help}」のギフト内容も作成しました。GiftFitがご予算内で6〜8点を選び、相手の方が${i.tryOn ? "試着できます" : "写真を見てお気に入りにハートを付けられます"}。確認して「${L.use}」を押してください。`,
  })),
  ko: other("ko", (L) => ({
    budgetAssumed: (usd) => `예산을 $${usd}(으)로 가정했어요`,
    converted: (r) => `약 ${L.rate(r)} VND = 1 USD로 환산했어요`,
    occasionAssumed: `특별한 날이 정해지지 않아 "${L.occasion("just_because")}"(으)로 했어요`,
    noBudget: "그 예산 안에서는 디자인을 찾지 못했어요. 예산을 조금 늘릴 수 있을까요?",
    reason: (i) => `${L.style(i.style)} 스타일의 ${L.category(i.category)}. ${L.metals(i.metals)}(으)로 예산 안에 있어요.`,
    answer: (i) =>
      `${L.money(i.budgetMax, i.currency)} 이내의 "${L.occasion(i.occasion)}" 선물 아이디어 ${i.count}개예요. "${L.help}" 선물 요청서도 작성했어요. GiftFit이 예산 안에서 6~8개를 골라 받는 분이 ${i.tryOn ? "착용해 볼 수 있어요" : "둘러보고 하트를 누를 수 있어요"}. 확인하고 "${L.use}" 버튼을 눌러 주세요.`,
  })),
  zh: other("zh", (L) => ({
    budgetAssumed: (usd) => `预算暂按 $${usd} 计算`,
    converted: (r) => `按约 ${L.rate(r)} 越南盾 = 1 美元换算`,
    occasionAssumed: `未提供场合，按“${L.occasion("just_because")}”处理`,
    noBudget: "在这个预算内没有找到合适的款式。可以稍微提高一点预算吗？",
    reason: (i) => `${L.style(i.style)}风格的${L.category(i.category)}，有${L.metals(i.metals)}可选，在预算之内。`,
    answer: (i) =>
      `这是${i.count}个“${L.occasion(i.occasion)}”礼物建议，预算在${L.money(i.budgetMax, i.currency)}以内。我已拟好“${L.help}”的礼物需求：GiftFit 会在预算内挑选 6–8 件，让对方${i.tryOn ? "试戴" : "浏览并给喜欢的款式点亮爱心"}。请检查后点击“${L.use}”。`,
  })),
  th: other("th", (L) => ({
    budgetAssumed: (usd) => `สมมติงบประมาณ $${usd}`,
    converted: (r) => `แปลงที่ประมาณ ${L.rate(r)} VND ต่อ 1 USD`,
    occasionAssumed: `ไม่ได้ระบุโอกาส จึงใช้ "${L.occasion("just_because")}"`,
    noBudget: "ไม่พบแบบที่อยู่ในงบประมาณนี้ เพิ่มงบอีกนิดได้ไหม",
    reason: (i) => `${L.category(i.category)}สไตล์${L.style(i.style)} มี${L.metals(i.metals)} อยู่ในงบประมาณ`,
    answer: (i) =>
      `นี่คือ ${i.count} ไอเดียของขวัญสำหรับ "${L.occasion(i.occasion)}" ภายในงบ ${L.money(i.budgetMax, i.currency)} ฉันร่างสรุปแบบ "${L.help}" ไว้แล้ว: GiftFit จะเลือก 6–8 ชิ้นในงบของคุณให้ผู้รับ${i.tryOn ? "ลองสวม" : "ดูและกดหัวใจ"} ตรวจดูแล้วแตะ "${L.use}"`,
  })),
  id: other("id", (L) => ({
    budgetAssumed: (usd) => `Anggaran diasumsikan $${usd}`,
    converted: (r) => `Dikonversi sekitar ${L.rate(r)} VND per USD`,
    occasionAssumed: `Acara tidak disebutkan: "${L.occasion("just_because")}"`,
    noBudget: "Saya tidak menemukan desain dalam anggaran itu. Bisakah dinaikkan sedikit?",
    reason: (i) => `${L.category(i.category)} bergaya ${L.style(i.style)}, tersedia dalam ${L.metals(i.metals)} sesuai anggaran Anda.`,
    answer: (i) =>
      `Berikut ${i.count} ide hadiah untuk "${L.occasion(i.occasion)}" dengan anggaran hingga ${L.money(i.budgetMax, i.currency)}. Saya sudah menyusun ringkasan "${L.help}": GiftFit akan memilih 6–8 perhiasan sesuai anggaran untuk ${i.tryOn ? "dicoba" : "dilihat dan diberi hati"} oleh penerima. Periksa lalu ketuk "${L.use}".`,
  })),
  es: other("es", (L) => ({
    budgetAssumed: (usd) => `Presupuesto supuesto: $${usd}`,
    converted: (r) => `Convertido a unos ${L.rate(r)} VND por USD`,
    occasionAssumed: `Ocasión no indicada: «${L.occasion("just_because")}»`,
    noBudget: "No encontré ningún diseño dentro de ese presupuesto. ¿Podrías ampliarlo un poco?",
    reason: (i) => `${L.category(i.category)} de estilo ${L.style(i.style)}, en ${L.metals(i.metals)}, dentro de tu presupuesto.`,
    answer: (i) =>
      `Aquí tienes ${i.count} ideas para «${L.occasion(i.occasion)}», con un presupuesto de hasta ${L.money(i.budgetMax, i.currency)}. He preparado un resumen «${L.help}»: GiftFit elegirá 6–8 piezas dentro de tu presupuesto para que la otra persona ${i.tryOn ? "se las pruebe" : "las vea y marque sus favoritas"}. Revísalo y toca «${L.use}».`,
  })),
  fr: other("fr", (L) => ({
    budgetAssumed: (usd) => `Budget supposé : ${usd} $`,
    converted: (r) => `Converti à environ ${L.rate(r)} VND pour 1 USD`,
    occasionAssumed: `Occasion non précisée : « ${L.occasion("just_because")} »`,
    noBudget: "Je n'ai trouvé aucun modèle dans ce budget. Pourriez-vous l'augmenter un peu ?",
    reason: (i) => `${L.category(i.category)} au style ${L.style(i.style)}, en ${L.metals(i.metals)}, dans votre budget.`,
    answer: (i) =>
      `Voici ${i.count} idées pour « ${L.occasion(i.occasion)} », avec un budget de ${L.money(i.budgetMax, i.currency)} maximum. J'ai préparé un brief « ${L.help} » : GiftFit choisira 6 à 8 pièces dans votre budget pour que la personne ${i.tryOn ? "les essaie" : "les parcoure et mette un cœur sur ses préférées"}. Vérifiez-le, puis touchez « ${L.use} ».`,
  })),
  de: other("de", (L) => ({
    budgetAssumed: (usd) => `Angenommenes Budget: $${usd}`,
    converted: (r) => `Umgerechnet mit etwa ${L.rate(r)} VND pro USD`,
    occasionAssumed: `Kein Anlass genannt: „${L.occasion("just_because")}“`,
    noBudget: "Ich habe kein Modell in diesem Budget gefunden. Kannst du es etwas erhöhen?",
    reason: (i) => `${L.category(i.category)} im Stil „${L.style(i.style)}“, in ${L.metals(i.metals)}, im Rahmen deines Budgets.`,
    answer: (i) =>
      `Hier sind ${i.count} Ideen für den Anlass „${L.occasion(i.occasion)}“ bis ${L.money(i.budgetMax, i.currency)}. Ich habe einen Plan „${L.help}“ vorbereitet: GiftFit wählt 6–8 Stücke in deinem Budget, die die beschenkte Person ${i.tryOn ? "anprobieren" : "ansehen und mit Herzen markieren"} kann. Prüf ihn und tippe auf „${L.use}“.`,
  })),
};

/** The fallback copy for a widget locale (callers map any other language to English first). */
export function fallbackCopy(l: Locale): FallbackCopy {
  return COPY[l];
}

const GENERIC_REASON: Record<Locale, (category: string, withinBudget: boolean) => string> = {
  en: (c, b) => `A ${c ? `${c} ` : ""}pick from this store${b ? ", within your budget" : ""}.`,
  vi: (c, b) => `Một lựa chọn${c ? ` ${c}` : ""} của cửa hàng${b ? ", trong ngân sách" : ""}.`,
  ja: (c, b) => `このストアのおすすめ${c ? `（${c}）` : ""}${b ? "。ご予算内です" : ""}。`,
  ko: (c, b) => `이 매장의 추천 상품${c ? `(${c})` : ""}${b ? ", 예산 안이에요" : ""}.`,
  zh: (c, b) => `本店推荐${c ? `（${c}）` : ""}${b ? "，在预算之内" : ""}。`,
  th: (c, b) => `สินค้าแนะนำจากร้านนี้${c ? ` (${c})` : ""}${b ? " อยู่ในงบประมาณ" : ""}`,
  id: (c, b) => `Pilihan dari toko ini${c ? ` (${c})` : ""}${b ? ", sesuai anggaran Anda" : ""}.`,
  es: (c, b) => `Una opción de esta tienda${c ? ` (${c})` : ""}${b ? ", dentro de tu presupuesto" : ""}.`,
  fr: (c, b) => `Une sélection de cette boutique${c ? ` (${c})` : ""}${b ? ", dans votre budget" : ""}.`,
  de: (c, b) => `Eine Auswahl aus diesem Shop${c ? ` (${c})` : ""}${b ? ", im Rahmen deines Budgets" : ""}.`,
};

/** Reason under a generic-store suggestion (non-jewelry previews); the category is the store's own text. */
export function genericReason(l: Locale, categoryText: string, withinBudget: boolean): string {
  return GENERIC_REASON[l](categoryText, withinBudget);
}

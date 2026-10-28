/**
 * The Concierge's few fixed replies in every widget language (owner: A14, ADR-057). Claude answers in
 * the shopper's language on its own; these cover the code paths that never reach it (topic refusal,
 * the closing line after a tool-only turn, the generic-store fallback). Longer deterministic answers
 * (fallback.ts fallbackAnswer) are in fallback-text.ts, also in the ten languages with English for any other.
 * The ja, ko, zh, th, id, es, fr and de lines are machine-translated, not yet reviewed by native speakers.
 * The "Use this brief" button name comes from the widget catalog so the line matches the button.
 */
import { t, type Locale } from "@/lib/i18n";

export type FixedTextKey = "refusal" | "closingAsk" | "genericIdeas" | "genericNoBudget" | "genericRefusal";

const TEXT: Record<FixedTextKey, Record<Locale, string>> = {
  refusal: {
    en: "I can only help you choose a jewelry gift from this store. Who is it for, what's the occasion, and what's your budget?",
    vi: "Mình chỉ có thể giúp chọn quà trang sức của cửa hàng này. Bạn muốn tặng ai, dịp gì và ngân sách khoảng bao nhiêu?",
    ja: "このストアのジュエリーギフト選びのみお手伝いできます。どなたへの贈り物で、どんな機会、ご予算はいくらですか？",
    ko: "이 매장의 주얼리 선물 고르기만 도와드릴 수 있어요. 누구에게 주는 선물인지, 어떤 날인지, 예산은 얼마인지 알려 주세요.",
    zh: "我只能帮你挑选本店的珠宝礼物。礼物送给谁？什么场合？预算多少？",
    th: "ฉันช่วยได้เฉพาะการเลือกเครื่องประดับเป็นของขวัญจากร้านนี้ ของขวัญนี้ให้ใคร ในโอกาสอะไร และงบประมาณเท่าไร",
    id: "Saya hanya bisa membantu memilih hadiah perhiasan dari toko ini. Untuk siapa hadiahnya, acaranya apa, dan berapa anggaran Anda?",
    es: "Solo puedo ayudarte a elegir una joya de regalo de esta tienda. ¿Para quién es, cuál es la ocasión y cuál es tu presupuesto?",
    fr: "Je peux seulement vous aider à choisir un bijou à offrir dans cette boutique. Pour qui est le cadeau, pour quelle occasion et quel est votre budget ?",
    de: "Ich kann dir nur helfen, ein Schmuckgeschenk aus diesem Shop auszuwählen. Für wen ist es, zu welchem Anlass und wie hoch ist dein Budget?",
  },
  closingAsk: {
    en: "Who is the gift for, what's the occasion, and what's your budget?",
    vi: "Bạn muốn tặng ai, dịp gì và ngân sách khoảng bao nhiêu?",
    ja: "どなたへの贈り物で、どんな機会、ご予算はいくらですか？",
    ko: "누구에게 줄 선물인가요? 어떤 날이고, 예산은 얼마인가요?",
    zh: "礼物送给谁？什么场合？预算多少？",
    th: "ของขวัญนี้ให้ใคร ในโอกาสอะไร และงบประมาณเท่าไร",
    id: "Untuk siapa hadiahnya, acaranya apa, dan berapa anggaran Anda?",
    es: "¿Para quién es el regalo, cuál es la ocasión y cuál es tu presupuesto?",
    fr: "Pour qui est le cadeau, pour quelle occasion et quel est votre budget ?",
    de: "Für wen ist das Geschenk, zu welchem Anlass und wie hoch ist dein Budget?",
  },
  genericIdeas: {
    en: "Here are a few ideas from this store:",
    vi: "Đây là vài gợi ý từ cửa hàng này:",
    ja: "このストアからいくつかご提案します：",
    ko: "이 매장에서 고른 몇 가지 아이디어예요:",
    zh: "以下是本店的几个推荐：",
    th: "นี่คือไอเดียบางส่วนจากร้านนี้:",
    id: "Berikut beberapa ide dari toko ini:",
    es: "Aquí tienes algunas ideas de esta tienda:",
    fr: "Voici quelques idées de cette boutique :",
    de: "Hier ein paar Ideen aus diesem Shop:",
  },
  genericNoBudget: {
    en: "I couldn't find something within that budget here. Could you stretch it a little?",
    vi: "Mình chưa thấy món nào trong ngân sách đó. Bạn nới ngân sách một chút được không?",
    ja: "このご予算内では見つかりませんでした。少しだけ予算を上げられますか？",
    ko: "그 예산 안에서는 찾지 못했어요. 예산을 조금 늘릴 수 있을까요?",
    zh: "在这个预算内没有找到合适的。可以稍微提高一点预算吗？",
    th: "ไม่พบสินค้าในงบประมาณนี้ เพิ่มงบอีกนิดได้ไหม",
    id: "Saya tidak menemukan yang sesuai dengan anggaran itu di sini. Bisakah dinaikkan sedikit?",
    es: "No encontré nada dentro de ese presupuesto aquí. ¿Podrías ampliarlo un poco?",
    fr: "Je n'ai rien trouvé dans ce budget ici. Pourriez-vous l'augmenter un peu ?",
    de: "Ich habe hier nichts in diesem Budget gefunden. Kannst du es etwas erhöhen?",
  },
  genericRefusal: {
    en: "I can only help you choose a gift from this store. Who is it for, and what's the occasion?",
    vi: "Mình chỉ có thể giúp chọn quà từ cửa hàng này. Bạn muốn tặng ai, nhân dịp gì?",
    ja: "このストアのギフト選びのみお手伝いできます。どなたへの贈り物で、どんな機会ですか？",
    ko: "이 매장의 선물 고르기만 도와드릴 수 있어요. 누구에게, 어떤 날 주는 선물인가요?",
    zh: "我只能帮你挑选本店的礼物。送给谁？什么场合？",
    th: "ฉันช่วยได้เฉพาะการเลือกของขวัญจากร้านนี้ ของขวัญนี้ให้ใคร และในโอกาสอะไร",
    id: "Saya hanya bisa membantu memilih hadiah dari toko ini. Untuk siapa, dan acaranya apa?",
    es: "Solo puedo ayudarte a elegir un regalo de esta tienda. ¿Para quién es y cuál es la ocasión?",
    fr: "Je peux seulement vous aider à choisir un cadeau dans cette boutique. Pour qui est-il, et pour quelle occasion ?",
    de: "Ich kann dir nur helfen, ein Geschenk aus diesem Shop auszuwählen. Für wen ist es und zu welchem Anlass?",
  },
};

/** "I've drafted a brief; tap <button>" — with the widget's own button label in that language. */
const CLOSING_BRIEF: Record<Locale, (button: string) => string> = {
  en: (b) => `I've drafted a gift brief. Review it and tap "${b}".`,
  vi: (b) => `Mình đã soạn sẵn yêu cầu quà. Bạn xem lại rồi bấm "${b}" nhé.`,
  ja: (b) => `ギフトの内容をまとめました。確認して「${b}」を押してください。`,
  ko: (b) => `선물 요청서를 작성했어요. 확인하고 "${b}" 버튼을 눌러 주세요.`,
  zh: (b) => `我已经为你拟好了礼物需求。请检查后点击“${b}”。`,
  th: (b) => `ฉันร่างสรุปของขวัญไว้แล้ว ตรวจดูแล้วแตะ "${b}"`,
  id: (b) => `Saya sudah menyusun ringkasan hadiah. Periksa lalu ketuk "${b}".`,
  es: (b) => `He preparado un resumen del regalo. Revísalo y toca "${b}".`,
  fr: (b) => `J'ai préparé un brief cadeau. Vérifiez-le, puis touchez « ${b} ».`,
  de: (b) => `Ich habe einen Geschenkplan vorbereitet. Prüf ihn und tippe auf „${b}“.`,
};

/** A fixed reply in `lang`, English for anything else. */
export function fixedText(key: FixedTextKey, lang: string): string {
  return TEXT[key][lang as Locale] ?? TEXT[key].en;
}

export function closingBriefText(lang: string): string {
  const l: Locale = lang in CLOSING_BRIEF ? (lang as Locale) : "en";
  return CLOSING_BRIEF[l](t(l, "chat.useBrief"));
}

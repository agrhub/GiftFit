/**
 * Deterministic fallback for the Gift Concierge (owner: A7, ADR-040): keyword and budget parsing in the
 * ten widget languages (en, vi; ja, ko, zh, th, id, es, fr, de by A23) plus catalog filters; the answer is written in the conversation's language
 * (fallback-text.ts: the ten widget languages, English for any other). Used when Claude is unavailable (spend cap, missing
 * key outside mock mode, API error, refusal) so the giver still gets a usable brief and suggestions.
 * Also hosts the topic guard that refuses obviously off-topic or injection-style requests before any call.
 */
import type { GiftBrief, StyleFamily } from "@/server/contracts/api";
import type { JewelryCategory, Metal, Occasion } from "@/server/contracts/giftfit";
import { conversationLanguage, detectLanguage, uiLocaleFor, type LanguageCode } from "@/server/i18n";
import { eligibleMetals, genderMatches, type ConciergeCatalog, type GenderPresentation } from "./catalog";
import { GroundingLedger, validateBrief, validateSuggestions } from "./grounding";
import { fallbackCopy } from "./fallback-text";
import { fixedText } from "./fixed-text";
import type { ConciergeChatMessage, ConciergeSuggestion } from "./types";

/**
 * The shopper's language: any language code (server/i18n detectLanguage). Fixed and fallback texts exist in
 * the ten widget locales and are English for every other language; Claude answers in any language.
 */
export type Lang = LanguageCode;

/** Approximate VND per USD for budget parsing only (the reply says it is approximate). */
export const VND_PER_USD = 25_000;
export const DEFAULT_BUDGET_USD = 250;

const VI_CHARS = /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i;

/**
 * The language of one text when it is clear (server/i18n detectLanguage: any language), else Vietnamese on
 * its letters or a single typical word (as before), else English.
 */
export function detectLang(text: string): Lang {
  return detectLanguage(text) ?? (VI_CHARS.test(text) || /\b(triệu|cho|tặng|quà|khoảng)\b/i.test(text) ? "vi" : "en");
}

/**
 * The language to answer a conversation in: the shopper's newest message whose language is clear, else
 * `hint` (the widget's page / browser / UI language), else English. "ok", "$150", an emoji or a product
 * name therefore keep the language of the conversation so far.
 */
export function shopperLanguage(messages: readonly ConciergeChatMessage[], hint?: string | null): Lang {
  const texts = messages.filter((m) => m.role === "user").map((m) => m.content);
  return conversationLanguage(texts, hint) ?? "en";
}

// Full-width digits and signs ("１５０ドル", "＄150") become ASCII; quotes are straightened for "d’oreilles".
// (Not NFKC: it would split Thai ำ and no longer match "ทองคำ".)
const norm = (s: string) =>
  s
    .normalize("NFC")
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, " ");

/**
 * Letters of the spaced scripts in the lists (Latin with Vietnamese, French and German letters), written
 * out as ranges: Unicode property classes (\p{L}) are far slower to run in V8 across a few hundred patterns.
 */
const LETTER = "[a-z\\u00c0-\\u00d6\\u00d8-\\u00f6\\u00f8-\\u024f\\u1e00-\\u1eff\\u0300-\\u036f]";
/** Thai, kana, Han and Hangul: written without spaces between words (Korean particles attach to the noun). */
const UNSPACED_RE = /[฀-๿぀-ヿ㐀-鿿豈-﫿가-힣]/;
const HANGUL = "[\\uac00-\\ud7a3]";
const WORD_RES = new Map<string, RegExp>();

/** An entry as a regular expression; "\p{L}" in an entry stands for LETTER. */
const compile = (w: string, flags: string) => new RegExp(w.replaceAll("\\p{L}", LETTER), flags);

/**
 * A list entry as a pattern. Entries in an unspaced script match as substrings, with lookarounds where a
 * shorter match would mislead ("(?<!丈)夫": not 大丈夫); every other entry is a whole word or phrase, which
 * also ends where an unspaced script starts ("K18のピアス"). German entries end in "\p{L}*" where compounds
 * are usual ("geburtstag\p{L}*" finds "Geburtstagsgeschenk").
 */
function wordRe(w: string): RegExp {
  let re = WORD_RES.get(w);
  if (!re) {
    re = UNSPACED_RE.test(w) ? compile(w, "u") : compile(`(?<!${LETTER})(?:${w})(?!${LETTER})`, "u");
    WORD_RES.set(w, re);
  }
  return re;
}
const has = (t: string, words: readonly string[]) => words.some((w) => wordRe(w).test(t));

// Word lists per value: en, vi, then ja, ko, zh (simplified + traditional), th, id, es, fr, de.
// The first matching occasion wins, so "結婚記念日" / "anniversaire de mariage" / "Hochzeitstag" are anniversaries
// before they are weddings, and French "anniversaire" alone is a birthday.
const OCCASION_WORDS: Array<[Occasion, string[]]> = [
  ["anniversary", ["anniversary", "anniversaries", "kỷ niệm", "kỉ niệm", "記念日", "周年", "週年", "アニバーサリー", "기념일", "주년", "纪念日", "紀念日", "ครบรอบ", "ulang tahun pernikahan", "hari jadi", "aniversario", "anniversaire de mariage", "anniversaire de rencontre", "jahrestag\\p{L}*", "hochzeitstag\\p{L}*"]],
  ["wedding", ["wedding", "engagement", "bride", "bridesmaid", "đám cưới", "cưới", "đính hôn", "結婚", "ウェディング", "ブライダル", "婚約", "결혼", "웨딩", "약혼", "结婚", "婚礼", "婚禮", "订婚", "訂婚", "แต่งงาน", "งานแต่ง", "หมั้น", "pernikahan", "menikah", "tunangan", "pengantin", "boda", "casamiento", "compromiso", "mariage", "fiançailles", "noces", "hochzeit\\p{L}*", "verlobung\\p{L}*"]],
  ["graduation", ["graduation", "graduate", "graduating", "tốt nghiệp", "卒業", "졸업", "毕业", "畢業", "รับปริญญา", "จบการศึกษา", "เรียนจบ", "wisuda", "kelulusan", "lulus", "graduación", "graduacion", "diplômes?", "fin d'études", "\\p{L}*abschluss\\p{L}*", "abitur\\p{L}*"]],
  ["holiday", ["christmas", "holiday", "holidays", "xmas", "new year", "lunar new year", "tet", "tết", "giáng sinh", "noel", "valentine", "valentine's", "mother's day", "ngày của mẹ", "クリスマス", "母の日", "バレンタイン", "お正月", "크리스마스", "성탄절", "어버이날", "어머니날", "발렌타인", "밸런타인", "설날", "圣诞", "聖誕", "母亲节", "母親節", "情人节", "情人節", "春节", "春節", "คริสต์มาส", "คริสมาส", "วันแม่", "วาเลนไทน์", "ปีใหม่", "natal", "hari ibu", "lebaran", "imlek", "navidad", "día de la madre", "dia de la madre", "día de las madres", "san valentín", "san valentin", "noël", "fête des mères", "fete des meres", "saint-valentin", "saint valentin", "weihnacht\\p{L}*", "muttertag\\p{L}*", "valentinstag\\p{L}*"]],
  ["thank_you", ["thank you", "thanks", "thank-you", "cảm ơn", "tri ân", "お礼", "感謝", "감사의", "감사 선물", "感谢", "谢礼", "謝禮", "答谢", "答謝", "แทนคำขอบคุณ", "tanda terima kasih", "agradecimiento", "agradecer", "remerciements?", "pour remercier", "als dank\\p{L}*", "zum dank"]],
  ["birthday", ["birthday", "bday", "b-day", "sinh nhật", "誕生日", "バースデー", "생일", "생신", "生日", "วันเกิด", "ulang tahun", "ultah", "cumpleaños", "cumpleanos", "cumple", "anniversaire", "anniv", "geburtstag\\p{L}*"]],
  ["just_because", ["just because", "no reason", "surprise", "bất ngờ", "サプライズ", "特に理由", "なんとなく", "그냥", "깜짝", "惊喜", "驚喜", "เซอร์ไพรส์", "kejutan", "tanpa alasan", "sorpresa", "sin motivo", "porque sí", "sans raison", "sans occasion", "einfach so", "ohne grund", "ohne anlass", "überraschung\\p{L}*"]],
];

const CATEGORY_WORDS: Array<[JewelryCategory, string[]]> = [
  ["earring", ["earring", "earrings", "studs", "stud", "hoops", "hoop", "bông tai", "khuyên tai", "hoa tai", "ピアス", "イヤリング", "귀걸이", "귀고리", "이어링", "耳环", "耳環", "耳钉", "耳釘", "耳饰", "耳飾", "ต่างหู", "anting", "anting-anting", "giwang", "pendientes", "aretes", "aros", "boucles? d'oreilles?", "puces d'oreilles?", "créoles", "\\p{L}*ohrring\\p{L}*", "ohrstecker\\p{L}*", "creolen"]],
  ["necklace", ["necklace", "necklaces", "pendant", "chain", "choker", "dây chuyền", "vòng cổ", "mặt dây", "ネックレス", "ペンダント", "チョーカー", "목걸이", "펜던트", "项链", "項鍊", "項鏈", "吊坠", "吊墜", "สร้อยคอ", "kalung", "liontin", "collar", "colgante", "gargantilla", "cadena", "collier", "pendentif", "chaîne", "chaine", "\\p{L}*kette\\p{L}*", "anhänger"]],
  // "(?<!イヤ)リング": イヤリング (earrings) ends in リング.
  ["ring", ["ring", "rings", "band", "nhẫn", "指輪", "(?<!イヤ)リング", "반지", "戒指", "指环", "指環", "แหวน", "cincin", "anillo", "anillos", "sortija", "bague", "bagues", "ringe", "(?:gold|silber|verlobungs|ehe|freundschafts|diamant)ringe?"]],
  ["bracelet", ["bracelet", "bracelets", "bangle", "cuff", "vòng tay", "lắc tay", "ブレスレット", "バングル", "팔찌", "뱅글", "手链", "手鍊", "手镯", "手鐲", "สร้อยข้อมือ", "กำไล", "gelang", "pulsera", "brazalete", "jonc", "armband(?!uhr)\\p{L}*", "armreif\\p{L}*"]],
  ["watch", ["watch", "watches", "timepiece", "đồng hồ", "腕時計", "時計", "ウォッチ", "시계", "手表", "手錶", "腕表", "นาฬิกา", "jam tangan", "reloj", "montre", "uhr", "\\p{L}*uhr"]],
];

// Longer phrases first, and each found metal's words are removed before the next, so "rose gold" never also
// counts as plain "gold". A bare 金 / 银 / 은 / เงิน / argent / or also means money (or is a particle or "or"):
// those count only as 金色, 18金, "金のピアス", 银饰, 순은, เงินแท้, "en argent", "en or" and the like.
const JEWEL_JA = "ピアス|イヤリング|ネックレス|ペンダント|指輪|リング|ブレスレット|バングル|チェーン|アクセ";
const JEWEL_ZH = "耳环|耳環|耳钉|耳釘|项链|項鍊|項鏈|吊坠|吊墜|戒指|手链|手鍊|手镯|手鐲|饰|飾";
const METAL_WORDS: Array<[Metal, string[]]> = [
  ["rose_gold", ["rose gold", "rose-gold", "vàng hồng", "ローズゴールド", "ピンクゴールド", "로즈 ?골드", "핑크 ?골드", "玫瑰金", "โรสโกลด์", "พิงค์โกลด์", "ทองชมพู", "emas mawar", "oro rosa", "oro rosado", "or rose", "ros[eé]-?gold\\p{L}*", "rotgold\\p{L}*"]],
  ["white_gold", ["white gold", "white-gold", "vàng trắng", "ホワイトゴールド", "화이트 ?골드", "k白金", "白k金", "白色k金", "ไวท์โกลด์", "ทองคำขาว", "emas putih", "oro blanco", "or blanc", "wei(?:ß|ss)gold\\p{L}*"]],
  ["mixed_two_tone", ["two-tone", "two tone", "mixed metal", "hai màu", "ツートン", "투톤", "双色", "雙色", "ทูโทน", "dos tonos", "bicolor", "bicolore", "zweifarbig\\p{L}*"]],
  ["platinum", ["platinum", "bạch kim", "プラチナ", "白金", "플래티넘", "백금", "铂金", "鉑金", "แพลทินัม", "แพลตินัม", "platina", "platino", "platine", "platin\\p{L}*"]],
  ["silver", ["silver", "sterling", "bạc", "シルバー", "純銀", "銀製", "銀の", "실버", "순은", "은반지", "은목걸이", "은귀걸이", "은팔찌", "(?<![水])[银銀](?![行河座])", "ซิลเวอร์", "เงินแท้", "สีเงิน", "เงิน ?925", "perak", "plata", "plateado", "plateada", "en argent", "argent massif", "argent sterling", "argenté(?:e|s|es)?", "silber\\p{L}*", "sterlingsilber"]],
  ["yellow_gold", ["yellow gold", "gold", "vàng", "ゴールド", "金色", "純金", "(?:14|18|24)金", "k(?:14|18|24)", `金(?:の|製)?(?=${JEWEL_JA})`, "골드", "순금", "금반지", "금목걸이", "금귀걸이", "금팔찌", `(?:14|18|24)k(?=\\s?${HANGUL})`, "黄金", "黃金", "k金", "足金", `金(?:的|质|質)?(?=${JEWEL_ZH})`, "โกลด์", "ทอง(?!แดง|เหลือง|คำขาว|ชมพู)", "emas", "emas kuning", "oro", "oro amarillo", "dorado", "dorada", "en or", "or jaune", "plaqué or", "doré(?:e|s|es)?", "gold\\p{L}*", "gelbgold\\p{L}*"]],
];

const STYLE_WORDS: Array<[StyleFamily, string[]]> = [
  ["minimal", ["minimal", "minimalist", "simple", "dainty", "delicate", "understated", "tối giản", "đơn giản", "nhẹ nhàng", "ミニマル", "シンプル", "華奢", "미니멀", "심플", "깔끔", "简约", "簡約", "极简", "極簡", "มินิมอล", "เรียบง่าย", "minimalis", "simpel", "sederhana", "minimalista", "sencillo", "sencilla", "delicado", "delicada", "discreto", "discreta", "minimaliste", "épuré", "épurée", "discret", "discrète", "délicat", "délicate", "minimalistisch\\p{L}*", "schlicht\\p{L}*", "dezent\\p{L}*", "filigran\\p{L}*", "zart\\p{L}*"]],
  ["classic", ["classic", "timeless", "elegant", "cổ điển", "thanh lịch", "sang trọng", "クラシック", "定番", "上品", "エレガント", "클래식", "우아", "经典", "經典", "优雅", "優雅", "คลาสสิก", "คลาสสิค", "สง่างาม", "klasik", "elegan", "clásico", "clásica", "clasico", "clasica", "elegante", "atemporal", "classique", "élégant", "élégante", "intemporel", "intemporelle", "klassisch\\p{L}*", "elegant\\p{L}*", "zeitlos\\p{L}*"]],
  ["statement", ["statement", "bold", "glam", "glamorous", "nổi bật", "存在感", "大ぶり", "華やか", "ゴージャス", "화려", "볼드", "존재감", "醒目", "夸张", "誇張", "华丽", "華麗", "โดดเด่น", "หรูหรา", "mencolok", "mewah", "llamativo", "llamativa", "atrevido", "atrevida", "affirmé", "affirmée", "voyant", "voyante", "audacieux", "audacieuse", "auffällig\\p{L}*", "extravagant\\p{L}*"]],
  ["modern", ["modern", "contemporary", "geometric", "hiện đại", "モダン", "모던", "现代", "現代", "โมเดิร์น", "ทันสมัย", "moderno", "moderna", "moderne", "contemporain", "modern\\p{L}*"]],
  ["boho", ["boho", "bohemian", "free-spirited", "ボヘミアン", "ボーホー", "보헤미안", "波西米亚", "波希米亞", "โบฮีเมียน", "โบโฮ", "bohemio", "bohemia", "bohème", "boheme"]],
  ["vintage", ["vintage", "antique", "retro", "art deco", "ヴィンテージ", "ビンテージ", "アンティーク", "レトロ", "빈티지", "레트로", "复古", "復古", "วินเทจ", "เรโทร", "antik", "antiguo", "antigua", "rétro"]],
  ["sport", ["sport", "sporty", "active", "athletic", "thể thao", "スポーティ", "스포티", "运动", "運動", "สปอร์ต", "deportivo", "deportiva", "sportif", "sportive", "sportlich\\p{L}*"]],
];

// Unspaced-script words that hide in longer words are narrowed: 夫 (not 大丈夫), 他 (not 其他 or Japanese その他 / 他の).
const FEMININE = ["wife", "girlfriend", "fiancee", "fiancée", "mom", "mum", "mother", "sister", "daughter", "grandma", "grandmother", "aunt", "woman", "women", "lady", "bride", "bridesmaid", "vợ", "bạn gái", "mẹ", "má", "chị", "em gái", "con gái", "bà", "cô",
  "母", "ママ", "妻", "奥さん", "嫁", "姉", "妹", "彼女", "娘", "おばあちゃん", "祖母",
  "엄마", "어머니", "어머님", "아내", "와이프", "여자친구", "여친", "누나", "언니", "여동생", "딸", "할머니",
  "妈", "媽", "老婆", "太太", "女朋友", "女友", "姐", "姊", "女儿", "女兒", "奶奶", "外婆", "姥姥", "她", "闺蜜", "閨蜜",
  "แม่", "ภรรยา", "เมีย", "พี่สาว", "น้องสาว", "แฟนสาว", "ลูกสาว", "คุณยาย", "คุณย่า",
  "ibu", "bunda", "mama", "istri", "nenek", "tante", "bibi", "perempuan", "cewek", "wanita",
  "esposa", "mujer", "mamá", "madre", "hermana", "hija", "novia", "abuela", "tía", "tia", "ella", "amiga", "suegra", "prometida",
  "femme", "épouse", "mère", "maman", "sœur", "soeur", "fille", "grand-mère", "tante", "copine", "petite amie", "amie", "elle",
  "frau", "ehefrau", "mutter", "mutti", "schwester", "tochter", "oma", "großmutter", "freundin"];
const MASCULINE = ["husband", "boyfriend", "fiance", "fiancé", "dad", "father", "brother", "grandpa", "grandfather", "uncle", "groom", "chồng", "bạn trai", "bố", "ba", "anh trai", "em trai", "con trai", "ông", "chú",
  "父", "パパ", "(?<!丈)夫", "旦那", "主人", "兄", "弟", "彼氏", "息子", "おじいちゃん", "祖父",
  "아빠", "아버지", "아버님", "남편", "남자친구", "남친", "오빠", "형님", "형에게", "형한테", "남동생", "아들", "할아버지",
  "爸", "老公", "(?<!大)丈夫", "男朋友", "男友", "哥", "儿子", "兒子", "爷爷", "爺爺", "外公", "(?<![其の])他(?![のにはをで])",
  "พ่อ", "สามี", "ผัว", "พี่ชาย", "น้องชาย", "แฟนหนุ่ม", "ลูกชาย", "คุณตา", "คุณปู่",
  "ayah", "bapak", "papa", "suami", "kakek", "paman", "laki-laki", "cowok", "pria",
  "esposo", "marido", "papá", "padre", "hermano", "hijo", "novio", "abuelo", "tío", "tio", "él", "amigo", "prometido",
  "mari", "époux", "père", "frère", "fils", "grand-père", "oncle", "copain", "petit ami",
  "mann", "ehemann", "vater", "papi", "bruder", "sohn", "opa", "großvater", "onkel", "freund", "ihn"];
// English pronouns and "man"/"son" are words in other languages too (Spanish "he", "son"; German "man";
// French "son"): they count only in English text.
const FEMININE_EN = ["her", "she"];
const MASCULINE_EN = ["him", "he", "man", "men", "son"];
/** Recipients without a gender: a gift signal only. */
const NEUTRAL = ["friend", "friends", "best friend", "bff", "bạn thân", "友達", "友人", "친구", "朋友", "เพื่อน", "แฟน", "teman", "sahabat", "pacar", "ami", "amis"];

const GIFT_WORDS = ["gift", "present", "jewelry", "jewellery", "jewel", "budget", "buy", "for my", "quà", "tặng", "trang sức", "ngân sách", "mua",
  "プレゼント", "贈り物", "ギフト", "ジュエリー", "アクセサリー", "予算", "선물", "주얼리", "액세서리", "예산",
  "礼物", "禮物", "送给", "送給", "珠宝", "珠寶", "首饰", "首飾", "预算", "預算",
  "ของขวัญ", "เครื่องประดับ", "งบประมาณ", "(?<!ส)งบ", "hadiah", "kado", "perhiasan", "anggaran",
  "regalo", "regalar", "obsequio", "joya", "joyas", "presupuesto", "cadeau", "cadeaux", "bijou", "bijoux", "offrir",
  "\\p{L}*geschenk\\p{L}*", "schmuck\\p{L}*", "schenken"];

// Amount and currency words for the budget, any of the ten languages. Euro amounts are read as dollars:
// the catalog prices in USD and the fallback brief only needs the order of magnitude.
const NUM = "(\\d(?:[\\d.,]*\\d)?)";
const CURRENCY = "(?:usd|us\\$|dollars?|dolar(?:es)?|dólar(?:es)?|bucks|đô|eur(?:os?)?|\\$|€|米?ドル|달러|불|美元|美金|ดอลลาร์(?:สหรัฐ)?|ดอลล่าร์|เหรียญ(?:สหรัฐ)?)";
/** "under / at most / about / budget" before a bare amount ("hasta 150", "bis 150", "ไม่เกิน 150", "予算150"). */
const CAP_BEFORE =
  "(?:(?<!\\p{L})(?:under|below|less than|max(?:imum)?|up to|around|about|budget(?: is| of| de| von)?|dưới|tối đa|khoảng|maksimal|maks|paling banyak|di bawah|kurang dari|sekitar|anggaran|hasta|máximo|maximo|como máximo|menos de|alrededor de|unos|presupuesto(?: de)?|moins de|jusqu'à|jusqu'a|environ|bis(?: zu)?|maximal|höchstens|unter|etwa|ca\\.|um die)|予算(?:は)?|예산(?:은|는)?|预算|預算|งบ(?:ประมาณ)?|ไม่เกิน|ประมาณ)";
/** "… or less / within" after a bare amount ("150以内", "150 이하", "150まで"). */
const CAP_AFTER = "(?:以内|以下|まで|이하|이내|까지)";
/** In order: "$150" / "€150", "150 dollars" / "150ドル" / "150 €", "under 150", "150以内". Group 1 is the amount, group 2 "k". */
const BUDGET_RES = [
  `(?:us)?[$€]\\s*${NUM}\\s*(k)?`,
  `${NUM}\\s*(k)?\\s*${CURRENCY}`,
  `${CAP_BEFORE}\\s*:?\\s*(?:us\\$|\\$|€)?\\s*${NUM}\\s*(k)?`,
  `${NUM}()\\s*${CAP_AFTER}`,
].map((re) => compile(re, "u"));

/** "1,200" / "1.500" (thousands) → 1200 / 1500; "2.5" / "1,5" / "1.200,50" → 2.5 / 1.5 / 1200.5. */
function parseAmount(s: string): number {
  const last = Math.max(s.lastIndexOf("."), s.lastIndexOf(","));
  if (last < 0) return Number(s);
  if (s.length - last - 1 === 3) return Number(s.replace(/[.,]/g, ""));
  return Number(`${s.slice(0, last).replace(/[.,]/g, "")}.${s.slice(last + 1)}`);
}

/**
 * Parses a budget in USD from text: "$300", "300 usd", "under 200", "2 triệu", "500k vnd", "1.5m đ",
 * "150ドル以内", "150달러 이하", "150美元", "ไม่เกิน 150 ดอลลาร์", "maksimal 150 dolar", "hasta 150 dólares",
 * "150 $", "bis 150 €".
 */
export function parseBudgetUsd(text: string): { usd: number; fromVnd: boolean } | undefined {
  const t = norm(text);
  const num = (s: string) => Number(s.replace(/,/g, ""));
  const vnd = t.match(/(\d+(?:[.,]\d+)?)\s*(triệu|tr\b|củ)/) ?? t.match(/(\d[\d.,]*)\s*(k|nghìn|ngàn|vnđ|vnd|đồng|dong|đ)(?![\p{L}\p{N}])/u);
  if (vnd) {
    let amount: number;
    if (/triệu|tr|củ/.test(vnd[2])) amount = num(vnd[1].replace(",", ".")) * 1_000_000;
    else if (/k|nghìn|ngàn/.test(vnd[2])) amount = num(vnd[1].replace(/[.,]/g, "")) * 1_000;
    else amount = num(vnd[1].replace(/[.,]/g, ""));
    const isVndContext = /triệu|tr|củ|đ|vnd|vnđ|dong|đồng|nghìn|ngàn/.test(vnd[2]) || /vnd|vnđ|đồng|\d\s?đ(?!\p{L})/u.test(t) || detectLang(text) === "vi";
    if (isVndContext && amount >= 50_000) return { usd: Math.round(amount / VND_PER_USD), fromVnd: true };
  }
  const usd = BUDGET_RES.reduce<RegExpMatchArray | null>((found, re) => found ?? t.match(re), null);
  if (usd) {
    const v = parseAmount(usd[1]) * (usd[2] === "k" ? 1_000 : 1);
    if (v > 0 && v <= 1_000_000) return { usd: Math.round(v * 100) / 100, fromVnd: false };
  }
  return undefined;
}

export interface ParsedGiftText {
  lang: Lang;
  budget?: { usd: number; fromVnd: boolean };
  occasion?: Occasion;
  categories: JewelryCategory[];
  metals: Metal[];
  styles: StyleFamily[];
  gender?: GenderPresentation;
  giftSignal: boolean;
}

export function parseGiftText(text: string): ParsedGiftText {
  const t = norm(text);
  const occasion = OCCASION_WORDS.find(([, w]) => has(t, w))?.[0];
  const categories = CATEGORY_WORDS.filter(([, w]) => has(t, w)).map(([c]) => c);
  const metals: Metal[] = [];
  let rest = t;
  for (const [m, words] of METAL_WORDS) {
    if (has(rest, words)) {
      metals.push(m);
      for (const w of words) rest = rest.replace(compile(w, "gu"), " ");
    }
  }
  const styles = STYLE_WORDS.filter(([, w]) => has(t, w)).map(([s]) => s);
  const lang = detectLang(text);
  const fem = has(t, FEMININE) || (lang === "en" && has(t, FEMININE_EN));
  const masc = has(t, MASCULINE) || (lang === "en" && has(t, MASCULINE_EN));
  const gender: GenderPresentation | undefined = fem && !masc ? "feminine" : masc && !fem ? "masculine" : undefined;
  const budget = parseBudgetUsd(text);
  const giftSignal = Boolean(budget || occasion || categories.length || metals.length || has(t, GIFT_WORDS) || has(t, NEUTRAL) || fem || masc);
  return { lang, budget, occasion, categories, metals, styles, gender, giftSignal };
}

// ---------------------------------------------------------------------------------------------
// Topic guard (runs before any Claude call; code-enforced refusal)
// ---------------------------------------------------------------------------------------------

const OFF_TOPIC: RegExp[] = [
  /ignore (all |any |the )?(previous|prior|above) (instructions|prompts?)/i,
  /(system|developer) prompt|jailbreak|\bDAN\b|pretend (you are|to be)/i,
  /\b(write|debug|fix|explain)\b.{0,40}\b(code|python|javascript|sql|function|script|program)\b/i,
  /\b(homework|essay|poem|recipe|stock tips?|crypto|bitcoin|election|diagnos(e|is)|prescription)\b/i,
  /\b(api[_ -]?key|password|credit card number|ssn)\b/i,
];

export function refusalText(lang: Lang): string {
  return fixedText("refusal", lang);
}

/** True when the latest message is clearly not about choosing a gift here (or tries to steer the model). */
export function isOffTopic(text: string): boolean {
  return OFF_TOPIC.some((re) => re.test(text));
}

// ---------------------------------------------------------------------------------------------
// Fallback answer
// ---------------------------------------------------------------------------------------------

export interface FallbackAnswer {
  text: string;
  brief?: GiftBrief;
  suggestions: ConciergeSuggestion[];
  notes: string[];
}

/** Picks up to 3 diverse designs (category first, then style) for a validated brief. */
export function pickDiverse(catalog: ConciergeCatalog, brief: GiftBrief, styleHints: readonly string[] = []): string[] {
  const candidates = catalog.skus
    .filter((s) => (!brief.categories?.length || brief.categories.includes(s.category)) && genderMatches(s, brief.genderPresentation))
    .map((s) => ({ s, metals: eligibleMetals(s, brief.budgetMax, brief.metalLock, brief.currency) }))
    .filter((c) => c.metals.length > 0)
    .map((c) => ({
      ...c,
      score: (c.s.attributes.occasions?.includes(brief.occasion) ? 2 : 0) + (styleHints.includes(c.s.attributes.style) ? 3 : 0) + c.metals[0].price / Math.max(1, brief.budgetMax),
    }))
    .sort((a, b) => b.score - a.score || a.s.id.localeCompare(b.s.id));
  const picked: typeof candidates = [];
  const seenCat = new Set<string>();
  const seenStyle = new Set<string>();
  for (const pass of [0, 1, 2]) {
    for (const c of candidates) {
      if (picked.length >= 3) break;
      if (picked.includes(c)) continue;
      if (pass === 0 && (seenCat.has(c.s.category) || seenStyle.has(c.s.attributes.style))) continue;
      if (pass === 1 && seenCat.has(c.s.category) && (brief.categories?.length ?? 0) !== 1) continue;
      picked.push(c);
      seenCat.add(c.s.category);
      seenStyle.add(c.s.attributes.style);
    }
  }
  return picked.map((c) => c.s.id);
}

/**
 * The deterministic answer for a conversation (user messages only; later wishes override earlier ones),
 * in the conversation's language (shopperLanguage with `opts.lang` as the hint; English outside the ten).
 */
export function fallbackAnswer(messages: readonly ConciergeChatMessage[], catalog: ConciergeCatalog, opts: { tryOn?: boolean; lang?: string } = {}): FallbackAnswer {
  const tryOn = opts.tryOn !== false;
  const userTexts = messages.filter((m) => m.role === "user").map((m) => m.content);
  const last = userTexts[userTexts.length - 1] ?? "";
  const lang = uiLocaleFor(shopperLanguage(messages, opts.lang));
  const copy = fallbackCopy(lang);
  if (isOffTopic(last)) return { text: refusalText(lang), suggestions: [], notes: [] };

  const parts = userTexts.map(parseGiftText);
  const pick = <T,>(f: (p: ParsedGiftText) => T | undefined) => parts.map(f).filter((v) => v !== undefined && !(Array.isArray(v) && v.length === 0)).pop();
  const anySignal = parts.some((p) => p.giftSignal);
  if (!anySignal) return { text: refusalText(lang), suggestions: [], notes: [] };

  const notes: string[] = [];
  const budget = pick((p) => p.budget);
  const occasion = pick((p) => p.occasion) ?? "just_because";
  const categories = pick((p) => p.categories) ?? [];
  const metals = pick((p) => p.metals) ?? [];
  const styles = pick((p) => p.styles) ?? [];
  const gender = pick((p) => p.gender);
  if (!budget) notes.push(copy.budgetAssumed(DEFAULT_BUDGET_USD));
  else if (budget.fromVnd) notes.push(copy.converted(VND_PER_USD));
  if (!pick((p) => p.occasion)) notes.push(copy.occasionAssumed);

  const raw = {
    mode: "help_me_choose",
    occasion,
    budgetMax: budget?.usd ?? DEFAULT_BUDGET_USD,
    currency: catalog.currency,
    ...(categories.length ? { categories } : {}),
    // A metal named in passing becomes a hint, not a hard lock (the recipient may love another metal).
    ...(styles.length ? { styleHints: styles } : {}),
    ...(gender ? { genderPresentation: gender } : {}),
  };
  let v = validateBrief(raw, catalog, null);
  if (!v.ok && categories.length) v = validateBrief({ ...raw, categories: undefined }, catalog, null);
  if (!v.ok) return { text: copy.noBudget, suggestions: [], notes: [...notes, ...v.errors] };
  const brief = v.brief;
  const ledger = new GroundingLedger();
  const ids = pickDiverse(catalog, brief, styles);
  // Prefer a named metal when ranking the variants shown, without locking it.
  ledger.add(ids);
  const reasons = ids.map((id) => {
    const sku = catalog.byId.get(id)!;
    const ms = eligibleMetals(sku, brief.budgetMax, brief.metalLock, brief.currency);
    const preferred = ms.filter((m) => metals.includes(m.metal));
    const shown = (preferred.length ? preferred : ms).slice(0, 2).map((m) => m.metal);
    return copy.reason({ style: sku.attributes.style, category: sku.category, occasion: brief.occasion, metals: shown });
  });
  const { suggestions } = validateSuggestions(
    ids.map((catalogId, i) => ({ catalogId, reason: reasons[i] })),
    brief,
    catalog,
    ledger,
  );
  const text = copy.answer({ count: suggestions.length, occasion: brief.occasion, budgetMax: brief.budgetMax, currency: brief.currency, tryOn });
  return { text, brief, suggestions, notes };
}

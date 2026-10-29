/**
 * Language-aware word guards for giver-facing text (owner: A22). The Fit Report is written in the giver's
 * language (lib/i18n/report), so the checks in ./explain.ts and ./taste.ts run over every UI language,
 * not just English. Every list is applied to every text, whatever language was asked for: a model that
 * answers in the wrong language is still caught.
 *
 * False positives only cost the model's text (the slot falls back to the deterministic template), but
 * the lists stay narrow so ordinary jewelry words survive:
 *  - Latin-script lists match whole words (Unicode-aware boundaries, since `\b` is ASCII-only).
 *  - Words that double as ordinary jewelry vocabulary are only matched in phrases: vi "da" (also
 *    leather) and "mặt" (mặt dây chuyền = pendant), id "kulit" and es "piel" (leather), es and id "cara"
 *    (expensive / way), th "ลอง" (inside ฉลอง, "celebrate") and "ผิว" (a metal's surface), th "ประมาณ"
 *    (inside งบประมาณ, "budget"), zh "色调" (金色调, "gold tone"), ko "착용" ("wearing"), de "geschätzt"
 *    ("valued"), es "prueba" (a prueba de agua), vi "ảnh" (ảnh hưởng, "influence").
 *  - Japanese, Chinese, Korean and Thai have no spaces (or attach particles), so their lists match as
 *    substrings and hold only unambiguous terms.
 */
import type { Locale } from "@/lib/i18n";

const L = "\\p{L}\\p{M}\\p{N}";
/** Whole-word match for space-separated languages (Unicode-aware, case-insensitive unless `flags` says otherwise). */
const words = (alts: readonly string[], flags = "iu") => new RegExp(`(?<![${L}])(?:${alts.join("|")})(?![${L}])`, flags);
/** Substring match for languages written without spaces between words. */
const terms = (alts: readonly string[]) => new RegExp(`(?:${alts.join("|")})`, "iu");

/** English list (unchanged from the engine's original NO_TRYON_WORDS). */
export const NO_TRYON_WORDS_EN = /\b(undertones?|skin|complexion|face[- ]?shapes?|faces?|facial|try[- ]?ons?|tried (it |them )?on|trying on|selfies?|photos?|estimates?d?|low[- ]confidence)\b/i;

/**
 * Undertone, skin, face shape, estimate and try-on claims per language. A request (or an item, A16)
 * without a try-on must never say any of these.
 */
export const NO_TRYON_WORDS_BY_LOCALE: Record<Locale, RegExp> = {
  en: NO_TRYON_WORDS_EN,
  vi: words([
    "undertone",
    "tông (màu )?da",
    "màu da",
    "sắc da",
    "làn da",
    "nước da",
    "khuôn mặt",
    "dáng mặt",
    "gương mặt",
    "kiểu mặt",
    "hình dáng (khuôn )?mặt",
    "thử",
    "ước tính",
    "ước lượng",
    "selfie",
  ]),
  ja: terms(["アンダートーン", "イエベ", "ブルベ", "肌", "顔", "輪郭", "試着", "推定", "自撮り", "セルフィー"]),
  ko: terms(["언더톤", "웜톤", "쿨톤", "피부", "얼굴", "가상\\s?(착용|피팅)", "착용해\\s?(보|봤|본|봄)", "시착", "피팅", "추정", "셀카", "셀피"]),
  zh: terms(["底调", "冷调肤", "暖调肤", "肤色", "肤调", "皮肤", "肌肤", "脸", "面部", "五官", "试戴", "试穿", "虚拟试", "估计", "推测", "预估", "自拍"]),
  th: terms([
    "อันเดอร์โทน",
    "สีผิว",
    "โทนผิว",
    "ผิวพรรณ",
    "ผิวหน้า",
    "รูปหน้า",
    "โครงหน้า",
    "ใบหน้า",
    "ทรงหน้า",
    "(?<!ฉ)ลองสวม",
    "(?<!ฉ)ลองใส่",
    "ทดลองสวม",
    "ทดลองใส่",
    "ประเมิน",
    "เซลฟี",
  ]),
  id: words([
    "undertone",
    "warna kulit",
    "nada kulit",
    "rona kulit",
    "tone kulit",
    "kulit (mereka|nya|dia|penerima|wajah|anda)",
    "bentuk wajah",
    "wajah",
    "muka",
    "perkiraan",
    "estimasi",
    "diperkirakan",
    "(di|men)coba(kan|nya)?",
    "uji coba",
    "coba pakai",
    "selfie",
    "swafoto",
  ]),
  es: words([
    "subtonos?",
    "(tono|color|tipo) de (la )?piel",
    "su piel",
    "tez",
    "cutis",
    "forma (del|de la|de su) (rostro|cara)",
    "rostros?",
    "faciales?",
    "estimaci[oó]n(es)?",
    "estimad[oa]s?",
    "prob(ado|ada|ados|adas|ó|aron|arse|ársel[oa]s?|ándose|andose)",
    "prueba virtual",
    "probador virtual",
    "selfies?",
  ]),
  fr: words([
    "sous-tons?",
    "carnation",
    "teint",
    "peau",
    "(forme|morphologie) d(u|e son) visage",
    "visages?",
    "estimations?",
    "estimée?s?",
    "essayée?s?",
    "essayage",
    "essai virtuel",
    "selfies?",
  ]),
  // Case-sensitive: German nouns are capitalised, and lower-case "haut" / "teint" are ordinary French words.
  de: words(
    [
      "Untert(o|ö)ne?s?",
      "Hautt(o|ö)ne?s?",
      "Hautfarben?",
      "Hauttyp",
      "Haut",
      "Teint",
      "Gesichtsform(en)?",
      "Gesichts?",
      "Gesichter",
      "Schätzung(en)?",
      "geschätzte[rnsm]?\\s+(Unterton|Hautton|Gesichtsform)",
      "[Ee]ingeschätzt",
      "[Aa]nprobiert",
      "Anprobe",
      "[Aa]nprobieren",
      "[Tt]ry-?[Oo]n",
      "Selfies?",
    ],
    "u",
  ),
};

/** Photo, image and camera words per language (`leak_photo`): never in any giver-facing text. */
export const PHOTO_WORDS_BY_LOCALE: Record<Exclude<Locale, "en">, RegExp> = {
  vi: words(["ảnh(?!\\s*hưởng)", "hình ảnh", "máy ảnh", "camera", "video", "selfie", "tự sướng"]),
  ja: terms(["写真", "画像", "自撮り", "セルフィー", "カメラ", "動画"]),
  ko: terms(["사진", "셀카", "셀피", "이미지", "카메라", "동영상"]),
  zh: terms(["照片", "图片", "图像", "自拍", "相机", "摄像", "视频"]),
  th: terms(["รูปถ่าย", "ภาพถ่าย", "รูปภาพ", "เซลฟี", "กล้องถ่าย", "วิดีโอ"]),
  id: words(["foto", "swafoto", "selfie", "gambar", "kamera", "video"]),
  es: words(["fotos?", "fotograf[ií]as?", "selfies?", "imagen(es)?", "c[aá]maras?", "v[ií]deos?"]),
  fr: words(["photos?", "photographies?", "selfies?", "images?", "caméras?", "appareil photo", "vidéos?"]),
  de: words(["fotos?", "fotografien?", "selfies?", "bild(er|ern)?", "kameras?", "videos?"]),
};

/** Face-measurement and ratio words per language (`leak_biometric`), plus decimal-comma fractions. */
export const BIOMETRIC_WORDS_BY_LOCALE: Record<Exclude<Locale, "en">, RegExp> = {
  vi: words(["tỉ lệ", "tỷ lệ", "gò má", "xương gò má"]),
  ja: terms(["比率", "頬骨", "黄金比", "測定値"]),
  ko: terms(["비율", "광대뼈", "측정값"]),
  zh: terms(["比率", "颧骨", "黄金比例", "测量值"]),
  th: terms(["อัตราส่วน", "โหนกแก้ม", "ค่าที่วัด"]),
  id: words(["rasio", "tulang pipi", "ukuran wajah"]),
  es: words(["proporci[oó]n(es)?", "p[oó]mulos?", "ratio"]),
  fr: words(["ratio", "proportions?", "pommettes?"]),
  de: words(["verhältnis(se)?", "wangenknochen", "proportionen"]),
};
const DECIMAL_COMMA = /(?<![\p{N}])0,\d+(?![\p{N}])/u;

/** True when the text claims an undertone, skin, face shape, estimate or try-on in any UI language. */
export function mentionsTryOn(text: string): boolean {
  return Object.values(NO_TRYON_WORDS_BY_LOCALE).some((re) => re.test(text));
}

/** Photo words in any non-English UI language (English is in ./explain LEAKS). */
export function mentionsPhoto(text: string): boolean {
  return Object.values(PHOTO_WORDS_BY_LOCALE).some((re) => re.test(text));
}

/** Measurement or ratio words in any non-English UI language, or a decimal-comma fraction ("0,83"). */
export function mentionsBiometric(text: string): boolean {
  return DECIMAL_COMMA.test(text) || Object.values(BIOMETRIC_WORDS_BY_LOCALE).some((re) => re.test(text));
}

const SCRIPT: Partial<Record<Locale, RegExp>> = {
  ja: /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u,
  zh: /\p{Script=Han}/u,
  ko: /\p{Script=Hangul}/u,
  th: /\p{Script=Thai}/u,
};
const NON_LATIN = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}\p{Script=Hangul}\p{Script=Thai}]/u;

/**
 * Coarse "written in the wrong language" check: a ja/zh/ko/th text must use that script, and a text for
 * a Latin-script locale must not be written in CJK, Hangul or Thai. (Which Latin language is not checked.)
 */
export function wrongScript(text: string, locale: Locale): boolean {
  const script = SCRIPT[locale];
  if (script) return !script.test(text);
  return NON_LATIN.test(text);
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;
const THAI = /\p{Script=Thai}/gu;

/**
 * Words in a text. Space-separated text: whitespace tokens (unchanged). Japanese and Chinese count about
 * 2.5 characters per word and Thai about 5 code points (marks included), so "≤ 20 words" means roughly
 * 50 and 100 characters there.
 */
export function wordCount(s: string): number {
  const t = s.trim();
  const cjk = t.match(CJK)?.length ?? 0;
  const thai = t.match(THAI)?.length ?? 0;
  if (cjk === 0 && thai === 0) return t.split(/\s+/).filter(Boolean).length;
  const rest = t
    .replace(CJK, " ")
    .replace(THAI, " ")
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  return rest + Math.ceil(cjk / 2.5) + Math.ceil(thai / 5);
}

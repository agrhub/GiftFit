/**
 * Language of a piece of shopper text, for ANY language (owner: A17, ADR-057 "language follows what the
 * shopper types or says"). Pure and browser-safe; no dictionaries beyond a few words per language.
 *
 *   detectLanguage("Busco un regalo para mi hermana")        → "es"
 *   detectLanguage("Quero um presente para a minha mãe")      → "pt"   (not a widget locale: still reported)
 *   detectLanguage("ok") / ("$150") / ("🎁") / ("Aster studs") → undefined (unclear: keep the conversation's)
 *   conversationLanguage(["Quà cho mẹ", "ok"], "en")           → "vi"   (newest clear message wins, else the hint)
 *
 * Returns a lowercase ISO 639-1 code (639-3 where there is none). Rules, in order:
 *   1. letters only (URLs, e-mail addresses, digits, emoji and punctuation are ignored); fewer than 2 → unclear;
 *   2. a non-Latin script holding ≥ 30 % of the text (a Latin word counts as one letter, so a product
 *      name in Latin letters doesn't outweigh the sentence around it): Hangul → ko, kana (with or without kanji) → ja,
 *      Thai → th, Han → zh, Cyrillic → ru / uk / bg / sr / mk by their own letters, Arabic → ar / fa / ur by
 *      theirs, Hebrew → he, Greek → el, Devanagari → hi, and one language per other Indic or Asian script;
 *   3. Latin text: Vietnamese-only letters → vi; otherwise a weighted count of common words per language
 *      (a word shared by k languages counts 1/k to each) plus a few distinctive letters (ñ, ã, ß, ğ, ł, ř, ő,
 *      ș …). The winner needs ≥ 2 points and more than twice the runner-up; anything else (a product name,
 *      "thanks", English mixed with Spanish) is unclear.
 */

/** A language code as detected (ISO 639-1, or 639-3 where 639-1 has none). */
export type LanguageCode = string;

const SCRIPTS: Array<[LanguageCode, RegExp]> = [
  ["he", /\p{Script=Hebrew}/gu],
  ["el", /\p{Script=Greek}/gu],
  ["hi", /\p{Script=Devanagari}/gu],
  ["bn", /\p{Script=Bengali}/gu],
  ["pa", /\p{Script=Gurmukhi}/gu],
  ["gu", /\p{Script=Gujarati}/gu],
  ["ta", /\p{Script=Tamil}/gu],
  ["te", /\p{Script=Telugu}/gu],
  ["kn", /\p{Script=Kannada}/gu],
  ["ml", /\p{Script=Malayalam}/gu],
  ["si", /\p{Script=Sinhala}/gu],
  ["ka", /\p{Script=Georgian}/gu],
  ["hy", /\p{Script=Armenian}/gu],
  ["km", /\p{Script=Khmer}/gu],
  ["lo", /\p{Script=Lao}/gu],
  ["my", /\p{Script=Myanmar}/gu],
  ["am", /\p{Script=Ethiopic}/gu],
];

/**
 * Vietnamese-only letters: đ ơ ư and the dotted/hooked/tilded tone letters. ă (also Romanian) and â ê ô
 * (also French, Portuguese, Romanian) are left out and only count as hints below.
 */
const VI_LETTERS = /[đơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịĩọỏốồổỗộớờởỡợụủũứừửữựỳỵỷỹ]/i;

/**
 * Common, distinctive words per Latin-script language (function words plus gift vocabulary). Overlaps
 * are allowed: a word listed for k languages scores 1/k for each of them.
 */
const LATIN_WORDS: Record<LanguageCode, readonly string[]> = {
  en: ["the", "and", "for", "my", "is", "i", "im", "i'm", "to", "of", "with", "her", "his", "him", "she", "he", "gift", "present", "birthday", "anniversary", "under", "want", "looking", "need", "something", "wife", "husband", "mom", "mum", "mother", "sister", "girlfriend", "boyfriend", "what", "can", "you", "please", "help", "earrings", "necklace", "around", "about", "maybe", "some", "this", "that", "would", "like", "dad", "father", "brother", "daughter", "friend", "how", "much", "which", "your", "it", "its", "it's"],
  vi: ["toi", "minh", "tang", "qua", "cho", "me", "vo", "chong", "ban", "sinh", "nhat", "khoang", "trieu", "nghin", "em", "anh", "chi", "muon", "mua", "mon", "khong", "duoc", "nhe", "voi", "cua", "gia"],
  id: ["untuk", "yang", "dan", "saya", "aku", "ini", "itu", "ada", "dengan", "hadiah", "kado", "ulang", "tahun", "ibu", "istri", "suami", "adik", "kakak", "pacar", "mau", "ingin", "cari", "mencari", "buat", "anggaran", "sekitar", "ke", "dari", "tidak", "bisa", "apa", "perhiasan", "cincin", "kalung", "anting", "gelang", "juta", "ribu", "dong", "tolong", "bantu", "kamu", "sudah", "juga", "harga", "murah"],
  es: ["el", "los", "las", "una", "un", "para", "mi", "mis", "con", "por", "es", "y", "del", "regalo", "cumpleaños", "aniversario", "esposa", "esposo", "mamá", "madre", "hermana", "novia", "novio", "quiero", "busco", "buscando", "menos", "hasta", "algo", "collar", "pendientes", "aretes", "anillo", "pulsera", "presupuesto", "ayúdame", "ayuda", "dólares", "hola", "gracias", "cuánto", "que", "de", "la"],
  pt: ["o", "os", "as", "um", "uma", "para", "pra", "com", "por", "é", "e", "do", "da", "dos", "das", "presente", "aniversário", "esposa", "marido", "mãe", "irmã", "namorada", "namorado", "quero", "procuro", "procurando", "menos", "até", "algo", "colar", "brincos", "anel", "pulseira", "orçamento", "ajuda", "obrigado", "obrigada", "olá", "não", "você", "meu", "minha", "que", "de"],
  it: ["il", "lo", "gli", "la", "un", "una", "per", "mio", "mia", "miei", "con", "è", "e", "del", "della", "regalo", "compleanno", "anniversario", "moglie", "marito", "mamma", "madre", "sorella", "fidanzata", "fidanzato", "voglio", "cerco", "qualcosa", "collana", "orecchini", "anello", "bracciale", "grazie", "ciao", "aiutami", "sotto", "meno", "vorrei", "che", "di", "non"],
  fr: ["le", "les", "des", "du", "une", "un", "pour", "mon", "ma", "mes", "est", "et", "avec", "je", "cadeau", "anniversaire", "femme", "mari", "mère", "maman", "sœur", "soeur", "copine", "cherche", "moins", "boucles", "oreilles", "collier", "bague", "voudrais", "veux", "offrir", "quelque", "chose", "bonjour", "merci", "aidez", "aide", "noël", "fête", "que", "de", "la", "pas"],
  de: ["der", "die", "das", "und", "für", "mein", "meine", "meiner", "meinen", "ist", "ich", "ein", "eine", "einen", "mit", "geschenk", "geburtstag", "jahrestag", "frau", "mann", "mutter", "mama", "schwester", "freundin", "suche", "unter", "bis", "etwas", "ohrringe", "kette", "halskette", "armband", "möchte", "zum", "zur", "von", "nicht", "hallo", "danke", "hilf", "bitte", "weihnachten"],
  nl: ["de", "het", "een", "voor", "mijn", "is", "en", "ik", "met", "cadeau", "verjaardag", "vrouw", "moeder", "zus", "vriendin", "zoek", "iets", "ketting", "oorbellen", "armband", "wil", "graag", "bedankt", "hallo", "niet", "onder", "van"],
  pl: ["dla", "mojej", "mojego", "mój", "moja", "prezent", "urodziny", "rocznica", "żona", "żony", "mąż", "mama", "mamy", "siostra", "siostry", "dziewczyna", "szukam", "coś", "naszyjnik", "kolczyki", "pierścionek", "bransoletka", "chcę", "poniżej", "do", "i", "jest", "nie", "dziękuję", "cześć", "proszę", "na", "w"],
  tr: ["için", "bir", "ve", "bu", "benim", "annem", "anneme", "eşim", "eşime", "kız", "kardeşim", "hediye", "doğum", "günü", "yıldönümü", "kolye", "küpe", "yüzük", "bilezik", "istiyorum", "arıyorum", "altında", "bütçe", "lütfen", "teşekkürler", "merhaba", "ne", "çok"],
  sv: ["för", "min", "mitt", "och", "är", "jag", "en", "ett", "med", "present", "födelsedag", "fru", "mamma", "syster", "flickvän", "söker", "något", "halsband", "örhängen", "armband", "vill", "tack", "hej", "till", "under"],
  ro: ["pentru", "și", "si", "este", "eu", "un", "o", "cu", "cadou", "ziua", "naștere", "aniversare", "soție", "soția", "mama", "sora", "iubita", "caut", "ceva", "colier", "cercei", "inel", "brățară", "vreau", "mulțumesc", "buget", "sub", "de", "la"],
};

/** Distinctive letters: [language, pattern, points]. Tested once per text, not per letter. */
const LATIN_HINTS: Array<[LanguageCode, RegExp, number]> = [
  ["es", /[ñ¿¡]/i, 2],
  ["pt", /[ãõ]/i, 2],
  ["pt", /[çê]/i, 0.5],
  ["fr", /[œùû]/i, 2],
  ["fr", /[çèàîïë]|\bêtre\b/i, 1],
  ["it", /[ìò]/i, 1],
  ["it", /è/i, 0.5],
  ["de", /ß/i, 2],
  ["de", /[äöü]/i, 1],
  ["tr", /[ğış]|İ/u, 2],
  ["pl", /[ąęłńśźżć]/i, 2],
  ["cs", /[ěřůťď]/i, 2],
  ["hu", /[őű]/i, 2],
  ["ro", /[șțţ]/i, 2],
  ["ro", /[âîă]/i, 0.5],
  ["vi", /ă/i, 0.5],
  ["sv", /å/i, 1],
];

const WEIGHTS: ReadonlyMap<string, Array<[LanguageCode, number]>> = (() => {
  const owners = new Map<string, LanguageCode[]>();
  for (const [lang, words] of Object.entries(LATIN_WORDS)) for (const w of words) owners.set(w, [...(owners.get(w) ?? []), lang]);
  return new Map([...owners].map(([w, langs]) => [w, langs.map((l) => [l, 1 / langs.length] as [LanguageCode, number])]));
})();

/** Text with URLs and e-mail addresses removed (their letters say nothing about the language). */
function stripNoise(text: string): string {
  return text
    .normalize("NFC")
    .replace(/\bhttps?:\/\/\S+/gi, " ")
    .replace(/\bwww\.\S+/gi, " ")
    .replace(/\S+@\S+\.\S+/g, " ")
    .trim();
}

function cyrillic(s: string): LanguageCode {
  if (/[іїєґ]/i.test(s)) return "uk";
  if (/[ђћџ]/i.test(s) || (/[јљњ]/i.test(s) && !/[ѓќѕ]/i.test(s))) return "sr";
  if (/[ѓќѕ]/i.test(s)) return "mk";
  if (/ъ/i.test(s) && !/[ыэё]/i.test(s)) return "bg";
  return "ru";
}

function arabicScript(s: string): LanguageCode {
  if (/[ٹڈڑںےھ]/.test(s)) return "ur";
  if (/[پچژگیک]/.test(s)) return "fa";
  return "ar";
}

function latin(s: string): LanguageCode | undefined {
  if (VI_LETTERS.test(s)) return "vi";
  const words = s.toLowerCase().replace(/[’‘]/g, "'").split(/[^\p{L}']+/u).filter(Boolean);
  const score = new Map<LanguageCode, number>();
  const add = (l: LanguageCode, n: number) => score.set(l, (score.get(l) ?? 0) + n);
  for (const w of words) {
    const parts = WEIGHTS.has(w) ? [w] : w.split("'").filter((p) => WEIGHTS.has(p));
    for (const p of parts) for (const [l, n] of WEIGHTS.get(p)!) add(l, n);
  }
  for (const [l, re, n] of LATIN_HINTS) if (re.test(s)) add(l, n);
  const ranked = [...score].sort((a, b) => b[1] - a[1]);
  const [best, top] = ranked[0] ?? ["", 0];
  const second = ranked[1]?.[1] ?? 0;
  return top >= 2 && top > 2 * second ? best : undefined;
}

/** The language of `text`, or undefined when it is unclear (see the module comment). */
export function detectLanguage(text: string): LanguageCode | undefined {
  const s = stripNoise(text);
  const count = (re: RegExp) => (s.match(re) ?? []).length;
  const letters = count(/\p{L}/gu);
  if (letters < 2) return undefined;
  // Script shares count a Latin word as one unit and any other letter as one: a CJK, Thai or Cyrillic
  // sentence that names a product in Latin letters still belongs to its own script.
  const latinLetters = count(/\p{Script=Latin}/gu);
  const units = letters - latinLetters + count(/\p{Script=Latin}+/gu);
  const share = (re: RegExp) => count(re) / units;

  if (share(/\p{Script=Hangul}/gu) >= 0.3) return "ko";
  const kana = share(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu);
  if (kana > 0 && kana + share(/\p{Script=Han}/gu) >= 0.3) return "ja";
  if (share(/\p{Script=Thai}/gu) >= 0.3) return "th";
  if (share(/\p{Script=Han}/gu) >= 0.3) return "zh";
  if (share(/\p{Script=Cyrillic}/gu) >= 0.3) return cyrillic(s);
  if (share(/\p{Script=Arabic}/gu) >= 0.3) return arabicScript(s);
  for (const [lang, re] of SCRIPTS) if (share(re) >= 0.3) return lang;

  if (s.length < 3 || latinLetters / letters < 0.7) return undefined;
  return latin(s);
}

/** "pt-BR" → "pt", "zh-Hans" → "zh", "iw" → "he", "cmn" → "zh", "no" → "nb"; anything malformed → undefined. */
export function baseLanguage(tag: unknown): LanguageCode | undefined {
  if (typeof tag !== "string") return undefined;
  const base = tag.trim().toLowerCase().split(/[-_]/)[0];
  if (!/^[a-z]{2,3}$/.test(base)) return undefined;
  return ({ iw: "he", in: "id", ji: "yi", cmn: "zh", no: "nb", nn: "nb" } as Record<string, string>)[base] ?? base;
}

/**
 * The conversation's language: the newest of `texts` (oldest first) whose language is clear, else the
 * hint (page / widget / browser language, as a BCP 47 tag), else undefined.
 */
export function conversationLanguage(texts: readonly string[], hint?: string | null): LanguageCode | undefined {
  for (let i = texts.length - 1; i >= 0; i--) {
    const l = detectLanguage(texts[i]);
    if (l) return l;
  }
  return baseLanguage(hint ?? undefined);
}

/** English name of a language for prompts ("pt" → "Portuguese"); the code itself when Intl doesn't know it. */
export function languageName(code: LanguageCode): string {
  try {
    const name = new Intl.DisplayNames(["en"], { type: "language" }).of(code);
    return name && name !== code ? name : code;
  } catch {
    return code;
  }
}

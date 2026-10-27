/**
 * Deterministic fallback for the Gift Concierge (owner: A7, ADR-040): keyword and budget parsing
 * (English and Vietnamese) plus catalog filters. Used when Claude is unavailable (spend cap, missing
 * key outside mock mode, API error, refusal) so the giver still gets a usable brief and suggestions.
 * Also hosts the topic guard that refuses obviously off-topic or injection-style requests before any call.
 */
import type { GiftBrief, StyleFamily } from "@/lib/contracts/api";
import type { JewelryCategory, Metal, Occasion } from "@/lib/contracts/giftfit";
import { eligibleMetals, genderMatches, type ConciergeCatalog, type GenderPresentation } from "./catalog";
import { GroundingLedger, validateBrief, validateSuggestions } from "./grounding";
import type { ConciergeChatMessage, ConciergeSuggestion } from "./types";

export type Lang = "en" | "vi";

/** Approximate VND per USD for budget parsing only (the reply says it is approximate). */
export const VND_PER_USD = 25_000;
export const DEFAULT_BUDGET_USD = 250;

const VI_CHARS = /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i;

export function detectLang(text: string): Lang {
  return VI_CHARS.test(text) || /\b(triệu|cho|tặng|quà|khoảng)\b/i.test(text) ? "vi" : "en";
}

const norm = (s: string) => s.normalize("NFC").toLowerCase().replace(/\s+/g, " ");
const has = (t: string, words: readonly string[]) => words.some((w) => new RegExp(`(^|[^\\p{L}])${w}($|[^\\p{L}])`, "iu").test(t));

const OCCASION_WORDS: Array<[Occasion, string[]]> = [
  ["anniversary", ["anniversary", "anniversaries", "kỷ niệm", "kỉ niệm"]],
  ["wedding", ["wedding", "engagement", "bride", "bridesmaid", "đám cưới", "cưới", "đính hôn"]],
  ["graduation", ["graduation", "graduate", "graduating", "tốt nghiệp"]],
  ["holiday", ["christmas", "holiday", "holidays", "xmas", "new year", "lunar new year", "tet", "tết", "giáng sinh", "noel", "valentine", "valentine's", "mother's day", "ngày của mẹ"]],
  ["thank_you", ["thank you", "thanks", "thank-you", "cảm ơn", "tri ân"]],
  ["birthday", ["birthday", "bday", "b-day", "sinh nhật"]],
  ["just_because", ["just because", "no reason", "surprise", "bất ngờ"]],
];

const CATEGORY_WORDS: Array<[JewelryCategory, string[]]> = [
  ["earring", ["earring", "earrings", "studs", "stud", "hoops", "hoop", "bông tai", "khuyên tai", "hoa tai"]],
  ["necklace", ["necklace", "necklaces", "pendant", "chain", "choker", "dây chuyền", "vòng cổ", "mặt dây"]],
  ["ring", ["ring", "rings", "band", "nhẫn"]],
  ["bracelet", ["bracelet", "bracelets", "bangle", "cuff", "vòng tay", "lắc tay"]],
  ["watch", ["watch", "watches", "timepiece", "đồng hồ"]],
];

// Longer phrases first so "rose gold" never also counts as plain "gold".
const METAL_WORDS: Array<[Metal, string[]]> = [
  ["rose_gold", ["rose gold", "rose-gold", "vàng hồng"]],
  ["white_gold", ["white gold", "white-gold", "vàng trắng"]],
  ["mixed_two_tone", ["two-tone", "two tone", "mixed metal", "hai màu"]],
  ["platinum", ["platinum", "bạch kim"]],
  ["silver", ["silver", "sterling", "bạc"]],
  ["yellow_gold", ["yellow gold", "gold", "vàng"]],
];

const STYLE_WORDS: Array<[StyleFamily, string[]]> = [
  ["minimal", ["minimal", "minimalist", "simple", "dainty", "delicate", "understated", "tối giản", "đơn giản", "nhẹ nhàng"]],
  ["classic", ["classic", "timeless", "elegant", "cổ điển", "thanh lịch", "sang trọng"]],
  ["statement", ["statement", "bold", "glam", "glamorous", "nổi bật"]],
  ["modern", ["modern", "contemporary", "geometric", "hiện đại"]],
  ["boho", ["boho", "bohemian", "free-spirited"]],
  ["vintage", ["vintage", "antique", "retro", "art deco"]],
  ["sport", ["sport", "sporty", "active", "athletic", "thể thao"]],
];

const FEMININE = ["wife", "girlfriend", "fiancee", "fiancée", "mom", "mum", "mother", "sister", "daughter", "grandma", "grandmother", "aunt", "her", "she", "woman", "women", "lady", "bride", "bridesmaid", "vợ", "bạn gái", "mẹ", "má", "chị", "em gái", "con gái", "bà", "cô"];
const MASCULINE = ["husband", "boyfriend", "fiance", "fiancé", "dad", "father", "brother", "son", "grandpa", "grandfather", "uncle", "him", "he", "man", "men", "groom", "chồng", "bạn trai", "bố", "ba", "anh trai", "em trai", "con trai", "ông", "chú"];

const GIFT_WORDS = ["gift", "present", "jewelry", "jewellery", "jewel", "budget", "buy", "for my", "quà", "tặng", "trang sức", "ngân sách", "mua"];

/** Parses a budget in USD from text: "$300", "300 usd", "under 200", "2 triệu", "500k vnd", "1.5m đ". */
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
  const usd =
    t.match(/\$\s*(\d[\d,]*(?:\.\d+)?)\s*(k)?/) ??
    t.match(/(\d[\d,]*(?:\.\d+)?)\s*(k)?\s*(?:usd|dollars?|bucks|đô)/) ??
    t.match(/(?:under|below|less than|max(?:imum)?|up to|around|about|budget(?: is| of)?|dưới|tối đa|khoảng)\s*\$?\s*(\d[\d,]*(?:\.\d+)?)\s*(k)?/);
  if (usd) {
    const v = num(usd[1]) * (usd[2] === "k" ? 1_000 : 1);
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
      for (const w of words) rest = rest.replace(new RegExp(w, "giu"), " ");
    }
  }
  const styles = STYLE_WORDS.filter(([, w]) => has(t, w)).map(([s]) => s);
  const fem = has(t, FEMININE);
  const masc = has(t, MASCULINE);
  const gender: GenderPresentation | undefined = fem && !masc ? "feminine" : masc && !fem ? "masculine" : undefined;
  const budget = parseBudgetUsd(text);
  const giftSignal = Boolean(budget || occasion || categories.length || metals.length || has(t, GIFT_WORDS) || fem || masc);
  return { lang: detectLang(text), budget, occasion, categories, metals, styles, gender, giftSignal };
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
  return lang === "vi"
    ? "Mình chỉ có thể giúp chọn quà trang sức của cửa hàng này. Bạn muốn tặng ai, dịp gì và ngân sách khoảng bao nhiêu?"
    : "I can only help you choose a jewelry gift from this store. Who is it for, what's the occasion, and what's your budget?";
}

/** True when the latest message is clearly not about choosing a gift here (or tries to steer the model). */
export function isOffTopic(text: string): boolean {
  return OFF_TOPIC.some((re) => re.test(text));
}

// ---------------------------------------------------------------------------------------------
// Fallback answer
// ---------------------------------------------------------------------------------------------

const STYLE_VI: Record<string, string> = { classic: "cổ điển", minimal: "tối giản", statement: "nổi bật", modern: "hiện đại", boho: "boho", vintage: "vintage", sport: "thể thao" };
const CATEGORY_VI: Record<JewelryCategory, string> = { earring: "bông tai", necklace: "dây chuyền", ring: "nhẫn", bracelet: "vòng tay", watch: "đồng hồ" };
const OCCASION_EN: Record<Occasion, string> = { anniversary: "anniversary", birthday: "birthday", wedding: "wedding", holiday: "holiday", graduation: "graduation", thank_you: "thank-you", just_because: "just-because" };
const OCCASION_VI: Record<Occasion, string> = { anniversary: "kỷ niệm", birthday: "sinh nhật", wedding: "đám cưới", holiday: "dịp lễ", graduation: "tốt nghiệp", thank_you: "cảm ơn", just_because: "bất ngờ" };
const METAL_EN: Record<Metal, string> = { yellow_gold: "yellow gold", rose_gold: "rose gold", white_gold: "white gold", silver: "silver", platinum: "platinum", mixed_two_tone: "two-tone" };
const METAL_VI: Record<Metal, string> = { yellow_gold: "vàng", rose_gold: "vàng hồng", white_gold: "vàng trắng", silver: "bạc", platinum: "bạch kim", mixed_two_tone: "hai màu" };

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

/** The deterministic answer for a conversation (user messages only; later wishes override earlier ones). */
export function fallbackAnswer(messages: readonly ConciergeChatMessage[], catalog: ConciergeCatalog, opts: { tryOn?: boolean } = {}): FallbackAnswer {
  const tryOn = opts.tryOn !== false;
  const userTexts = messages.filter((m) => m.role === "user").map((m) => m.content);
  const last = userTexts[userTexts.length - 1] ?? "";
  const lang = detectLang(last);
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
  if (!budget) notes.push(lang === "vi" ? `Ngân sách tạm tính: $${DEFAULT_BUDGET_USD}` : `Budget assumed: $${DEFAULT_BUDGET_USD}`);
  else if (budget.fromVnd) notes.push(lang === "vi" ? `Đã quy đổi khoảng ${VND_PER_USD.toLocaleString("vi-VN")}đ = 1 USD` : `Converted at about ${VND_PER_USD.toLocaleString("en-US")} VND per USD`);
  if (!pick((p) => p.occasion)) notes.push(lang === "vi" ? "Dịp: chưa rõ, chọn 'bất ngờ'" : "Occasion not given: just because");

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
  if (!v.ok) {
    const text =
      lang === "vi"
        ? "Mình chưa tìm thấy mẫu nào trong ngân sách này. Bạn thử tăng ngân sách một chút nhé?"
        : "I couldn't find a design within that budget. Could you raise it a little?";
    return { text, suggestions: [], notes: [...notes, ...v.errors] };
  }
  const brief = v.brief;
  const ledger = new GroundingLedger();
  const ids = pickDiverse(catalog, brief, styles);
  // Prefer a named metal when ranking the variants shown, without locking it.
  ledger.add(ids);
  const reasons = ids.map((id) => {
    const sku = catalog.byId.get(id)!;
    const ms = eligibleMetals(sku, brief.budgetMax, brief.metalLock, brief.currency);
    const preferred = ms.filter((m) => metals.includes(m.metal));
    const shown = (preferred.length ? preferred : ms).slice(0, 2).map((m) => (lang === "vi" ? METAL_VI : METAL_EN)[m.metal]);
    return lang === "vi"
      ? `Mẫu ${CATEGORY_VI[sku.category]} phong cách ${STYLE_VI[sku.attributes.style] ?? sku.attributes.style}, có ${shown.join(" và ")} trong ngân sách.`
      : `A ${sku.attributes.style} ${sku.category} that suits a ${OCCASION_EN[brief.occasion]} gift, in ${shown.join(" or ")} within your budget.`;
  });
  const { suggestions } = validateSuggestions(
    ids.map((catalogId, i) => ({ catalogId, reason: reasons[i] })),
    brief,
    catalog,
    ledger,
  );
  const budgetText = `$${brief.budgetMax}`;
  const text =
    lang === "vi"
      ? `Đây là ${suggestions.length} gợi ý cho dịp ${OCCASION_VI[brief.occasion]}, trong ngân sách ${budgetText}. Mình đã soạn sẵn yêu cầu "Giúp tôi chọn": GiftFit sẽ chọn 6–8 mẫu trong ngân sách để người nhận ${tryOn ? "thử" : "xem và thả tim"}. Bạn xem lại rồi bấm "Dùng yêu cầu này" nhé.`
      : `Here are ${suggestions.length} ideas for a ${OCCASION_EN[brief.occasion]} gift within ${budgetText}. I've drafted a "Help me choose" brief: GiftFit will pick 6–8 pieces within your budget for them to ${tryOn ? "try on" : "look through and heart"}. Review it and tap "Use this brief".`;
  return { text, brief, suggestions, notes };
}

/**
 * Defence in depth against model "narration" reaching the shopper (owner: A7). The engine already never
 * streams text from a turn that calls a tool; this drops a LEADING meta sentence that still slips into a
 * final reply ("The user wants…", "I'll search for…", "Let me check…"), without touching normal replies.
 * Only the first two sentences are examined; everything after the first non-meta sentence passes through.
 */

/** Tool identifiers and tool-call talk ("tool call", "tool results"); a plain "tool" (a hardware store's product) is fine. */
const TOOL_NAMES = /\b(?:search_catalog|fit_preview|check_budget_and_metals|create_fit_request|suggest_products)\b|\btool[ _-]?(?:calls?|results?|use|outputs?)\b|\b(?:the|my) (?:search|catalog) tool\b/i;

const META_START = new RegExp(
  [
    // Third person about the shopper: "The user wants…", "The shopper is looking…"
    String.raw`^(?:the|this) (?:user|shopper|giver|customer|client)\b`,
    // Plans: "I'll search…", "I will look…", "Let me check…", "I'm going to find…", "First, I'll…", "Now I'll…"
    String.raw`^(?:first,? |now,? |next,? |okay,? |ok,? |alright,? )?(?:i'?ll|i will|i'm going to|i am going to|let me|i'm now going to)\s+(?:now\s+|first\s+|quickly\s+)?(?:search|look|check|use|call|find|draft|run|query|start|begin|create|try|browse|filter|pull|grab|go|scan|fetch|gather|verify|confirm|narrow)\b`,
    // Gerund plans: "Searching the catalog…", "Checking the budget…"
    String.raw`^(?:searching|looking up|checking|calling|using|querying|browsing|filtering)\b`,
    // Vietnamese: "Người dùng muốn…", "Mình sẽ tìm…", "Tôi sẽ kiểm tra…"
    String.raw`^(?:người dùng|khách hàng|người mua)\s+(?:muốn|cần|đang|thích)`,
    String.raw`^(?:mình|tôi|em)\s+sẽ\s+(?:tìm|kiểm tra|tra|tra cứu|dùng|gọi|soạn)`,
  ].join("|"),
  "iu",
);

/** True when a sentence is narration about the shopper, the plan or the tools. */
export function isMetaSentence(sentence: string): boolean {
  const s = sentence.normalize("NFC").replace(/[‘’]/g, "'").trim();
  if (!s) return false;
  return META_START.test(s) || TOOL_NAMES.test(s);
}

/** End index (exclusive) of the first sentence, or -1 when not complete yet. */
function sentenceEnd(text: string, final: boolean): number {
  const re = final ? /[.!?…](?=\s|$)|\n/u : /[.!?…](?=\s)|\n/u;
  const m = re.exec(text);
  return m ? m.index + m[0].length : -1;
}

const MAX_CHECKED = 2;
const MAX_HOLD = 300;

/**
 * Streaming form: holds text until the first sentence is complete, drops it if it is meta (up to two
 * leading sentences), then passes everything through unchanged.
 */
export class LeadingMetaFilter {
  private buf = "";
  private passing = false;
  private dropped = 0;

  push(delta: string): string {
    if (this.passing) return delta;
    this.buf += delta;
    return this.drain(false);
  }

  flush(): string {
    if (this.passing) return "";
    return this.drain(true);
  }

  private drain(final: boolean): string {
    for (;;) {
      if (this.dropped >= MAX_CHECKED) return this.release();
      const end = sentenceEnd(this.buf, final);
      if (end < 0) {
        if (!final && this.buf.length <= MAX_HOLD) return "";
        if (final && isMetaSentence(this.buf)) {
          this.buf = "";
          this.passing = true;
          return "";
        }
        return this.release();
      }
      const sentence = this.buf.slice(0, end);
      if (!isMetaSentence(sentence)) return this.release();
      this.dropped++;
      this.buf = this.buf.slice(end).replace(/^\s+/u, "");
      if (!this.buf && !final) return "";
    }
  }

  private release(): string {
    const out = this.buf;
    this.buf = "";
    this.passing = true;
    return out;
  }
}

/** Whole-text form of LeadingMetaFilter. */
export function stripLeadingMeta(text: string): string {
  const f = new LeadingMetaFilter();
  return (f.push(text) + f.flush()).trim();
}

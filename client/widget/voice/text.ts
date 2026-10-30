/**
 * Text for spoken replies (owner: A4, P8.3). Pure functions.
 *
 * The Concierge writes plain text with the odd list marker, link or emoji; speech skips those. Replies
 * are cut into chunks of at most `TTS_MAX_CHARS` (the /api/voice/tts contract), on sentence
 * boundaries where possible, and long replies are capped at `MAX_CHUNKS` chunks: the full text is on
 * screen, and every chunk counts against the shopper's per-session voice cap.
 */

export const TTS_MAX_CHARS = 400;
export const MAX_CHUNKS = 3;

const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}]/gu;

/** Drops links, markdown markers and emoji; collapses whitespace. */
export function cleanForSpeech(text: string): string {
  return text
    .normalize("NFC")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*_`#>]+/g, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(EMOJI, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Sentences (keeps the terminal punctuation, incl. CJK 。！？); newlines also end a sentence. */
export function sentences(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\n+/)) {
    const parts = line.match(/[^.!?…。！？]+(?:[.!?…。！？]+["')\]」』]*|$)/g) ?? [];
    for (const p of parts) {
      const s = p.trim();
      if (s) out.push(s);
    }
  }
  return out;
}

/** Hard split of one over-long sentence on spaces (never mid-word unless a word is longer than max). */
function hardSplit(s: string, max: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const word of s.split(" ")) {
    if (word.length > max) {
      if (cur) out.push(cur);
      for (let i = 0; i < word.length; i += max) out.push(word.slice(i, i + max));
      cur = "";
      continue;
    }
    const next = cur ? `${cur} ${word}` : word;
    if (next.length > max) {
      out.push(cur);
      cur = word;
    } else cur = next;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Chunks for TTS: whole sentences packed greedily up to `max` characters, at most `maxChunks` chunks.
 * The first chunk is the first sentence alone when that is short, so the voice starts sooner.
 */
export function chunksForSpeech(raw: string, max = TTS_MAX_CHARS, maxChunks = MAX_CHUNKS): string[] {
  const text = raw
    .split(/\n+/)
    .map(cleanForSpeech)
    .filter(Boolean)
    .join("\n");
  const units = sentences(text).flatMap((s) => (s.length > max ? hardSplit(s, max) : [s]));
  const out: string[] = [];
  let cur = "";
  for (const u of units) {
    const next = cur ? `${cur} ${u}` : u;
    // Close the first chunk after its first sentence (quick start), then pack greedily.
    if (next.length > max || (out.length === 0 && cur && cur.length >= 40)) {
      out.push(cur);
      cur = u;
    } else cur = next;
    if (out.length >= maxChunks) break;
  }
  if (cur && out.length < maxChunks) out.push(cur);
  return out.slice(0, maxChunks).filter((c) => c.trim().length > 0);
}

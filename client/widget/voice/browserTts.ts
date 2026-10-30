/**
 * Last audio fallback (owner: A4, P8.3): the browser's own speechSynthesis, used only when a voice
 * for the language exists. Its output cannot be routed into Web Audio, so the character's mouth
 * follows the typing rhythm instead of the sound (CharacterProps.mouth left undefined).
 */
import { INTL_LOCALES, isLocale } from "@/server/i18n";

export class NoBrowserVoiceError extends Error {
  constructor() {
    super("no browser voice for this language");
    this.name = "NoBrowserVoiceError";
  }
}

export function speechSynth(): SpeechSynthesis | null {
  try {
    return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance === "function" ? window.speechSynthesis : null;
  } catch {
    return null;
  }
}

/** The first installed voice for `lang` (exact "vi-VN" / "zh-CN" style tag preferred for the widget locales), or null. */
export function pickVoice(voices: readonly SpeechSynthesisVoice[], lang: string): SpeechSynthesisVoice | null {
  const tag = isLocale(lang) ? INTL_LOCALES[lang].toLowerCase() : null;
  const norm = (v: SpeechSynthesisVoice) => v.lang.toLowerCase().replace("_", "-");
  return (tag ? voices.find((v) => norm(v) === tag) : undefined) ?? voices.find((v) => norm(v) === lang || norm(v).startsWith(`${lang}-`)) ?? null;
}

/** Voices load asynchronously in Chrome; wait briefly for `voiceschanged`. */
async function voicesOf(synth: SpeechSynthesis): Promise<SpeechSynthesisVoice[]> {
  const now = synth.getVoices();
  if (now.length) return now;
  return await new Promise((resolve) => {
    const done = () => {
      clearTimeout(t);
      synth.removeEventListener?.("voiceschanged", done);
      resolve(synth.getVoices());
    };
    const t = setTimeout(done, 1200);
    synth.addEventListener?.("voiceschanged", done);
  });
}

/** Speaks `text`; resolves on end, cancel or abort; rejects when no voice exists for the language. */
export async function speakWithBrowser(text: string, lang: string, signal?: AbortSignal, synth = speechSynth()): Promise<void> {
  if (!synth) throw new NoBrowserVoiceError();
  const voice = pickVoice(await voicesOf(synth), lang);
  if (!voice) throw new NoBrowserVoiceError();
  if (signal?.aborted) return;
  await new Promise<void>((resolve, reject) => {
    const u = new SpeechSynthesisUtterance(text);
    u.voice = voice;
    u.lang = voice.lang;
    u.rate = 1;
    const stop = () => {
      synth.cancel();
      resolve();
    };
    u.onend = () => {
      signal?.removeEventListener("abort", stop);
      resolve();
    };
    u.onerror = (e) => {
      signal?.removeEventListener("abort", stop);
      const err = (e as SpeechSynthesisErrorEvent).error;
      if (err === "interrupted" || err === "canceled") resolve();
      else reject(new Error(`speechSynthesis ${err ?? "error"}`));
    };
    signal?.addEventListener("abort", stop);
    synth.speak(u);
  });
}

/**
 * Mock voice engines (owner: A13): VOICE_MOCK=1, NODE_ENV=test, or no Google credentials. No network.
 * STT answers a canned transcript per language; TTS answers a short sine-tone WAV whose amplitude
 * rises and falls like syllables, so the widget's AnalyserNode → mouth path can be exercised.
 */
import type { VoiceLang } from "./config";
import { charCount } from "./config";

export const MOCK_TRANSCRIPTS: Record<VoiceLang, string> = {
  en: "I'm looking for a gift for my sister, maybe earrings under 200 dollars.",
  vi: "Tôi đang tìm quà cho chị gái, có thể là bông tai dưới năm triệu đồng.",
  ja: "姉へのプレゼントを探しています。200ドル以下のピアスがいいかもしれません。",
  ko: "언니에게 줄 선물을 찾고 있어요. 200달러 이하 귀걸이면 좋겠어요.",
  zh: "我在给姐姐找礼物，也许是200美元以下的耳环。",
  th: "กำลังหาของขวัญให้พี่สาว อาจเป็นต่างหูราคาไม่เกิน 200 ดอลลาร์",
  id: "Saya sedang mencari hadiah untuk kakak perempuan saya, mungkin anting di bawah 200 dolar.",
  es: "Busco un regalo para mi hermana, quizá unos pendientes de menos de 200 dólares.",
  fr: "Je cherche un cadeau pour ma sœur, peut-être des boucles d'oreilles à moins de 200 dollars.",
  de: "Ich suche ein Geschenk für meine Schwester, vielleicht Ohrringe unter 200 Dollar.",
};

export const MOCK_SAMPLE_RATE = 16_000;

/** Seconds of mock audio for a reply: ~55 ms per character, 0.6 s to 6 s. */
export function mockToneSeconds(text: string): number {
  return Math.min(6, Math.max(0.6, charCount(text) * 0.055));
}

/** 16-bit mono PCM WAV of a 180 Hz tone (+ a soft overtone) under a ~4 Hz syllable envelope. */
export function mockToneWav(seconds: number, sampleRate = MOCK_SAMPLE_RATE): Uint8Array {
  const n = Math.max(1, Math.round(seconds * sampleRate));
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (at: number, s: string) => {
    for (let i = 0; i < s.length; i += 1) v.setUint8(at + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, n * 2, true);
  const fade = Math.min(n / 2, sampleRate * 0.03);
  for (let i = 0; i < n; i += 1) {
    const t = i / sampleRate;
    const syllable = Math.max(0, Math.sin(Math.PI * 4.2 * t)) ** 0.6; // 0 between "syllables"
    const edge = Math.min(1, i / fade, (n - 1 - i) / fade);
    const s = (Math.sin(2 * Math.PI * 180 * t) * 0.8 + Math.sin(2 * Math.PI * 360 * t) * 0.2) * syllable * edge * 0.5;
    v.setInt16(44 + i * 2, Math.round(s * 32767), true);
  }
  return new Uint8Array(buf);
}

/**
 * Paid smoke test of the live voice paths (owner: A13). Run only with the user's approval: it makes
 * 3 Google Text-to-Speech calls (en-US and vi-VN Chirp 3 HD, vi-VN Neural2 fallback voice; ≤ 200 chars
 * each) and 3 Speech-to-Text V2 chirp_3 calls (≤ 5 s each: Ogg/Opus en, WebM/Opus vi, fragmented MP4/AAC
 * en, transcoded locally with ffmpeg-static from the TTS output). Prints latencies, sizes, probed and
 * billed durations, and whether each transcript contains the expected words. Never prints audio, text
 * or credentials; nothing is written to disk. Auth: ADC. Usage:
 *
 *   GOOGLE_CLOUD_PROJECT=<project> npx tsx scripts/voice-smoke.ts
 *   npx tsx scripts/voice-smoke.ts --dry     no Google calls: transcodes the mock tone and probes the clips
 */
import { spawn } from "node:child_process";
import { checkClip, type ClipContainer } from "@/server/voice/audio";
import { googleSttEngine, googleTtsEngine, speechClient, ttsClient } from "@/server/voice/google";
import { mockToneWav } from "@/server/voice/mock";

const SAMPLES = {
  en: { text: "I am looking for a silver ring for my sister's birthday.", words: ["silver", "ring", "sister"] },
  vi: { text: "Tôi muốn tìm một chiếc nhẫn bạc làm quà sinh nhật.", words: ["nhẫn", "bạc", "sinh nhật"] },
} as const;

const FFMPEG_OUT: Record<ClipContainer, { args: string[]; mime: string }> = {
  ogg: { args: ["-c:a", "libopus", "-b:a", "32k", "-f", "ogg"], mime: "audio/ogg;codecs=opus" },
  webm: { args: ["-c:a", "libopus", "-b:a", "32k", "-f", "webm"], mime: "audio/webm;codecs=opus" },
  mp4: { args: ["-c:a", "aac", "-b:a", "64k", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4"], mime: "audio/mp4" },
};

async function transcode(input: Uint8Array, to: ClipContainer): Promise<Uint8Array> {
  const ffmpeg = (await import("ffmpeg-static")).default as unknown as string;
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-ac", "1", "-ar", "48000", ...FFMPEG_OUT[to].args, "pipe:1"]);
    const out: Buffer[] = [];
    p.stdout.on("data", (d: Buffer) => out.push(d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(new Uint8Array(Buffer.concat(out))) : reject(new Error(`ffmpeg exit ${code}`))));
    p.stdin.end(Buffer.from(input));
  });
}

const norm = (s: string) => s.toLowerCase().normalize("NFC");

async function dry() {
  const wav = mockToneWav(3.5);
  for (const container of ["ogg", "webm", "mp4"] as const) {
    const clip = await transcode(wav, container);
    const check = checkClip(FFMPEG_OUT[container].mime, clip);
    console.log(`dry ${container}: ${clip.byteLength} bytes, ${check.ok ? `probed ${check.seconds?.toFixed(2)} s` : `rejected ${check.error}`}`);
  }
}

async function main() {
  if (process.argv.includes("--dry")) return dry();
  if (!process.env.GOOGLE_CLOUD_PROJECT) throw new Error("set GOOGLE_CLOUD_PROJECT");
  const tts = googleTtsEngine(ttsClient, { ...process.env, VOICE_TTS_FALLBACK_VOICE_EN: "off", VOICE_TTS_FALLBACK_VOICE_VI: "off" });
  const ttsNeural = googleTtsEngine(ttsClient, { ...process.env, VOICE_TTS_VOICE_VI: "vi-VN-Neural2-D", VOICE_TTS_FALLBACK_VOICE_VI: "off" });
  const stt = googleSttEngine(speechClient);
  const mp3: Record<string, Uint8Array> = {};

  for (const [label, engine, lang] of [["tts en Chirp3-HD", tts, "en"], ["tts vi Chirp3-HD", tts, "vi"], ["tts vi Neural2", ttsNeural, "vi"]] as const) {
    const t0 = performance.now();
    const r = await engine.synthesize({ text: SAMPLES[lang].text, lang });
    console.log(`${label}: voice=${r.voice} ${r.contentType} ${r.audio.byteLength} bytes in ${Math.round(performance.now() - t0)} ms (chars=${[...SAMPLES[lang].text].length})`);
    mp3[label] ??= r.audio;
  }

  for (const [lang, container, src] of [["en", "ogg", "tts en Chirp3-HD"], ["vi", "webm", "tts vi Chirp3-HD"], ["en", "mp4", "tts en Chirp3-HD"]] as const) {
    const clip = await transcode(mp3[src], container);
    const check = checkClip(FFMPEG_OUT[container].mime, clip);
    if (!check.ok) throw new Error(`${container}: clip check failed (${check.error})`);
    if ((check.seconds ?? 99) > 5) throw new Error(`${container}: clip longer than 5 s, not sending`);
    const t0 = performance.now();
    const r = await stt.transcribe({ audio: clip, lang });
    const got = norm(r.text);
    const hits = SAMPLES[lang].words.filter((w) => got.includes(norm(w))).length;
    console.log(`stt ${lang} ${container}: ${clip.byteLength} bytes, probed ${check.seconds?.toFixed(2)} s, billed ${r.billedSeconds} s, ${Math.round(performance.now() - t0)} ms, transcript chars=${[...r.text].length}, expected words ${hits}/${SAMPLES[lang].words.length}`);
  }
}

main().catch((err) => {
  console.error(`[voice-smoke] failed: ${(err as { code?: unknown }).code ?? ""} ${(err as Error).message}`);
  process.exit(1);
});

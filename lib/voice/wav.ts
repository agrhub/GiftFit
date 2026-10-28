/**
 * PCM → WAV for the server Supertonic voice (owner: A13). Supertonic renders 44.1 kHz float PCM; the
 * route halves it to 22.05 kHz (low-pass FIR, then every second sample) so a sentence is about
 * 44 KB/s as 16-bit WAV, which every browser's decodeAudioData accepts.
 */

/** Windowed-sinc low-pass (Hamming), cutoff at a quarter of the input rate, normalised to unity gain. */
function halfbandTaps(n = 31): Float32Array {
  const taps = new Float32Array(n);
  const m = (n - 1) / 2;
  const fc = 0.25; // cycles per input sample (= the output Nyquist frequency)
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const x = i - m;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1));
    taps[i] = sinc * w;
    sum += taps[i];
  }
  for (let i = 0; i < n; i++) taps[i] /= sum;
  return taps;
}

const TAPS = halfbandTaps();

/** Low-pass then keep every second sample (44.1 kHz → 22.05 kHz). */
export function decimate2(pcm: Float32Array): Float32Array {
  const out = new Float32Array(Math.ceil(pcm.length / 2));
  const m = (TAPS.length - 1) / 2;
  for (let o = 0; o < out.length; o++) {
    const c = o * 2;
    let acc = 0;
    for (let k = 0; k < TAPS.length; k++) {
      const j = c + k - m;
      if (j >= 0 && j < pcm.length) acc += pcm[j] * TAPS[k];
    }
    out[o] = acc;
  }
  return out;
}

/** 16-bit mono PCM WAV (samples clamped to [-1, 1]). */
export function pcm16Wav(pcm: Float32Array, sampleRate: number): Uint8Array {
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const str = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  v.setUint32(4, 36 + pcm.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i] || 0));
    v.setInt16(44 + i * 2, Math.round(s * 32767), true);
  }
  return new Uint8Array(buf);
}

/** Supertonic PCM → WAV bytes at half the rate when the rate is even and high (44.1 kHz → 22.05 kHz). */
export function speechWav(pcm: Float32Array, sampleRate: number): { wav: Uint8Array; sampleRate: number; durationMs: number } {
  const half = sampleRate >= 32_000 && sampleRate % 2 === 0;
  const out = half ? decimate2(pcm) : pcm;
  const rate = half ? sampleRate / 2 : sampleRate;
  return { wav: pcm16Wav(out, rate), sampleRate: rate, durationMs: Math.round((out.length / rate) * 1000) };
}

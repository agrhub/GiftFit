/**
 * The widget's one audio output graph (owner: A4, P8.3):
 *
 *   AudioBufferSourceNode → AnalyserNode → destination
 *
 * Every engine that returns audio (Supertonic PCM in the browser, server TTS bytes) plays through it,
 * and the AnalyserNode drives the character's mouth (useMouthFromAudio accepts the analyser). The
 * context is created lazily and resumed on a user gesture (mic press, voice toggle), which also
 * unlocks audio on iOS.
 */

type Ctor = typeof AudioContext;

export function audioContextCtor(): Ctor | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
  return w.AudioContext ?? w.webkitAudioContext;
}

export class VoiceAudio {
  private ctx: AudioContext | null = null;
  private analyserNode: AnalyserNode | null = null;
  private current: AudioBufferSourceNode | null = null;
  private stopCurrent: (() => void) | null = null;

  constructor(private readonly Ctx: Ctor | undefined = audioContextCtor()) {}

  get supported(): boolean {
    return Boolean(this.Ctx);
  }

  private graph(): { ctx: AudioContext; analyser: AnalyserNode } | null {
    if (!this.Ctx) return null;
    if (!this.ctx) {
      try {
        const ctx = new this.Ctx();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        analyser.connect(ctx.destination);
        this.ctx = ctx;
        this.analyserNode = analyser;
      } catch {
        return null;
      }
    }
    return { ctx: this.ctx, analyser: this.analyserNode! };
  }

  /** Call from a user gesture: creates/resumes the context so later playback is allowed. */
  unlock(): void {
    const g = this.graph();
    if (g && g.ctx.state === "suspended") void g.ctx.resume().catch(() => {});
  }

  get analyser(): AnalyserNode | null {
    return this.analyserNode;
  }

  async decode(bytes: ArrayBuffer): Promise<AudioBuffer> {
    const g = this.graph();
    if (!g) throw new Error("no Web Audio");
    return await g.ctx.decodeAudioData(bytes);
  }

  /** Mono float PCM (−1..1) as an AudioBuffer at its own sample rate (the context resamples). */
  fromPcm(pcm: Float32Array, sampleRate: number): AudioBuffer {
    const g = this.graph();
    if (!g) throw new Error("no Web Audio");
    const buf = g.ctx.createBuffer(1, Math.max(1, pcm.length), sampleRate);
    buf.copyToChannel(pcm.length ? (pcm as Float32Array<ArrayBuffer>) : new Float32Array(1), 0);
    return buf;
  }

  /** Plays one buffer; resolves when it ends or is stopped (`stop()` or the signal). */
  play(buffer: AudioBuffer, signal?: AbortSignal): Promise<void> {
    const g = this.graph();
    if (!g) return Promise.reject(new Error("no Web Audio"));
    this.stop();
    if (g.ctx.state === "suspended") void g.ctx.resume().catch(() => {});
    return new Promise<void>((resolve) => {
      const src = g.ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(g.analyser);
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        signal?.removeEventListener("abort", stopIt);
        try {
          src.disconnect();
        } catch {
          /* already */
        }
        if (this.current === src) {
          this.current = null;
          this.stopCurrent = null;
        }
        resolve();
      };
      const stopIt = () => {
        try {
          src.stop();
        } catch {
          /* not started */
        }
        finish();
      };
      src.onended = finish;
      this.current = src;
      this.stopCurrent = stopIt;
      if (signal?.aborted) return stopIt();
      signal?.addEventListener("abort", stopIt);
      src.start();
    });
  }

  stop(): void {
    this.stopCurrent?.();
  }

  close(): void {
    this.stop();
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.analyserNode = null;
  }
}

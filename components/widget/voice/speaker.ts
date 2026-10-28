/**
 * Spoken replies (owner: A4, P8.3): one reply at a time, chunked (≤ 400 chars), the next chunk
 * synthesised while the current one plays, and a fallback ladder per chunk:
 *
 *   Supertonic in the browser (opted in and ready, and only for its languages: not zh or th)
 *   → server TTS (/api/voice/tts: server Supertonic, Google or mock) → the browser's speechSynthesis
 *   (rhythm mouth) → text only
 *
 * The language is the reply's own (any language, ADR-057). A language Google has no voice for
 * (lib/voice/voices.ts) and Supertonic doesn't speak is never sent anywhere: the reply stays text only.
 *
 * `cancel()` (new message, mic press, panel close, mute) stops playback at once and drops anything
 * still being synthesised: every async step checks a generation counter.
 */
import { isLocale, type Locale } from "@/lib/i18n";
import { hasGoogleTtsVoice } from "@/lib/voice/voices";
import { synthesize, VoiceHttpError, type ServerEngine } from "./api";
import type { VoiceAudio } from "./audio";
import { NoBrowserVoiceError, speakWithBrowser } from "./browserTts";
import { isSupertonicLang } from "./supertonic/inference";
import { chunksForSpeech } from "./text";

export type EngineName = "local" | ServerEngine | "browser";

/** Supertonic running in this browser (components/widget/voice/supertonic/client.ts). */
export interface LocalEngine {
  ready(): boolean;
  synth(text: string, lang: Locale, signal: AbortSignal): Promise<{ pcm: Float32Array; sampleRate: number }>;
}

export interface SpeakerState {
  /** Audio (or the browser voice) is playing. */
  speaking: boolean;
  /** Waiting for the first chunk's audio. */
  preparing: boolean;
  engine: EngineName | null;
  /** True when the mouth can follow the real audio (AnalyserNode); false for speechSynthesis. */
  analysed: boolean;
}

export const IDLE: SpeakerState = { speaking: false, preparing: false, engine: null, analysed: false };

/** True when some engine can voice `lang`: a Google voice exists or Supertonic speaks it. Else text only. */
export function canSpeak(lang: string): boolean {
  return hasGoogleTtsVoice(lang) || isSupertonicLang(lang);
}

export interface SpeakerDeps {
  audio: VoiceAudio;
  sessionId: string;
  fetchImpl?: typeof fetch;
  local?: () => LocalEngine | null;
  /** speechSynthesis stand-in for tests; null disables the browser fallback. */
  browserSpeak?: ((text: string, lang: string, signal: AbortSignal) => Promise<void>) | null;
  /** Bench / diagnostics: one call per synthesised chunk. */
  onTiming?(t: { engine: EngineName; lang: string; chars: number; ms: number }): void;
}

type Clip = { kind: "audio"; buffer: AudioBuffer; engine: EngineName } | { kind: "browser"; text: string };

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export class Speaker {
  private gen = 0;
  private ctrl: AbortController | null = null;
  private state: SpeakerState = IDLE;
  /** The server said "cap reached" (429): don't ask again in this page session. */
  private serverCapped = false;
  private browserMissing = new Set<string>();

  constructor(
    private readonly deps: SpeakerDeps,
    private readonly onState: (s: SpeakerState) => void = () => {},
  ) {}

  private emit(s: SpeakerState) {
    if (s.speaking === this.state.speaking && s.preparing === this.state.preparing && s.engine === this.state.engine && s.analysed === this.state.analysed) return;
    this.state = s;
    this.onState(s);
  }

  get current(): SpeakerState {
    return this.state;
  }

  /** Stops whatever is playing or being prepared. */
  cancel(): void {
    this.gen++;
    this.ctrl?.abort();
    this.ctrl = null;
    this.deps.audio.stop();
    this.emit(IDLE);
  }

  /** Speaks a reply (cancelling any previous one). Resolves when it is done or cancelled. */
  async speak(text: string, lang: string): Promise<void> {
    this.cancel();
    if (!canSpeak(lang)) return;
    const chunks = chunksForSpeech(text);
    if (!chunks.length) return;
    const gen = this.gen;
    const ctrl = new AbortController();
    this.ctrl = ctrl;
    const live = () => gen === this.gen;
    this.emit({ ...IDLE, preparing: true });
    try {
      let next: Promise<Clip | null> | null = this.prepare(chunks[0], lang, ctrl.signal);
      for (let i = 0; i < chunks.length && next; i++) {
        const clip: Clip | null = await next;
        if (!live() || !clip) return;
        next = i + 1 < chunks.length ? this.prepare(chunks[i + 1], lang, ctrl.signal) : null;
        if (clip.kind === "audio") {
          this.emit({ speaking: true, preparing: false, engine: clip.engine, analysed: true });
          await this.deps.audio.play(clip.buffer, ctrl.signal);
        } else {
          this.emit({ speaking: true, preparing: false, engine: "browser", analysed: false });
          const ok = await this.speakBrowser(clip.text, lang, ctrl.signal);
          if (!ok) return;
        }
        if (!live()) return;
      }
    } finally {
      if (live()) {
        this.ctrl = null;
        this.emit(IDLE);
      }
    }
  }

  private async speakBrowser(text: string, lang: string, signal: AbortSignal): Promise<boolean> {
    const say = this.deps.browserSpeak === undefined ? speakWithBrowser : this.deps.browserSpeak;
    if (!say) return false;
    try {
      await say(text, lang, signal);
      return true;
    } catch (err) {
      if (err instanceof NoBrowserVoiceError) this.browserMissing.add(lang);
      return false;
    }
  }

  /** Audio for one chunk from the best engine available; never throws. */
  private async prepare(text: string, lang: string, signal: AbortSignal): Promise<Clip | null> {
    const local = this.deps.local?.();
    if (local?.ready() && isSupertonicLang(lang) && isLocale(lang)) {
      const t0 = now();
      try {
        const { pcm, sampleRate } = await local.synth(text, lang, signal);
        this.deps.onTiming?.({ engine: "local", lang, chars: text.length, ms: now() - t0 });
        if (signal.aborted) return null;
        return { kind: "audio", buffer: this.deps.audio.fromPcm(pcm, sampleRate), engine: "local" };
      } catch {
        if (signal.aborted) return null;
        /* fall through to the server */
      }
    }
    if (!this.serverCapped && this.deps.audio.supported) {
      const t0 = now();
      try {
        const { bytes, engine } = await synthesize(text, lang, { fetchImpl: this.deps.fetchImpl, sessionId: this.deps.sessionId, signal });
        const buffer = await this.deps.audio.decode(bytes);
        this.deps.onTiming?.({ engine, lang, chars: text.length, ms: now() - t0 });
        return { kind: "audio", buffer, engine };
      } catch (err) {
        if (signal.aborted) return null;
        if (err instanceof VoiceHttpError && err.status === 429) this.serverCapped = true;
      }
    }
    if (this.deps.browserSpeak === null || this.browserMissing.has(lang)) return null;
    return { kind: "browser", text };
  }
}

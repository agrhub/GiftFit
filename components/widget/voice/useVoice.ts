"use client";
/**
 * Voice state for the widget panel (owner: A4, P8.3): the mute toggle (remembered per viewer, OFF by
 * default), the speaker (spoken replies with the fallback ladder), and the optional in-browser
 * Supertonic "natural voice". WidgetApp owns one instance.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { localeFromText, type Locale } from "@/lib/i18n";
import { VoiceAudio } from "./audio";
import { naturalVoiceAvailable } from "./capability";
import { naturalDismissed, naturalOptedIn, setNaturalDismissed, setNaturalOptedIn, setVoiceOn, voiceOn, voiceSessionId } from "./prefs";
import { IDLE, Speaker, type EngineName, type SpeakerState } from "./speaker";
import { SupertonicClient, type NaturalStatus } from "./supertonic/client";
import type { ExecutionProvider, ReadyTimings } from "./supertonic/protocol";

export interface VoiceTiming {
  engine: EngineName;
  lang: Locale;
  chars: number;
  ms: number;
}

export interface UseVoiceOptions {
  locale: Locale;
  /** Panel open: closing it stops speech. */
  open: boolean;
  fetchImpl?: typeof fetch;
  /** Test seams. */
  audio?: VoiceAudio;
  natural?: { available?: () => Promise<boolean>; client?: (onStatus: (s: NaturalStatus) => void, onReady: (t: ReadyTimings & { ep: ExecutionProvider }) => void) => SupertonicClient };
  browserSpeak?: ((text: string, lang: Locale, signal: AbortSignal) => Promise<void>) | null;
  /** Bench: denoising steps for Supertonic. */
  steps?: number;
  /** Bench: force the WASM execution provider. */
  forceEp?: ExecutionProvider;
}

export interface Voice {
  on: boolean;
  toggle(): void;
  /** The mic was pressed: voice on, audio unlocked, current speech stopped. */
  onMicStart(): void;
  speak(text: string): void;
  cancel(): void;
  state: SpeakerState;
  /** The analyser to drive the mouth from while server/Supertonic audio plays. */
  analyser: AnalyserNode | null;
  sessionId: string;
  natural: {
    available: boolean;
    status: NaturalStatus;
    dismissed: boolean;
    download(): void;
    cancel(): void;
    dismiss(): void;
    turnOff(): void;
    retry(): void;
  };
  timings: VoiceTiming[];
  ready: (ReadyTimings & { ep: ExecutionProvider }) | null;
  /** Bench: synthesise with the local engine only. */
  benchLocal(text: string, lang: Locale): Promise<number | null>;
}

export function useVoice({ locale, open, fetchImpl, audio: audioIn, natural: naturalSeams, browserSpeak, steps, forceEp }: UseVoiceOptions): Voice {
  const [on, setOn] = useState(false);
  const [state, setState] = useState<SpeakerState>(IDLE);
  const [sessionId, setSessionId] = useState("");
  const [available, setAvailable] = useState(false);
  const [status, setStatus] = useState<NaturalStatus>({ kind: "unavailable" });
  const [dismissed, setDismissed] = useState(false);
  const [timings, setTimings] = useState<VoiceTiming[]>([]);
  const [ready, setReady] = useState<(ReadyTimings & { ep: ExecutionProvider }) | null>(null);

  const audio = useMemo(() => audioIn ?? new VoiceAudio(), [audioIn]);
  const client = useRef<SupertonicClient | null>(null);
  const speakerRef = useRef<Speaker | null>(null);
  const localeRef = useRef(locale);
  useEffect(() => {
    localeRef.current = locale;
  }, [locale]);

  // Preferences and the session id live in the iframe origin's storage: read after mount.
  useEffect(() => {
    setOn(voiceOn());
    setDismissed(naturalDismissed());
    setSessionId(voiceSessionId());
  }, []);

  const speaker = useMemo(() => {
    if (!sessionId) return null;
    const s = new Speaker(
      {
        audio,
        sessionId,
        fetchImpl,
        local: () => client.current,
        ...(browserSpeak !== undefined ? { browserSpeak } : {}),
        onTiming: (t) => {
          setTimings((ts) => [...ts.slice(-19), t]);
          if (process.env.NODE_ENV !== "production") console.info(`[voice] ${t.engine} ${t.lang} ${t.chars} chars in ${Math.round(t.ms)} ms`);
        },
      },
      setState,
    );
    speakerRef.current = s;
    return s;
  }, [audio, sessionId, fetchImpl, browserSpeak]);

  useEffect(
    () => () => {
      speaker?.cancel();
    },
    [speaker],
  );
  useEffect(() => () => audio.close(), [audio]);

  // Natural voice: offered only on desktop with WebGPU, and only once voice is on.
  useEffect(() => {
    if (!on) return;
    let alive = true;
    void (naturalSeams?.available ?? naturalVoiceAvailable)().then((ok) => {
      if (!alive) return;
      setAvailable(ok);
      if (!ok || client.current) return;
      const onReadyTimings = (t: ReadyTimings & { ep: ExecutionProvider }) => {
        setReady(t);
        setNaturalOptedIn(true);
        console.info(`[voice] natural voice ready on ${t.ep}: weights ${t.weightsMs} ms (${t.downloaded} B downloaded), sessions ${t.sessionMs} ms, warm-up ${t.warmupMs} ms`, t.perModelMs);
      };
      const c = naturalSeams?.client ? naturalSeams.client(setStatus, onReadyTimings) : new SupertonicClient({ onStatus: setStatus, onReady: onReadyTimings, fetchImpl, steps, forceEp });
      client.current = c;
      void c.probe().then((p) => {
        // Opted in before and everything is cached on this site: load it without downloading.
        if (alive && p && naturalOptedIn() && p.cached >= p.total) c.start(false);
      });
    });
    return () => {
      alive = false;
    };
  }, [on, naturalSeams, fetchImpl, steps, forceEp]);

  useEffect(() => () => client.current?.dispose(), []);

  const cancel = useCallback(() => speakerRef.current?.cancel(), []);

  useEffect(() => {
    if (!open) cancel();
  }, [open, cancel]);

  const onRef = useRef(on);
  useEffect(() => {
    onRef.current = on;
  }, [on]);

  const toggle = useCallback(() => {
    const next = !onRef.current;
    onRef.current = next;
    setOn(next);
    setVoiceOn(next);
    if (next) audio.unlock();
    else speakerRef.current?.cancel();
  }, [audio]);

  const onMicStart = useCallback(() => {
    audio.unlock();
    speakerRef.current?.cancel();
    if (onRef.current) return;
    onRef.current = true;
    setOn(true);
    setVoiceOn(true);
  }, [audio]);

  const speak = useCallback((text: string) => {
    if (!onRef.current) return;
    const lang = localeFromText(text) ?? localeRef.current;
    void speakerRef.current?.speak(text, lang);
  }, []);

  const natural = useMemo(
    () => ({
      available,
      status,
      dismissed,
      download: () => {
        audio.unlock();
        client.current?.start(true);
      },
      cancel: () => client.current?.cancel(),
      dismiss: () => {
        setNaturalDismissed();
        setDismissed(true);
      },
      turnOff: () => {
        setNaturalOptedIn(false);
        client.current?.dispose();
        void client.current?.probe();
      },
      retry: () => void client.current?.probe(),
    }),
    [available, status, dismissed, audio],
  );

  const benchLocal = useCallback(async (text: string, lang: Locale) => {
    const c = client.current;
    if (!c?.ready()) return null;
    const t0 = performance.now();
    await c.synth(text, lang, new AbortController().signal);
    return performance.now() - t0;
  }, []);

  return {
    on,
    toggle,
    onMicStart,
    speak,
    cancel,
    state,
    analyser: state.speaking && state.analysed ? audio.analyser : null,
    sessionId,
    natural,
    timings,
    ready,
    benchLocal,
  };
}

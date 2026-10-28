"use client";
/**
 * Voice state for the widget panel (owner: A4, P8.3): the mute toggle (remembered per viewer, OFF by
 * default) and the speaker (spoken replies with the fallback ladder: Google Cloud TTS on the server,
 * then the browser's own voice, then text only; ADR-059). WidgetApp owns one instance.
 * Each reply is spoken in its own language (detectLanguage), else the conversation's, else the UI's.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { detectLanguage, type Locale } from "@/lib/i18n";
import { VoiceAudio } from "./audio";
import { setVoiceOn, voiceOn, voiceSessionId } from "./prefs";
import { IDLE, Speaker, type SpeakerState } from "./speaker";

export interface UseVoiceOptions {
  locale: Locale;
  /** The conversation's language (any code): replies whose own language is unclear are spoken in it. */
  conversationLang?: string;
  /** Panel open: closing it stops speech. */
  open: boolean;
  fetchImpl?: typeof fetch;
  /** Test seams. */
  audio?: VoiceAudio;
  browserSpeak?: ((text: string, lang: string, signal: AbortSignal) => Promise<void>) | null;
}

export interface Voice {
  on: boolean;
  toggle(): void;
  /** The mic was pressed: voice on, audio unlocked, current speech stopped. */
  onMicStart(): void;
  speak(text: string): void;
  cancel(): void;
  state: SpeakerState;
  /** The analyser to drive the mouth from while server audio plays. */
  analyser: AnalyserNode | null;
  sessionId: string;
}

export function useVoice({ locale, conversationLang, open, fetchImpl, audio: audioIn, browserSpeak }: UseVoiceOptions): Voice {
  const [on, setOn] = useState(false);
  const [state, setState] = useState<SpeakerState>(IDLE);
  const [sessionId, setSessionId] = useState("");

  const audio = useMemo(() => audioIn ?? new VoiceAudio(), [audioIn]);
  const speakerRef = useRef<Speaker | null>(null);
  const localeRef = useRef(locale);
  const convRef = useRef(conversationLang);
  useEffect(() => {
    localeRef.current = locale;
    convRef.current = conversationLang;
  }, [locale, conversationLang]);

  // Preferences and the session id live in the iframe origin's storage: read after mount.
  useEffect(() => {
    setOn(voiceOn());
    setSessionId(voiceSessionId());
  }, []);

  const speaker = useMemo(() => {
    if (!sessionId) return null;
    const s = new Speaker(
      {
        audio,
        sessionId,
        fetchImpl,
        ...(browserSpeak !== undefined ? { browserSpeak } : {}),
        onTiming: (t) => {
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
    const lang = detectLanguage(text) ?? convRef.current ?? localeRef.current;
    void speakerRef.current?.speak(text, lang);
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
  };
}

"use client";
/**
 * Push-to-talk mic button for the widget chat (owner: A4, P8.3).
 *
 *   hold (mouse/touch/pen, or Space while focused) → records while held, sends on release
 *   quick tap (< 350 ms), Enter, or a screen reader's activation → tap-to-start / tap-to-stop
 *   15 s cap with a visible timer and level meter; Escape discards
 *
 * The first use shows a short notice (once per viewer, GiftFit origin). Its "Continue" only ARMS the
 * mic: it asks for the browser's permission (the prompt appears now, not mid-sentence) and then says
 * "hold the mic to talk, or tap to start and stop". Nothing is recorded until the shopper presses the
 * mic themselves, so a natural second tap can't cut a clip that started on "Continue".
 * Clips go to /api/voice/stt in the widget's UI language; the transcript is sent as the shopper's
 * message. Errors fall back to typing with a short explanation.
 */
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { Locale, MessageKey } from "@/lib/i18n";
import { useMouthFromAudio } from "@/components/widget/character";
import { transcribe, VoiceHttpError } from "./api";
import { micNoticeSeen, setMicNoticeSeen } from "./prefs";
import { MAX_CLIP_MS, MIN_CLIP_MS, micErrorKind, requestMicAccess, startRecording, type Recording } from "./recorder";

export type MicPhase = "idle" | "notice" | "starting" | "recording" | "transcribing";

export interface MicButtonProps {
  tr: (key: MessageKey, vars?: Record<string, string | number>) => string;
  lang: Locale;
  sessionId: string;
  disabled?: boolean;
  fetchImpl?: typeof fetch;
  /** Recording starts: stop speech, turn voice on, unlock audio (a user gesture). */
  onStart(): void;
  onPhase?(p: MicPhase): void;
  onTranscript(text: string): void;
  /** Test seams. */
  record?: () => Promise<Recording>;
  requestMic?: () => Promise<void>;
}

const TAP_MS = 350;

function sttErrorKey(err: unknown): MessageKey {
  if (err instanceof VoiceHttpError) {
    if (err.status === 429) return "voice.sttLimit";
    if (err.status === 400 || err.status === 413) return "voice.notHeard";
  }
  return "voice.sttDown";
}

function micErrorKey(err: unknown): MessageKey {
  const k = micErrorKind(err);
  return k === "denied" ? "voice.micDenied" : k === "no-device" ? "voice.micMissing" : "voice.micError";
}

export function MicButton({ tr, lang, sessionId, disabled, fetchImpl, onStart, onPhase, onTranscript, record = startRecording, requestMic = requestMicAccess }: MicButtonProps) {
  const ids = { notice: useId(), status: useId() };
  const [phase, setPhaseState] = useState<MicPhase>("idle");
  const [error, setError] = useState<MessageKey | null>(null);
  /** A non-error hint in the status bubble (after the notice: how to talk). */
  const [info, setInfo] = useState<MessageKey | null>(null);
  const [arming, setArming] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const [elapsed, setElapsed] = useState(0);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const level = useMouthFromAudio(stream);

  const phaseRef = useRef<MicPhase>("idle");
  const rec = useRef<Recording | null>(null);
  const mode = useRef<"hold" | "toggle">("hold");
  const pressAt = useRef(0);
  const releasedWhileStarting = useRef(false);
  const ignoreClick = useRef(false);
  const ignoreUp = useRef(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const abort = useRef<AbortController | null>(null);
  const cb = useRef({ onStart, onPhase, onTranscript });
  useEffect(() => {
    cb.current = { onStart, onPhase, onTranscript };
  });

  const setPhase = useCallback((p: MicPhase) => {
    phaseRef.current = p;
    setPhaseState(p);
    cb.current.onPhase?.(p);
  }, []);

  const clearTimer = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  };

  const discard = useCallback(() => {
    clearTimer();
    rec.current?.cancel();
    rec.current = null;
    setStream(null);
    abort.current?.abort();
    if (phaseRef.current !== "idle") setPhase("idle");
  }, [setPhase]);

  useEffect(() => () => discard(), [discard]);

  const finish = useCallback(async () => {
    const r = rec.current;
    if (!r || phaseRef.current !== "recording") return;
    clearTimer();
    rec.current = null;
    setStream(null);
    const ms = Date.now() - r.startedAt;
    const clip = await r.stop();
    if (ms < MIN_CLIP_MS || clip.size === 0) {
      setError("voice.tooShort");
      setPhase("idle");
      return;
    }
    setPhase("transcribing");
    const ctrl = new AbortController();
    abort.current = ctrl;
    try {
      const { text } = await transcribe(clip, lang, { fetchImpl, sessionId, signal: ctrl.signal });
      if (ctrl.signal.aborted) return;
      if (!text) setError("voice.notHeard");
      else cb.current.onTranscript(text);
    } catch (err) {
      if (!ctrl.signal.aborted) setError(sttErrorKey(err));
    } finally {
      if (abort.current === ctrl) {
        abort.current = null;
        setPhase("idle");
      }
    }
  }, [fetchImpl, lang, sessionId, setPhase]);

  const begin = useCallback(
    async (m: "hold" | "toggle") => {
      if (phaseRef.current !== "idle" && phaseRef.current !== "notice") return;
      setError(null);
      setInfo(null);
      if (!micNoticeSeen()) {
        setPhase("notice");
        return;
      }
      mode.current = m;
      pressAt.current = Date.now();
      releasedWhileStarting.current = false;
      cb.current.onStart();
      setPhase("starting");
      let r: Recording;
      try {
        r = await record();
      } catch (err) {
        setError(micErrorKey(err));
        setPhase("idle");
        return;
      }
      if ((phaseRef.current as MicPhase) !== "starting") {
        r.cancel();
        return;
      }
      // Released while the browser was still asking for permission: keep recording (tap mode).
      if (releasedWhileStarting.current) mode.current = "toggle";
      rec.current = r;
      setStream(r.stream);
      setElapsed(0);
      setPhase("recording");
      timer.current = setInterval(() => {
        const ms = Date.now() - r.startedAt;
        setElapsed(ms);
        if (ms >= MAX_CLIP_MS) void finish();
      }, 100);
    },
    [finish, record, setPhase],
  );

  /** "Continue" on the notice: permission now, recording only when the shopper presses the mic. */
  const arm = useCallback(async () => {
    setMicNoticeSeen();
    setPhase("idle");
    cb.current.onStart(); // a user gesture: voice on, audio unlocked
    setArming(true);
    try {
      await requestMic();
      setInfo("voice.micHint");
    } catch (err) {
      setError(micErrorKey(err));
    } finally {
      setArming(false);
    }
  }, [requestMic, setPhase]);

  // Armed: focus the mic (it was disabled while the permission prompt was up) so Space talks.
  useEffect(() => {
    if (info === "voice.micHint" && !arming) button.current?.focus();
  }, [info, arming]);

  const release = useCallback(() => {
    if (ignoreUp.current) {
      ignoreUp.current = false;
      return;
    }
    if (mode.current !== "hold") return;
    if (phaseRef.current === "starting") {
      releasedWhileStarting.current = true;
      return;
    }
    if (phaseRef.current !== "recording") return;
    if (Date.now() - pressAt.current < TAP_MS) mode.current = "toggle";
    else void finish();
  }, [finish]);

  const press = useCallback(() => {
    if (phaseRef.current === "recording" || phaseRef.current === "starting") {
      // Second tap in tap mode: stop and send.
      ignoreUp.current = true;
      if (phaseRef.current === "recording") void finish();
      else discard();
      return;
    }
    void begin("hold");
  }, [begin, discard, finish]);

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button > 0 || disabled) return;
    e.preventDefault();
    ignoreClick.current = true;
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      /* synthetic pointer */
    }
    press();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (e.key === "Escape" && phaseRef.current !== "idle") {
      e.preventDefault();
      e.stopPropagation();
      discard();
      return;
    }
    if (e.key === " ") {
      e.preventDefault(); // no native click, no page scroll
      if (!e.repeat) press();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (e.repeat) return;
      if (phaseRef.current === "recording") void finish();
      else if (phaseRef.current === "idle") void begin("toggle");
    }
  };

  const onKeyUp = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === " ") {
      e.preventDefault();
      release();
    }
  };

  // Activation without pointer or key events (screen readers, switch access): tap mode.
  const onClick = () => {
    if (ignoreClick.current) {
      ignoreClick.current = false;
      return;
    }
    if (disabled) return;
    if (phaseRef.current === "recording") void finish();
    else if (phaseRef.current === "idle") void begin("toggle");
  };

  const recording = phase === "recording" || phase === "starting";
  const busy = phase === "transcribing";
  const sec = Math.min(MAX_CLIP_MS, elapsed) / 1000;

  return (
    <div className="relative">
      {phase === "notice" && (
        <div role="dialog" aria-labelledby={ids.notice} className="absolute right-0 bottom-full z-10 mb-2 w-72 rounded-2xl border border-line bg-white p-4 text-left text-sm text-ink shadow-xl" data-testid="voice-mic-notice">
          <p id={ids.notice} className="mb-1 font-semibold">
            {tr("voice.noticeTitle")}
          </p>
          <p className="text-ink-soft">{tr("voice.notice")}</p>
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" onClick={() => setPhase("idle")} className="min-h-11 rounded-full px-4 text-sm text-ink-soft hover:bg-ivory">
              {tr("voice.noticeCancel")}
            </button>
            <button
              type="button"
              autoFocus
              data-testid="voice-mic-notice-ok"
              onClick={() => void arm()}
              className="min-h-11 rounded-full bg-ink px-4 text-sm font-medium text-ivory hover:bg-ink-soft"
            >
              {tr("voice.noticeOk")}
            </button>
          </div>
        </div>
      )}
      {(recording || busy || error || info) && (
        <div id={ids.status} role="status" className="absolute right-0 bottom-full mb-2 w-64 rounded-xl border border-line bg-white px-3 py-2 text-xs text-ink shadow-lg" data-testid="voice-mic-status">
          {recording ? (
            <div className="flex items-center gap-2">
              <span aria-hidden="true" className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-rose" />
              <span className="flex-1">{tr("voice.recording", { sec: sec.toFixed(0), max: MAX_CLIP_MS / 1000 })}</span>
              <span role="meter" aria-label={tr("voice.level")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)} className="h-2 w-12 overflow-hidden rounded-full bg-line" data-testid="voice-level">
                <span className="block h-full bg-ink transition-[width] duration-75" style={{ width: `${Math.round(level * 100)}%` }} />
              </span>
            </div>
          ) : busy ? (
            tr("voice.transcribing")
          ) : error ? (
            <span className="text-rose">{tr(error)}</span>
          ) : info ? (
            <span data-testid="voice-mic-ready">{tr(info)}</span>
          ) : null}
          {recording && (
            <span aria-hidden="true" className="mt-1 block h-0.5 overflow-hidden rounded bg-line">
              <span className="block h-full bg-rose" style={{ width: `${(sec / (MAX_CLIP_MS / 1000)) * 100}%` }} />
            </span>
          )}
        </div>
      )}
      <button
        type="button"
        data-testid="voice-mic"
        data-phase={phase}
        ref={button}
        disabled={disabled || busy || arming}
        aria-label={recording ? tr("voice.micStop") : tr("voice.mic")}
        aria-pressed={recording}
        aria-describedby={recording || busy || error || info ? ids.status : undefined}
        title={tr("voice.micHint")}
        onPointerDown={onPointerDown}
        onPointerUp={release}
        onPointerCancel={release}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onClick={onClick}
        onBlur={() => mode.current === "hold" && phaseRef.current === "recording" && release()}
        className={`mb-5 flex h-11 w-11 shrink-0 touch-none items-center justify-center rounded-full border select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:opacity-50 ${recording ? "border-rose bg-rose text-white" : "border-line-strong bg-white text-ink hover:border-ink"}`}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <rect x="9" y="3" width="6" height="11" rx="3" />
          <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
        </svg>
      </button>
    </div>
  );
}

/**
 * Microphone capture for push-to-talk (owner: A4, P8.3): getUserMedia → MediaRecorder, Opus in WebM
 * where supported, AAC in MP4 on older Safari (Speech-to-Text V2 decodes both). The clip is capped at
 * MAX_CLIP_MS by the caller's timer; the stream's tracks are always stopped afterwards so the
 * browser's recording indicator goes away.
 */

export const MAX_CLIP_MS = 15_000;
export const MIN_CLIP_MS = 400;

const PREFERRED = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg;codecs=opus"];

export function pickMimeType(isTypeSupported: (t: string) => boolean): string {
  for (const t of PREFERRED) {
    try {
      if (isTypeSupported(t)) return t;
    } catch {
      /* keep looking */
    }
  }
  return "";
}

/** Can this browser record at all (secure context, getUserMedia, MediaRecorder)? */
export function micSupported(): boolean {
  try {
    return typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function" && typeof MediaRecorder === "function";
  } catch {
    return false;
  }
}

export type MicErrorKind = "denied" | "no-device" | "unsupported" | "error";

export function micErrorKind(err: unknown): MicErrorKind {
  const name = (err as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return "denied";
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError" || name === "NotReadableError") return "no-device";
  if (name === "NotSupportedError" || name === "TypeError") return "unsupported";
  return "error";
}

/**
 * Asks for microphone permission without recording: the stream is stopped at once, so the browser's
 * recording indicator only flashes. Rejects like getUserMedia (NotAllowedError, NotFoundError, …).
 */
export async function requestMicAccess(): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks().forEach((t) => t.stop());
}

export interface Recording {
  stream: MediaStream;
  mimeType: string;
  startedAt: number;
  /** Stops and returns the clip (empty Blob when nothing was captured). */
  stop(): Promise<Blob>;
  /** Stops and discards. */
  cancel(): void;
}

export async function startRecording(): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
  const release = () => stream.getTracks().forEach((t) => t.stop());
  let rec: MediaRecorder;
  try {
    const mimeType = pickMimeType((t) => MediaRecorder.isTypeSupported(t));
    rec = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 32_000 });
  } catch (err) {
    release();
    throw err;
  }
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  const stopped = new Promise<void>((resolve) => {
    rec.onstop = () => resolve();
    rec.onerror = () => resolve();
  });
  rec.start(250);
  const mimeType = rec.mimeType || "audio/webm";
  let finished = false;
  const end = async (keep: boolean): Promise<Blob> => {
    if (!finished) {
      finished = true;
      try {
        if (rec.state !== "inactive") rec.stop();
      } catch {
        /* already stopped */
      }
      await Promise.race([stopped, new Promise((r) => setTimeout(r, 1500))]);
      release();
    }
    return keep ? new Blob(chunks, { type: mimeType.split(";")[0] === "audio/mp4" ? "audio/mp4" : mimeType }) : new Blob([]);
  };
  return {
    stream,
    mimeType,
    startedAt: Date.now(),
    stop: () => end(true),
    cancel: () => void end(false),
  };
}

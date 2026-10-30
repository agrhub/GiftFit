/**
 * Per-viewer voice preferences (owner: A4, P8.3). Stored in the GiftFit iframe origin's localStorage
 * (partitioned per store site by the browser), never sent anywhere. Every access is guarded: storage
 * can throw in private windows or with site data blocked, and the widget then simply forgets.
 */

export const VOICE_ON_KEY = "giftfit.voice.on";
export const MIC_NOTICE_KEY = "giftfit.voice.micNotice";
export const SESSION_KEY = "giftfit.voice.session";

function local(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function read(key: string, store: Storage | null = local()): string | null {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(key: string, value: string | null, store: Storage | null = local()): void {
  try {
    if (value === null) store?.removeItem(key);
    else store?.setItem(key, value);
  } catch {
    /* storage full or blocked: forget silently */
  }
}

/** Spoken replies: OFF until the shopper turns them on (or uses the mic). */
export const voiceOn = () => read(VOICE_ON_KEY) === "1";
export const setVoiceOn = (on: boolean) => write(VOICE_ON_KEY, on ? "1" : "0");

/** The first-mic notice has been acknowledged in this browser (for the GiftFit origin). */
export const micNoticeSeen = () => read(MIC_NOTICE_KEY) === "1";
export const setMicNoticeSeen = () => write(MIC_NOTICE_KEY, "1");

/** A version-4 UUID (the server accepts only that shape for `x-voice-session`). */
function randomId(): string {
  try {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    /* insecure context: build one below */
  }
  const b = new Uint8Array(16);
  try {
    crypto.getRandomValues(b);
  } catch {
    for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  }
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let memorySession: string | null = null;
let memoryOnly = false;

/**
 * A random id for this page session (one tab of one store page), sent as `x-voice-session` so the
 * server can apply its per-session voice caps. Not linked to anything else; sessionStorage of the
 * GiftFit origin, so a reload keeps it and a new tab gets a new one.
 */
export function voiceSessionId(): string {
  let store: Storage | null = null;
  try {
    store = window.sessionStorage;
  } catch {
    store = null;
  }
  const existing = (store && read(SESSION_KEY, store)) || (memoryOnly ? memorySession : null);
  if (existing && UUID.test(existing)) return existing;
  const id = randomId();
  memorySession = id;
  write(SESSION_KEY, id, store);
  // Storage blocked or full: keep the id in memory for this page instead.
  memoryOnly = read(SESSION_KEY, store) !== id;
  return id;
}

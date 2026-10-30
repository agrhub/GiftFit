/**
 * Google Cloud Speech-to-Text V2 and Text-to-Speech engines (owner: A13, ADR-052). Auth is ADC (the
 * Cloud Run service account giftfit-run; `gcloud auth application-default login` locally). No keys.
 *
 * STT: synchronous Recognize on the implicit recognizer `projects/<p>/locations/us/recognizers/_`
 * at us-speech.googleapis.com, model chirp_3, autoDecodingConfig (WebM/Opus, Ogg/Opus, MP4/AAC),
 * automatic language identification (languageCodes ["auto"]; or, with VOICE_STT_LANGUAGE=fixed, the
 * widget's language: STT_LANGUAGE_CODES en-US, vi-VN, ja-JP, cmn-Hans-CN, …), automatic punctuation.
 * The language chirp_3 reports per result (results[].languageCode) is returned as a base code ("pt").
 * V2 has no data-logging programme; the audio is sent inline and kept nowhere by GiftFit.
 * TTS: synthesizeSpeech with a stock voice (Chirp 3 HD by default, Neural2/Standard fallback), MP3 out.
 *
 * The SDKs are imported on first use only (tests and mock mode never load them) and are server
 * externals (next.config.ts). Clients are process-wide on globalThis.
 */
import { baseLanguage } from "@/server/i18n";
import { gcpProjectId, type Env } from "@/server/store/config";
import {
  MAX_TRANSCRIPT_CHARS,
  STT_ENDPOINT,
  STT_AUTO_LANGUAGE,
  STT_LANGUAGE_CODES,
  STT_LOCATION,
  STT_MODEL,
  STT_TIMEOUT_MS,
  TTS_TIMEOUT_MS,
  sttLanguageMode,
  ttsVoices,
  voiceLanguageCode,
  type SttLanguageMode,
  type TtsLang,
  type VoiceLang,
} from "./config";

// ---- request / response shapes (structural slices of the SDK types) -------------------------------

export interface RecognizeRequest {
  recognizer: string;
  config: {
    autoDecodingConfig: Record<string, never>;
    model: string;
    languageCodes: string[];
    features: { enableAutomaticPunctuation: boolean };
  };
  content: Uint8Array;
}

type LongLike = number | string | { toString(): string } | null | undefined;

export interface RecognizeResponseLike {
  results?: Array<{ alternatives?: Array<{ transcript?: string | null }> | null; languageCode?: string | null }> | null;
  metadata?: { totalBilledDuration?: { seconds?: LongLike; nanos?: number | null } | null } | null;
}

export interface SpeechV2ClientLike {
  recognize(request: RecognizeRequest, options?: { timeout?: number }): Promise<[RecognizeResponseLike, ...unknown[]]>;
  getProjectId(): Promise<string>;
}

export interface SynthesizeRequest {
  input: { text: string };
  voice: { languageCode: string; name: string };
  audioConfig: { audioEncoding: "MP3" };
}

export interface SynthesizeResponseLike {
  audioContent?: Uint8Array | string | null;
}

export interface TtsClientLike {
  synthesizeSpeech(request: SynthesizeRequest, options?: { timeout?: number }): Promise<[SynthesizeResponseLike, ...unknown[]]>;
}

export function recognizerPath(projectId: string): string {
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(projectId)) throw new Error("invalid GCP project id");
  return `projects/${projectId}/locations/${STT_LOCATION}/recognizers/_`;
}

/** `mode` "auto": chirp_3 identifies the language; "fixed": the widget's UI language only. */
export function buildRecognizeRequest(projectId: string, lang: VoiceLang, content: Uint8Array, mode: SttLanguageMode = "auto"): RecognizeRequest {
  return {
    recognizer: recognizerPath(projectId),
    config: {
      autoDecodingConfig: {},
      model: STT_MODEL,
      languageCodes: [mode === "auto" ? STT_AUTO_LANGUAGE : STT_LANGUAGE_CODES[lang]],
      features: { enableAutomaticPunctuation: true },
    },
    content,
  };
}

export function transcriptFromResponse(resp: RecognizeResponseLike): string {
  const parts = (resp.results ?? []).map((r) => r.alternatives?.[0]?.transcript?.trim() ?? "").filter(Boolean);
  return [...parts.join(" ").replace(/\s+/g, " ").trim()].slice(0, MAX_TRANSCRIPT_CHARS).join("");
}

/**
 * The spoken language chirp_3 reports (results[].languageCode, e.g. "pt-br", "cmn-hans-cn") as a base
 * code ("pt", "zh"): the first result with a transcript; undefined when none reports one.
 */
export function languageFromResponse(resp: RecognizeResponseLike): string | undefined {
  for (const r of resp.results ?? []) {
    if (!r.alternatives?.[0]?.transcript?.trim()) continue;
    const l = baseLanguage(r.languageCode ?? undefined);
    if (l) return l;
  }
  return undefined;
}

/** Billed seconds from V2 metadata (each request rounds up to 1 s), else null. */
export function billedSecondsFromResponse(resp: RecognizeResponseLike): number | null {
  const d = resp.metadata?.totalBilledDuration;
  if (!d) return null;
  const s = Number(d.seconds == null ? 0 : String(d.seconds));
  const n = Number(d.nanos ?? 0);
  if (!Number.isFinite(s) || !Number.isFinite(n)) return null;
  return s + n / 1e9;
}

export function buildSynthesizeRequest(text: string, voice: string): SynthesizeRequest {
  return { input: { text }, voice: { languageCode: voiceLanguageCode(voice), name: voice }, audioConfig: { audioEncoding: "MP3" } };
}

export function audioBytes(content: Uint8Array | string | null | undefined): Uint8Array | null {
  if (!content) return null;
  const b = typeof content === "string" ? new Uint8Array(Buffer.from(content, "base64")) : content;
  return b.byteLength > 0 ? b : null;
}

// ---- engines ---------------------------------------------------------------------------------------

export interface SttResult {
  text: string;
  billedSeconds: number | null;
  /** The spoken language as detected by the engine (base code), when it reports one. */
  language?: string;
}

export interface SttEngine {
  readonly name: "google" | "mock";
  transcribe(input: { audio: Uint8Array; lang: VoiceLang }): Promise<SttResult>;
}

export interface TtsResult {
  audio: Uint8Array;
  contentType: string;
  voice: string;
}

export interface TtsEngine {
  readonly name: "google" | "mock";
  synthesize(input: { text: string; lang: TtsLang }): Promise<TtsResult>;
}

/** Error carrying only a gRPC status code / short reason, never request content. */
export class VoiceEngineError extends Error {
  constructor(readonly code: string) {
    super(`voice engine error: ${code}`);
    this.name = "VoiceEngineError";
  }
}

function errCode(err: unknown): string {
  const e = err as { code?: unknown; name?: unknown };
  if (typeof e?.code === "number" || typeof e?.code === "string") return String(e.code);
  return typeof e?.name === "string" ? e.name : "unknown";
}

export function googleSttEngine(client: () => Promise<SpeechV2ClientLike>, env: Env = process.env): SttEngine {
  let project: string | undefined = gcpProjectId(env);
  return {
    name: "google",
    async transcribe({ audio, lang }) {
      try {
        const c = await client();
        project ??= await c.getProjectId();
        const [resp] = await c.recognize(buildRecognizeRequest(project, lang, audio, sttLanguageMode(env)), { timeout: STT_TIMEOUT_MS });
        const language = languageFromResponse(resp);
        return { text: transcriptFromResponse(resp), billedSeconds: billedSecondsFromResponse(resp), ...(language ? { language } : {}) };
      } catch (err) {
        throw new VoiceEngineError(errCode(err));
      }
    },
  };
}

export function googleTtsEngine(client: () => Promise<TtsClientLike>, env: Env = process.env, onFallback?: (code: string) => void): TtsEngine {
  return {
    name: "google",
    async synthesize({ text, lang }) {
      let last = "unknown";
      for (const voice of ttsVoices(lang, env)) {
        try {
          const c = await client();
          const [resp] = await c.synthesizeSpeech(buildSynthesizeRequest(text, voice), { timeout: TTS_TIMEOUT_MS });
          const audio = audioBytes(resp.audioContent);
          if (!audio) throw Object.assign(new Error("empty audio"), { code: "empty_audio" });
          return { audio, contentType: "audio/mpeg", voice };
        } catch (err) {
          last = errCode(err);
          onFallback?.(last);
        }
      }
      throw new VoiceEngineError(last);
    },
  };
}

// ---- process-wide SDK clients ----------------------------------------------------------------------

const CLIENTS_KEY = Symbol.for("giftfit.voice.google.v1");
type ClientState = { speech?: Promise<SpeechV2ClientLike>; tts?: Promise<TtsClientLike> };
const clients = () => {
  const g = globalThis as typeof globalThis & { [CLIENTS_KEY]?: ClientState };
  return (g[CLIENTS_KEY] ??= {});
};

export function speechClient(): Promise<SpeechV2ClientLike> {
  const s = clients();
  s.speech ??= (async () => {
    // CJS interop: in Next's server bundle the package may sit under `default`.
    const mod = (await import("@google-cloud/speech")) as unknown as { v2?: { SpeechClient: new (o: object) => unknown }; default?: { v2?: { SpeechClient: new (o: object) => unknown } } };
    const Ctor = mod.v2?.SpeechClient ?? mod.default?.v2?.SpeechClient;
    if (typeof Ctor !== "function") throw new Error("@google-cloud/speech: v2.SpeechClient not found");
    return new Ctor({ apiEndpoint: STT_ENDPOINT }) as SpeechV2ClientLike;
  })().catch((err) => {
    delete clients().speech;
    throw err;
  });
  return s.speech;
}

export function ttsClient(): Promise<TtsClientLike> {
  const s = clients();
  s.tts ??= (async () => {
    const mod = (await import("@google-cloud/text-to-speech")) as unknown as { TextToSpeechClient?: new () => unknown; default?: { TextToSpeechClient?: new () => unknown } };
    const Ctor = mod.TextToSpeechClient ?? mod.default?.TextToSpeechClient;
    if (typeof Ctor !== "function") throw new Error("@google-cloud/text-to-speech: TextToSpeechClient not found");
    return new Ctor() as TtsClientLike;
  })().catch((err) => {
    delete clients().tts;
    throw err;
  });
  return s.tts;
}

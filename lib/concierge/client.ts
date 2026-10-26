/**
 * Browser client for POST /api/concierge (owner: A7). UI-agnostic: the Concierge panel, and later the
 * embeddable widget (ADR-046), consume the same async iterator of ConciergeEvents. No server imports.
 */
import type { ConciergeChatMessage, ConciergeEvent, ConciergePageContext } from "./types";

export class ConciergeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfterSec?: number,
  ) {
    super(code);
    this.name = "ConciergeHttpError";
  }
}

export interface StreamConciergeOptions {
  endpoint?: string;
  /** Page context from the embeddable widget (product facts only). */
  context?: ConciergePageContext;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

const isEvent = (v: unknown): v is ConciergeEvent => typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string";

/** Parses an NDJSON byte stream into events (tolerates chunk boundaries anywhere; skips bad lines). */
export async function* parseNdjson(body: ReadableStream<Uint8Array>): AsyncGenerator<ConciergeEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buf += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const ev: unknown = JSON.parse(line);
          if (isEvent(ev)) yield ev;
        } catch {
          // ignore a malformed line
        }
      }
      if (done) break;
    }
    const rest = buf.trim();
    if (rest) {
      try {
        const ev: unknown = JSON.parse(rest);
        if (isEvent(ev)) yield ev;
      } catch {
        // ignore
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** POSTs the conversation and yields events as they arrive. Throws ConciergeHttpError on non-200. */
export async function* streamConcierge(messages: readonly ConciergeChatMessage[], opts: StreamConciergeOptions = {}): AsyncGenerator<ConciergeEvent> {
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(opts.endpoint ?? "/api/concierge", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
    body: JSON.stringify(opts.context ? { messages, context: opts.context } : { messages }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    let code = "request_failed";
    try {
      const j = (await res.json()) as { error?: unknown };
      if (typeof j.error === "string") code = j.error;
    } catch {
      // keep the generic code
    }
    const ra = Number(res.headers.get("Retry-After"));
    throw new ConciergeHttpError(res.status, code, Number.isFinite(ra) && ra > 0 ? ra : undefined);
  }
  yield* parseNdjson(res.body);
}

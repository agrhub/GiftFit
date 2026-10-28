"use client";
/**
 * Conversation state for the Gift Concierge (A7's ConciergePanel logic, extracted by A6 so the
 * embeddable widget reuses it with its own UI and i18n). Streams POST /api/concierge through
 * lib/concierge/client.ts; text-only history; one reply at a time; `stop()` aborts the current one.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ConciergeHttpError, streamConcierge } from "@/lib/concierge/client";
import { CONCIERGE_LIMITS, type ConciergeChatMessage, type ConciergeEvent, type ConciergePageContext, type ConciergeToolName } from "@/lib/concierge/types";

export type ConciergeFinalEvent = Extract<ConciergeEvent, { type: "final" }>;

/** Why a reply failed; the UI turns it into words. */
export type ConciergeTurnError = { kind: "rate_limited"; retryAfterSec?: number } | { kind: "too_long" } | { kind: "generic" };

export interface ConciergeUserTurn {
  id: number;
  role: "user";
  text: string;
}
export interface ConciergeAssistantTurn {
  id: number;
  role: "assistant";
  text: string;
  tools: Array<{ name: ConciergeToolName; summary: string }>;
  final?: ConciergeFinalEvent;
  pending: boolean;
  /** The reply was stopped by the shopper. */
  stopped?: boolean;
  error?: ConciergeTurnError;
}
export type ConciergeTurn = ConciergeUserTurn | ConciergeAssistantTurn;

export function turnError(err: unknown): ConciergeTurnError {
  if (err instanceof ConciergeHttpError) {
    if (err.status === 429) return { kind: "rate_limited", retryAfterSec: err.retryAfterSec };
    if (err.code === "message_too_long") return { kind: "too_long" };
  }
  return { kind: "generic" };
}

export interface UseConciergeChatOptions {
  endpoint?: string;
  fetchImpl?: typeof fetch;
  /** Page context sent with every message (embeddable widget). */
  context?: ConciergePageContext;
  /** Catalog to ground on: "preview:<key>" for a store-URL preview (ADR-055). */
  store?: string;
  /** The page / browser / UI language hint sent with every message (ADR-057). */
  lang?: string;
  /** Called after each reply settles (focus management). */
  onSettled?: () => void;
}

export function useConciergeChat({ endpoint, fetchImpl, context, store, lang, onSettled }: UseConciergeChatOptions = {}) {
  const [turns, setTurns] = useState<ConciergeTurn[]>([]);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const nextId = useRef(1);

  useEffect(() => () => abortRef.current?.abort(), []);

  const patchAssistant = useCallback((id: number, patch: (t: ConciergeAssistantTurn) => ConciergeAssistantTurn) => {
    setTurns((ts) => ts.map((t) => (t.id === id && t.role === "assistant" ? patch(t) : t)));
  }, []);

  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || busy) return;
      const history: ConciergeChatMessage[] = [
        ...turns.flatMap((t): ConciergeChatMessage[] => (t.text.trim() && !(t.role === "assistant" && t.stopped) ? [{ role: t.role, content: t.text.trim() }] : [])),
        { role: "user", content: text.slice(0, CONCIERGE_LIMITS.maxMessageChars) },
      ];
      const userId = nextId.current++;
      const botId = nextId.current++;
      setTurns((ts) => [...ts, { id: userId, role: "user", text }, { id: botId, role: "assistant", text: "", tools: [], pending: true }]);
      setBusy(true);
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        for await (const ev of streamConcierge(history, { endpoint, fetchImpl, signal: ctrl.signal, context, store, lang })) {
          if (ev.type === "text") patchAssistant(botId, (t) => ({ ...t, text: t.text + ev.delta }));
          else if (ev.type === "tool") patchAssistant(botId, (t) => ({ ...t, tools: [...t.tools, { name: ev.name, summary: ev.summary }] }));
          else if (ev.type === "final") patchAssistant(botId, (t) => ({ ...t, final: ev }));
          else if (ev.type === "error") patchAssistant(botId, (t) => ({ ...t, error: { kind: "generic" } }));
        }
      } catch (err) {
        if (!ctrl.signal.aborted) patchAssistant(botId, (t) => ({ ...t, error: turnError(err) }));
      } finally {
        patchAssistant(botId, (t) => ({ ...t, pending: false, ...(ctrl.signal.aborted && !t.text ? { stopped: true } : {}) }));
        setBusy(false);
        abortRef.current = null;
        onSettled?.();
      }
    },
    [busy, turns, endpoint, fetchImpl, context, store, lang, patchAssistant, onSettled],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);
  const reset = useCallback(() => {
    abortRef.current?.abort();
    setTurns([]);
  }, []);

  return { turns, busy, send, stop, reset };
}

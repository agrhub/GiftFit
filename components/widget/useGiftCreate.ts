"use client";
/**
 * "Create the gift link" (A25). The call times out (CREATE_TIMEOUT_MS, 20 s) into a localized error with the
 * Create button usable again, and every attempt for one brief carries the same Idempotency-Key, so a retry
 * after a lost response gets the gift that was already made instead of a second one. A new brief (or an edit
 * that changes the body, e.g. switching "Help me choose" / "I have ideas") gets a new key.
 */
import { useRef, useState } from "react";
import type { CreateFitRequestBody, CreateFitRequestResponse } from "@/lib/contracts/api";
import type { MessageKey } from "@/lib/i18n";
import { ApiError, type GiftApi, httpGiftApi, newIdempotencyKey } from "@/components/gift/api";

export interface UseGiftCreateOptions {
  tr: (key: MessageKey, vars?: Record<string, string | number>) => string;
  onCreated(result: CreateFitRequestResponse, body: CreateFitRequestBody): void;
  /** Tests inject a fake API or a short timeout. */
  api?: Pick<GiftApi, "createFitRequest">;
  timeoutMs?: number;
}

/** The widget's message for a failed create. */
export function createErrorKey(err: unknown): MessageKey {
  if (err instanceof ApiError && err.status === 429) return "brief.rateLimited";
  if (err instanceof ApiError && err.code === "timeout") return "brief.timeout";
  return "brief.error";
}

export function useGiftCreate({ tr, onCreated, api = httpGiftApi, timeoutMs }: UseGiftCreateOptions) {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | undefined>();
  /** One key per brief/create intent: kept while the body stays the same, so retries replay. */
  const intent = useRef<{ body: string; key: string } | null>(null);
  const inFlight = useRef(false);

  async function create(body: CreateFitRequestBody) {
    if (inFlight.current) return;
    inFlight.current = true;
    setCreating(true);
    setError(undefined);
    const sig = JSON.stringify(body);
    if (intent.current?.body !== sig) intent.current = { body: sig, key: newIdempotencyKey() };
    try {
      const result = await api.createFitRequest(body, { idempotencyKey: intent.current.key, ...(timeoutMs ? { timeoutMs } : {}) });
      onCreated(result, body);
    } catch (err) {
      setError(tr(createErrorKey(err)));
    } finally {
      inFlight.current = false;
      setCreating(false);
    }
  }

  /** A new brief or a new gift: forget the key and the error. */
  function reset() {
    intent.current = null;
    setError(undefined);
  }

  return { creating, error, create, reset };
}

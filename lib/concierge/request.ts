/** Request body validation for POST /api/concierge (owner: A7). */
import { z } from "zod";
import { CONCIERGE_LIMITS, type ConciergeChatMessage, type ConciergePageContext } from "./types";

const Message = z.object({ role: z.enum(["user", "assistant"]), content: z.string() });
const Context = z
  .object({
    product: z
      .object({
        catalogId: z.string().max(64).optional(),
        title: z.string().max(400).optional(),
        price: z.number().finite().positive().max(10_000_000).optional(),
        currency: z.string().max(8).optional(),
        sku: z.string().max(128).optional(),
      })
      .optional(),
  })
  .optional()
  // A malformed context is dropped, never a reason to refuse the chat.
  .catch(undefined);
const Body = z.object({ messages: z.array(Message).min(1).max(100), context: Context });

export type ParsedConciergeRequest = { ok: true; messages: ConciergeChatMessage[]; context?: ConciergePageContext } | { ok: false; error: "invalid_request" | "message_too_long" };

/**
 * Accepts {messages:[{role,content}]} ending with a non-empty user message. A message over 1500 chars is
 * rejected; older history beyond 12 messages / 6000 chars is dropped later by the engine (capHistory).
 */
export function parseConciergeRequest(body: unknown): ParsedConciergeRequest {
  const p = Body.safeParse(body);
  if (!p.success) return { ok: false, error: "invalid_request" };
  const messages = p.data.messages.map((m) => ({ role: m.role, content: m.content.replace(/\u0000/g, "").trim() }));
  const last = messages[messages.length - 1];
  if (last.role !== "user" || last.content.length === 0) return { ok: false, error: "invalid_request" };
  if (messages.some((m) => m.content.length > CONCIERGE_LIMITS.maxMessageChars)) return { ok: false, error: "message_too_long" };
  const context = p.data.context?.product ? { product: p.data.context.product } : undefined;
  return { ok: true, messages: messages.filter((m) => m.content.length > 0), ...(context ? { context } : {}) };
}

/**
 * Resend provider (owner: A12): one plain `fetch` to POST https://api.resend.com/emails.
 * The API key travels only in the Authorization header and is never logged or echoed.
 */
import { listUnsubscribeHeaders } from "../headers";
import { normalizeMessage } from "../address";
import { EmailSendError, type EmailMessage, type EmailSender, type SendResult } from "../types";

export const RESEND_API_URL = "https://api.resend.com/emails";

export interface ResendSenderOptions {
  apiKey: string;
  from: string;
  fromName?: string;
  replyTo?: string;
  /** Tests only. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function createResendSender(opts: ResendSenderOptions): EmailSender {
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    provider: "resend",
    async send(message: EmailMessage): Promise<SendResult> {
      const msg = normalizeMessage(message);
      const body: Record<string, unknown> = {
        from: opts.fromName ? `${opts.fromName} <${opts.from}>` : opts.from,
        to: msg.to,
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        headers: { "Auto-Submitted": "auto-generated", ...listUnsubscribeHeaders(msg.replyTo ?? opts.replyTo ?? opts.from, msg.unsubscribeUrl) },
      };
      const replyTo = msg.replyTo ?? opts.replyTo;
      if (replyTo) body.reply_to = replyTo;
      if (msg.tags.length) body.tags = msg.tags;
      let res: Response;
      try {
        res = await doFetch(RESEND_API_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
        });
      } catch (err) {
        const name = (err as { name?: string })?.name;
        const code = name === "TimeoutError" || name === "AbortError" ? "ETIMEDOUT" : "ECONNECTION";
        throw new EmailSendError(`resend request failed (${code})`, code, "resend");
      }
      if (!res.ok) {
        // Resend's error body names the problem ("validation_error", ...); keep only its `name`.
        let errName = "";
        try {
          const j = (await res.json()) as { name?: unknown };
          if (typeof j?.name === "string" && /^[a-z_]{1,60}$/.test(j.name)) errName = `: ${j.name}`;
        } catch {
          /* body not JSON */
        }
        throw new EmailSendError(`resend rejected the message (HTTP ${res.status}${errName})`, `HTTP_${res.status}`, "resend", res.status);
      }
      const j = (await res.json().catch(() => ({}))) as { id?: unknown };
      return { accepted: msg.to, rejected: [], messageId: typeof j.id === "string" ? j.id : undefined, provider: "resend" };
    },
  };
}

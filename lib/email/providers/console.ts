/**
 * Console provider (owner: A12): the mock-mode / no-config / kill-switch fallback. It sends nothing
 * and logs ONLY the recipient domain(s) and the subject: never a full address, never a body.
 */
import { randomBytes } from "node:crypto";
import { domainOf, normalizeMessage, type NormalizedMessage } from "../address";
import type { EmailMessage, EmailSender, SendResult } from "../types";

export interface ConsoleSenderOptions {
  /** Defaults to console.info. Receives one already-redacted line. */
  log?: (line: string) => void;
  /** Tests only: receives the normalised message (kept in the caller's memory, never logged). */
  outbox?: NormalizedMessage[];
  /** Appended to the log line, e.g. the selection reason ("send_disabled"). */
  note?: string;
}

export function createConsoleSender(opts: ConsoleSenderOptions = {}): EmailSender {
  const log = opts.log ?? ((line: string) => console.info(line));
  return {
    provider: "console",
    async send(message: EmailMessage): Promise<SendResult> {
      const msg = normalizeMessage(message);
      const domains = [...new Set(msg.to.map(domainOf))].join(",");
      const note = opts.note ? ` (${opts.note})` : "";
      log(`[email:console] not sent${note}; to-domain=${domains} subject=${JSON.stringify(msg.subject)}`);
      opts.outbox?.push(msg);
      return { accepted: msg.to, rejected: [], messageId: `console-${randomBytes(8).toString("hex")}`, provider: "console" };
    },
    async verify() {
      return true;
    },
  };
}

/**
 * SMTP provider via nodemailer (owner: A12).
 *
 * TLS: implicit TLS when `secure` (port 465), otherwise STARTTLS is REQUIRED (`requireTLS`), so
 * credentials never cross the wire in clear text. Certificate and hostname verification stay ON
 * (nodemailer/Node defaults: rejectUnauthorized true, servername = host); there is no switch to
 * turn them off. Minimum TLS 1.2.
 *
 * Errors are re-thrown as EmailSendError carrying only a classified, print-safe summary
 * (`classifySmtpError`): nodemailer's raw messages can echo server banners and addresses.
 */
import { listUnsubscribeHeaders } from "../headers";
import { isIP } from "node:net";
import nodemailer from "nodemailer";
import { normalizeMessage } from "../address";
import type { SmtpConfig } from "../config";
import { EmailSendError, type EmailMessage, type EmailSender, type SendResult } from "../types";

export interface SmtpSenderOptions {
  /** Bare sender address (EMAIL_FROM). */
  from: string;
  fromName?: string;
  /** Default Reply-To when a message has none (EMAIL_REPLY_TO). */
  replyTo?: string;
  /** Tests only: a pre-built nodemailer-compatible transport. */
  transport?: SmtpTransportLike;
}

/** The slice of a nodemailer transporter this module uses (lets tests inject a fake). */
export interface SmtpTransportLike {
  sendMail(mail: Record<string, unknown>): Promise<{ accepted?: unknown[]; rejected?: unknown[]; messageId?: string; response?: string }>;
  verify(): Promise<unknown>;
  close?(): void;
}

/** nodemailer transport options for a config. Exported for tests (asserts TLS checks stay on). */
export function smtpTransportOptions(cfg: SmtpConfig) {
  return {
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    requireTLS: !cfg.secure,
    auth: cfg.user && cfg.pass ? { user: cfg.user, pass: cfg.pass } : undefined,
    // SNI + hostname check against the configured name (Node verifies the cert against servername/host).
    tls: isIP(cfg.host) ? { minVersion: "TLSv1.2" as const } : { minVersion: "TLSv1.2" as const, servername: cfg.host },
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
    // Message bodies are ours, but never let a template reach local files or URLs.
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
    debug: false,
  };
}

export function createSmtpTransport(cfg: SmtpConfig): SmtpTransportLike {
  return nodemailer.createTransport(smtpTransportOptions(cfg)) as unknown as SmtpTransportLike;
}

function addrList(v: unknown[] | undefined): string[] {
  return (v ?? []).map((a) => (typeof a === "string" ? a : String((a as { address?: string })?.address ?? ""))).filter(Boolean);
}

export function createSmtpSender(cfg: SmtpConfig, opts: SmtpSenderOptions): EmailSender {
  let transport = opts.transport;
  const get = () => (transport ??= createSmtpTransport(cfg));
  return {
    provider: "smtp",
    async send(message: EmailMessage): Promise<SendResult> {
      const msg = normalizeMessage(message);
      const headers: Record<string, string> = {
        "Auto-Submitted": "auto-generated",
        "X-Auto-Response-Suppress": "OOF, AutoReply",
        ...listUnsubscribeHeaders(msg.replyTo ?? opts.replyTo ?? opts.from, msg.unsubscribeUrl),
      };
      if (msg.tags.length) headers["X-GiftFit-Tags"] = msg.tags.map((t) => `${t.name}=${t.value}`).join("; ");
      try {
        const info = await get().sendMail({
          from: opts.fromName ? { name: opts.fromName, address: opts.from } : opts.from,
          to: msg.to,
          replyTo: msg.replyTo ?? opts.replyTo,
          subject: msg.subject,
          text: msg.text,
          html: msg.html,
          headers,
        });
        return {
          accepted: addrList(info.accepted),
          rejected: addrList(info.rejected),
          messageId: info.messageId,
          provider: "smtp",
          response: typeof info.response === "string" ? redactResponse(info.response) : undefined,
        };
      } catch (err) {
        const c = classifySmtpError(err);
        throw new EmailSendError(`smtp send failed: ${c.errorClass} (${c.code})`, c.code, "smtp", c.responseCode);
      }
    },
    async verify(): Promise<boolean> {
      try {
        await get().verify();
        return true;
      } catch (err) {
        const c = classifySmtpError(err);
        throw new EmailSendError(`smtp verify failed: ${c.errorClass} (${c.code})`, c.code, "smtp", c.responseCode);
      }
    },
  };
}

export type SmtpErrorClass = "auth" | "tls_certificate" | "tls" | "timeout" | "dns" | "connection" | "envelope" | "message" | "protocol" | "other";

export interface SmtpErrorSummary {
  errorClass: SmtpErrorClass;
  /** nodemailer code (EAUTH, ECONNECTION, ESOCKET, ETLS, ...) or "UNKNOWN". */
  code: string;
  /** The underlying Node/OpenSSL code when nodemailer wrapped one (e.g. CERT_HAS_EXPIRED). */
  originalCode?: string;
  /** SMTP reply code (e.g. 535) when the server answered. */
  responseCode?: number;
  /** SMTP command that failed (e.g. "AUTH PLAIN", "CONN"). */
  command?: string;
}

const CERT_CODES = /CERT|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)|ALTNAME|HOSTNAME|SIGNATURE|DEPTH_ZERO|ERR_TLS_CERT/i;

/** Print-safe classification: codes only, never the raw message (it can echo addresses or banners). */
export function classifySmtpError(err: unknown): SmtpErrorSummary {
  const e = (err ?? {}) as { code?: unknown; originalCode?: unknown; responseCode?: unknown; command?: unknown; message?: unknown; cause?: { code?: unknown } };
  const code = typeof e.code === "string" && /^[A-Z0-9_]{2,40}$/.test(e.code) ? e.code : "UNKNOWN";
  const orig = [e.originalCode, e.cause?.code].find((v) => typeof v === "string" && /^[A-Z0-9_]{2,60}$/.test(v)) as string | undefined;
  const responseCode = typeof e.responseCode === "number" ? e.responseCode : undefined;
  const command = typeof e.command === "string" && /^[A-Z ]{2,20}$/.test(e.command) ? e.command : undefined;
  const msg = typeof e.message === "string" ? e.message : "";
  let errorClass: SmtpErrorClass = "other";
  if (code === "EAUTH" || code === "ENOAUTH" || (responseCode !== undefined && [530, 534, 535, 538].includes(responseCode))) errorClass = "auth";
  else if (CERT_CODES.test(orig ?? "") || CERT_CODES.test(code) || /certificate|self[- ]signed|altname/i.test(msg)) errorClass = "tls_certificate";
  else if (code === "ETLS") errorClass = "tls";
  else if (code === "ETIMEDOUT" || orig === "ETIMEDOUT") errorClass = "timeout";
  else if (code === "EDNS" || orig === "ENOTFOUND" || orig === "EAI_AGAIN") errorClass = "dns";
  else if (code === "ECONNECTION" || code === "ESOCKET" || orig === "ECONNREFUSED" || orig === "ECONNRESET") errorClass = "connection";
  else if (code === "EENVELOPE") errorClass = "envelope";
  else if (code === "EMESSAGE") errorClass = "message";
  else if (code === "EPROTOCOL") errorClass = "protocol";
  return { errorClass, code, originalCode: orig, responseCode, command };
}

/** Keeps the SMTP status line but blanks anything that looks like an address. */
export function redactResponse(line: string): string {
  return line
    .replace(/[^\s<>()[\]"',;:]+@[^\s<>()[\]"',;:]+/g, "<redacted>")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 200);
}

/**
 * Transactional email for GiftFit (owner: A12).
 *
 * One `EmailSender` interface, three providers (smtp | resend | console), chosen by
 * `selectEmailProvider()` in config.ts. Nothing in server/email ever logs a full address, a body or
 * a credential: the console provider logs only the recipient DOMAIN and the subject.
 */

export type EmailProviderName = "smtp" | "resend" | "console";

export interface EmailTag {
  name: string;
  value: string;
}

export interface EmailMessage {
  /** One address or a list. Each must be a bare address (no display name, no CR/LF). */
  to: string | string[];
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  tags?: EmailTag[];
  /** https one-click unsubscribe endpoint (RFC 8058); without it List-Unsubscribe is mailto only. */
  unsubscribeUrl?: string;
}

export interface SendResult {
  accepted: string[];
  rejected: string[];
  messageId?: string;
  provider: EmailProviderName;
  /** SMTP only: the server's final response line (e.g. "250 2.0.0 Ok: queued"). Never contains credentials. */
  response?: string;
}

export interface EmailSender {
  readonly provider: EmailProviderName;
  send(message: EmailMessage): Promise<SendResult>;
  /** Login-only connectivity check (SMTP). Providers without one resolve true. Never sends mail. */
  verify?(): Promise<boolean>;
}

/** Thrown for a message the sender refuses before any network I/O (bad address, header injection). */
export class EmailValidationError extends Error {
  readonly code = "EMAIL_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "EmailValidationError";
  }
}

/** A provider-level failure. `code` is the provider/transport code (EAUTH, ECONNECTION, HTTP_401, ...). */
export class EmailSendError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly provider: EmailProviderName,
    readonly status?: number,
  ) {
    super(message);
    this.name = "EmailSendError";
  }
}

/**
 * lib/email public surface (owner: A12).
 *
 *   const sender = getEmailSender();                  // provider chosen from env (config.ts)
 *   await assertEmailRate({ giverKey, ipKey });       // throws EmailRateLimitError (429)
 *   const mail = giftCardEmail({ occasion, lang, giverName, message, recipientToken, baseUrl: appBaseUrl(req) });
 *   await sender.send({ to, ...mail, tags: [{ name: "type", value: "gift_card" }] });
 *
 * Real providers send only with EMAIL_SEND_ENABLED=1, and never in mock mode (YOUCAM_MOCK=1) or
 * under NODE_ENV=test; otherwise everything goes to the console provider.
 */
import { readEmailConfig, selectEmailProvider, type Env, type ProviderSelection } from "./config";
import { createConsoleSender, type ConsoleSenderOptions } from "./providers/console";
import { createResendSender } from "./providers/resend";
import { createSmtpSender } from "./providers/smtp";
import type { EmailSender } from "./types";

export * from "./types";
export { appBaseUrl, recipientUrl, giverReportUrl, DEFAULT_BASE_URL } from "./links";
export { describeEmailConfig, readEmailConfig, readSmtpConfig, selectEmailProvider } from "./config";
export type { EmailConfig, ProviderSelection, SelectionReason, SmtpConfig } from "./config";
export { giftCardEmail, fitReportReadyEmail, OCCASION_THEMES, CARD_LANGS } from "./templates";
export type { CardLang, GiftCardEmailInput, FitReportReadyEmailInput, RenderedEmail } from "./templates";
export {
  assertEmailRate,
  getEmailRateLimiter,
  setEmailRateLimiter,
  EmailRateLimitError,
  MemoryEmailRateLimiter,
  EMAIL_RATE_LIMITS,
} from "./rate-limit";
export type { EmailRateLimiter, EmailRateKeys, EmailRateDecision, EmailRateScope } from "./rate-limit";
export { escapeHtml } from "./escape";
export { domainOf, isValidAddress } from "./address";

export interface CreatedSender {
  sender: EmailSender;
  selection: ProviderSelection;
}

/** Builds a sender for `env` (uncached). `console` options apply to the console fallback. */
export function createEmailSender(env: Env = process.env, consoleOpts: ConsoleSenderOptions = {}): CreatedSender {
  const cfg = readEmailConfig(env);
  const selection = selectEmailProvider(env, cfg);
  if (selection.provider === "smtp" && cfg.smtp && cfg.from) {
    return { sender: createSmtpSender(cfg.smtp, { from: cfg.from, fromName: cfg.fromName, replyTo: cfg.replyTo }), selection };
  }
  if (selection.provider === "resend" && cfg.resendApiKey && cfg.from) {
    return { sender: createResendSender({ apiKey: cfg.resendApiKey, from: cfg.from, fromName: cfg.fromName, replyTo: cfg.replyTo }), selection };
  }
  const note = selection.reason === "explicit_console" ? undefined : selection.reason;
  return { sender: createConsoleSender({ note, ...consoleOpts }), selection: { ...selection, provider: "console" } };
}

const KEY = Symbol.for("giftfit.email.sender.v1");
type G = typeof globalThis & { [KEY]?: CreatedSender };

/** Process-wide sender from process.env (reuses the SMTP connection settings across routes). */
export function getEmailSender(): EmailSender {
  const g = globalThis as G;
  return (g[KEY] ??= createEmailSender()).sender;
}

/** Which provider getEmailSender() uses and why (print-safe). */
export function getEmailSelection(): ProviderSelection {
  const g = globalThis as G;
  return (g[KEY] ??= createEmailSender()).selection;
}

/** Tests / R0 wiring: replace the process-wide sender, or undefined to rebuild from env. */
export function setEmailSender(sender: EmailSender | undefined): void {
  const g = globalThis as G;
  if (sender) g[KEY] = { sender, selection: { provider: sender.provider, requested: sender.provider, reason: "ok" } };
  else delete g[KEY];
}

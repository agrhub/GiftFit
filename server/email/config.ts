/**
 * Email configuration and provider selection (owner: A12). Reads process.env (or an injected env)
 * and NEVER logs or returns secret values in anything meant for output: `describeEmailConfig()` is
 * the only shape safe to print, and it reports presence flags, not values.
 *
 * Selection order (first match wins):
 *   1. NODE_ENV=test or YOUCAM_MOCK=1           -> console  (mock mode: never a real send)
 *   2. EMAIL_PROVIDER=console                   -> console
 *   3. requested = EMAIL_PROVIDER, else "smtp" when SMTP_HOST is set, else console
 *   4. requested provider's config incomplete   -> console  (reason "<provider>_config_missing")
 *   5. EMAIL_SEND_ENABLED !== "1"               -> console  (the send kill-switch)
 *   6. otherwise                                -> the requested real provider
 */
import { bareAddress, sanitizeDisplayName } from "./address";
import type { EmailProviderName } from "./types";

export type Env = Record<string, string | undefined>;

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
}

export interface EmailConfig {
  requested: EmailProviderName | "unknown" | undefined;
  smtp?: SmtpConfig;
  resendApiKey?: string;
  /** Bare sender address (EMAIL_FROM). */
  from?: string;
  fromName?: string;
  replyTo?: string;
  sendEnabled: boolean;
  mockMode: boolean;
}

function trimmed(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

export function parseBool(v: string | undefined): boolean | undefined {
  const t = v?.trim().toLowerCase();
  if (!t) return undefined;
  if (["1", "true", "yes", "on"].includes(t)) return true;
  if (["0", "false", "no", "off"].includes(t)) return false;
  return undefined;
}

export function readSmtpConfig(env: Env = process.env): SmtpConfig | undefined {
  const host = trimmed(env.SMTP_HOST);
  if (!host) return undefined;
  const portRaw = Number.parseInt(env.SMTP_PORT ?? "", 10);
  const secureFlag = parseBool(env.SMTP_SECURE);
  const port = Number.isInteger(portRaw) && portRaw > 0 && portRaw < 65536 ? portRaw : secureFlag === false ? 587 : 465;
  // Implicit TLS on 465 unless explicitly disabled; any other port uses STARTTLS (required, see smtp.ts).
  const secure = secureFlag ?? port === 465;
  return { host, port, secure, user: trimmed(env.SMTP_USER), pass: env.SMTP_PASS || undefined };
}

export function readEmailConfig(env: Env = process.env): EmailConfig {
  const p = trimmed(env.EMAIL_PROVIDER)?.toLowerCase();
  const requested: EmailConfig["requested"] =
    p === undefined ? undefined : p === "smtp" || p === "resend" || p === "console" ? p : "unknown";
  return {
    requested,
    smtp: readSmtpConfig(env),
    resendApiKey: trimmed(env.RESEND_API_KEY),
    from: bareAddress(env.EMAIL_FROM),
    fromName: sanitizeDisplayName(env.EMAIL_FROM_NAME) ?? "GiftFit",
    replyTo: bareAddress(env.EMAIL_REPLY_TO),
    sendEnabled: env.EMAIL_SEND_ENABLED?.trim() === "1",
    mockMode: env.NODE_ENV === "test" || env.YOUCAM_MOCK?.trim() === "1",
  };
}

export type SelectionReason =
  | "mock_mode"
  | "explicit_console"
  | "not_configured"
  | "unknown_provider"
  | "smtp_config_missing"
  | "resend_config_missing"
  | "send_disabled"
  | "ok";

export interface ProviderSelection {
  provider: EmailProviderName;
  /** What the configuration asked for before the fallbacks. */
  requested: EmailProviderName | "unknown";
  reason: SelectionReason;
}

export function selectEmailProvider(env: Env = process.env, cfg: EmailConfig = readEmailConfig(env)): ProviderSelection {
  const requested: ProviderSelection["requested"] = cfg.requested ?? (cfg.smtp ? "smtp" : "console");
  const toConsole = (reason: SelectionReason): ProviderSelection => ({ provider: "console", requested, reason });
  if (cfg.mockMode) return toConsole("mock_mode");
  if (requested === "console") return toConsole(cfg.requested ? "explicit_console" : "not_configured");
  if (requested === "unknown") return toConsole("unknown_provider");
  if (requested === "smtp" && (!cfg.smtp || !cfg.from)) return toConsole("smtp_config_missing");
  if (requested === "resend" && (!cfg.resendApiKey || !cfg.from)) return toConsole("resend_config_missing");
  if (!cfg.sendEnabled) return toConsole("send_disabled");
  return { provider: requested, requested, reason: "ok" };
}

/** Print-safe summary: provider choice and presence flags only, never values. */
export function describeEmailConfig(env: Env = process.env): Record<string, string | boolean | number> {
  const cfg = readEmailConfig(env);
  const sel = selectEmailProvider(env, cfg);
  return {
    provider: sel.provider,
    requested: sel.requested,
    reason: sel.reason,
    smtpHostSet: Boolean(cfg.smtp),
    smtpPort: cfg.smtp?.port ?? 0,
    smtpSecure: cfg.smtp?.secure ?? false,
    smtpAuthSet: Boolean(cfg.smtp?.user && cfg.smtp?.pass),
    resendKeySet: Boolean(cfg.resendApiKey),
    fromSet: Boolean(cfg.from),
    replyToSet: Boolean(cfg.replyTo),
    sendEnabled: cfg.sendEnabled,
    mockMode: cfg.mockMode,
  };
}

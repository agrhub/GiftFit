/**
 * Address and header hygiene shared by every provider (owner: A12). Pure functions, no I/O.
 */
import { EmailValidationError, type EmailMessage } from "./types";

/** Deliberately strict: printable, no spaces, no quotes, no angle brackets, no CR/LF. */
const ADDRESS_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export const MAX_RECIPIENTS = 10;
export const MAX_SUBJECT_LENGTH = 200;

export function isValidAddress(addr: unknown): addr is string {
  return typeof addr === "string" && addr.length <= 254 && ADDRESS_RE.test(addr);
}

/** "someone@Example.COM" -> "example.com"; anything unparsable -> "invalid". Safe to log. */
export function domainOf(addr: string): string {
  const at = addr.lastIndexOf("@");
  if (at < 0) return "invalid";
  const d = addr.slice(at + 1).trim().toLowerCase();
  return /^[a-z0-9.-]{1,253}$/.test(d) ? d : "invalid";
}

/** Accepts a bare address or "Name <addr>" and returns the bare address (or undefined). */
export function bareAddress(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const v = value.trim();
  const m = /<([^<>]+)>\s*$/.exec(v);
  const addr = (m ? m[1] : v).trim();
  return isValidAddress(addr) ? addr : undefined;
}

/** Strips CR/LF and other control characters and collapses whitespace (header-injection guard). */
export function sanitizeHeaderText(value: string, max = MAX_SUBJECT_LENGTH): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Display name safe for `"Name" <addr>`: no quotes, backslashes, angle brackets or control chars. */
export function sanitizeDisplayName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const n = sanitizeHeaderText(name, 80).replace(/["\\<>]/g, "").trim();
  return n || undefined;
}

export interface NormalizedMessage {
  to: string[];
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  tags: { name: string; value: string }[];
  unsubscribeUrl?: string;
}

/** Validates and normalises a message; throws EmailValidationError before any network I/O. */
export function normalizeMessage(msg: EmailMessage): NormalizedMessage {
  const list = (Array.isArray(msg.to) ? msg.to : [msg.to]).map((a) => (typeof a === "string" ? a.trim() : a));
  if (list.length === 0) throw new EmailValidationError("no recipients");
  if (list.length > MAX_RECIPIENTS) throw new EmailValidationError("too many recipients");
  for (const a of list) if (!isValidAddress(a)) throw new EmailValidationError("invalid recipient address");
  const to = [...new Set(list as string[])];
  const subject = sanitizeHeaderText(msg.subject ?? "");
  if (!subject) throw new EmailValidationError("empty subject");
  if (typeof msg.html !== "string" || typeof msg.text !== "string" || !msg.text.trim()) {
    throw new EmailValidationError("html and text bodies are required");
  }
  let replyTo: string | undefined;
  if (msg.replyTo !== undefined && msg.replyTo !== "") {
    if (!isValidAddress(msg.replyTo.trim())) throw new EmailValidationError("invalid reply-to address");
    replyTo = msg.replyTo.trim();
  }
  const tags = (msg.tags ?? [])
    .slice(0, 10)
    .map((t) => ({ name: tagToken(t.name), value: tagToken(t.value) }))
    .filter((t) => t.name && t.value);
  let unsubscribeUrl: string | undefined;
  if (msg.unsubscribeUrl) {
    let u: URL;
    try {
      u = new URL(msg.unsubscribeUrl);
    } catch {
      throw new EmailValidationError("invalid unsubscribe url");
    }
    if (u.protocol !== "https:") throw new EmailValidationError("unsubscribe url must be https");
    unsubscribeUrl = u.toString();
  }
  return { to, subject, html: msg.html, text: msg.text, replyTo, tags, unsubscribeUrl };
}

/** Resend tag rule (ASCII letters, digits, "_" and "-", <= 256 chars); also safe in an SMTP header. */
function tagToken(v: string): string {
  return String(v ?? "")
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .slice(0, 256);
}

/**
 * SMTP login check (owner: A12). Connects, does TLS + AUTH, and disconnects. NEVER sends mail.
 *
 *   npx tsx scripts/email-verify.ts                 # .env* via Next's loader (what the app sees)
 *   npx tsx scripts/email-verify.ts --env <file>    # one file, literal (Node's loader)
 *
 * Output is print-safe: OK, or the error class and codes (EAUTH, ECONNECTION, ESOCKET, ETLS,
 * certificate error, ...). It never prints the host, user, password or any address.
 * Run it sparingly: repeated failed logins can trip the mail server's brute-force lockout.
 */
import { readSmtpConfig } from "../server/email/config";
import { classifySmtpError, createSmtpTransport } from "../server/email/providers/smtp";
import { loadScriptEnv } from "./email-env";

async function main(): Promise<void> {
  const loader = loadScriptEnv(process.argv.slice(2), "email-verify");
  const cfg = readSmtpConfig(process.env);
  if (!cfg) {
    console.error("email-verify: SMTP_HOST is not set; nothing to verify");
    process.exit(2);
  }
  console.log(`email-verify: env loader=${loader}; auth configured=${Boolean(cfg.user && cfg.pass)}; connecting (verify only, no send)...`);
  const transport = createSmtpTransport(cfg);
  const started = Date.now();
  try {
    await transport.verify();
    console.log(`email-verify: OK (TLS + login accepted in ${Date.now() - started} ms)`);
  } catch (err) {
    const c = classifySmtpError(err);
    const parts = [`class=${c.errorClass}`, `code=${c.code}`];
    if (c.originalCode) parts.push(`originalCode=${c.originalCode}`);
    if (c.responseCode !== undefined) parts.push(`responseCode=${c.responseCode}`);
    if (c.command) parts.push(`command=${c.command}`);
    console.error(`email-verify: FAILED ${parts.join(" ")}`);
    process.exitCode = 1;
  } finally {
    transport.close?.();
  }
}

void main();

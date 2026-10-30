/**
 * ONE real test email (owner: A12). Sends a sample gift card to the sender address (EMAIL_FROM)
 * itself and to no one else. Requires --confirm; without it the script exits before any network I/O.
 *
 *   npx tsx scripts/email-test-send.ts --confirm            # .env* via Next's loader (what the app sees)
 *   npx tsx scripts/email-test-send.ts --confirm --lang vi  # Vietnamese card
 *   npx tsx scripts/email-test-send.ts --confirm --env <file>   # one file, literal (Node's loader)
 *
 * This is an operator tool: it talks to SMTP directly and deliberately ignores the app's
 * EMAIL_SEND_ENABLED kill-switch and mock mode (the --confirm flag is the gate). Links point at
 * APP_BASE_URL, else http://localhost:3000, with a dummy token (the link will not open a real gift).
 *
 * Prints only: accepted/rejected counts, the SMTP response line (addresses redacted) and the
 * messageId. Never the host, user, password or any address.
 */
import { readEmailConfig } from "../server/email/config";
import { appBaseUrl } from "../server/email/links";
import { classifySmtpError, createSmtpSender } from "../server/email/providers/smtp";
import { giftCardEmail } from "../server/email/templates";
import { EmailSendError } from "../server/email/types";
import { loadScriptEnv } from "./email-env";

const TEST_SUBJECT = "[GiftFit test] Gift card delivery check";
const args = process.argv.slice(2);

function arg(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  if (!args.includes("--confirm")) {
    console.error("email-test-send: refusing to send without --confirm.");
    console.error("  This sends exactly ONE email, to the sender address (EMAIL_FROM) only.");
    console.error("  Usage: npx tsx scripts/email-test-send.ts --confirm [--lang en|vi] [--env <file>]");
    process.exit(2);
  }
  loadScriptEnv(args, "email-test-send");

  const cfg = readEmailConfig(process.env);
  if (!cfg.smtp || !cfg.from) {
    console.error(`email-test-send: SMTP not configured (SMTP_HOST set=${Boolean(cfg.smtp)}, EMAIL_FROM valid=${Boolean(cfg.from)})`);
    process.exit(2);
  }

  const lang = arg("--lang") === "vi" ? "vi" : "en";
  const card = giftCardEmail({
    occasion: "birthday",
    lang,
    giverName: "GiftFit test",
    recipientName: "GiftFit team",
    message: "This is a delivery check for the GiftFit gift card email.\nIf you can read this, SMTP delivery works.",
    recipientToken: "delivery-check-not-a-real-token",
    baseUrl: appBaseUrl(undefined, process.env),
  });

  const to = [cfg.from];
  // Belt and braces: this script may only ever address the sender itself.
  if (to.length !== 1 || to[0] !== cfg.from) throw new Error("recipient guard failed");

  const sender = createSmtpSender(cfg.smtp, { from: cfg.from, fromName: cfg.fromName, replyTo: cfg.replyTo });
  try {
    const r = await sender.send({ to, subject: TEST_SUBJECT, html: card.html, text: card.text, tags: [{ name: "type", value: "delivery_check" }] });
    console.log(`email-test-send: accepted=${r.accepted.length} rejected=${r.rejected.length}`);
    console.log(`email-test-send: response=${r.response ?? "(none)"}`);
    console.log(`email-test-send: messageId=${r.messageId ?? "(none)"}`);
    if (r.rejected.length || !r.accepted.length) process.exitCode = 1;
  } catch (err) {
    if (err instanceof EmailSendError) {
      // EmailSendError messages are built from codes only ("smtp send failed: auth (EAUTH)").
      console.error(`email-test-send: FAILED ${err.message}${err.status !== undefined ? ` responseCode=${err.status}` : ""}`);
    } else {
      const c = classifySmtpError(err);
      console.error(`email-test-send: FAILED class=${c.errorClass} code=${c.code}`);
    }
    process.exitCode = 1;
  }
}

void main();

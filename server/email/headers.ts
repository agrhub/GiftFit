/**
 * Headers every GiftFit email carries (owner: R0, ADR-047). List-Unsubscribe lets mail clients show an
 * "Unsubscribe" control and is expected by Gmail/Outlook for automated mail:
 *   - mailto: always (the reply-to or sender mailbox, subject "unsubscribe");
 *   - https one-click (RFC 8058) only when the message carries an unsubscribeUrl, with List-Unsubscribe-Post.
 */
import { isValidAddress } from "./address";

export function listUnsubscribeHeaders(mailbox: string, unsubscribeUrl?: string): Record<string, string> {
  if (!isValidAddress(mailbox)) throw new Error("List-Unsubscribe needs a valid mailbox");
  const parts = [`<mailto:${mailbox}?subject=unsubscribe>`];
  const headers: Record<string, string> = {};
  if (unsubscribeUrl) {
    const u = new URL(unsubscribeUrl);
    if (u.protocol !== "https:") throw new Error("unsubscribeUrl must be https");
    parts.unshift(`<${u.toString()}>`);
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }
  headers["List-Unsubscribe"] = parts.join(", ");
  return headers;
}

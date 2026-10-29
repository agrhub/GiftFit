/**
 * The giver's conversation language for a recipient link (owner: A21), so the recipient page can render
 * in it on the server. A read only: no status change and no purge (the session route does those).
 * Returns undefined for a malformed, unknown or closed link, or when the store can't be reached.
 */
import type { PrivacyDeps } from "./deps";
import { CLOSED_STATUSES } from "./repos/types";
import { hashToken, looksLikeToken } from "./tokens";

export async function giverLangForRecipientToken(token: string, deps: Pick<PrivacyDeps, "repos">): Promise<string | undefined> {
  if (!looksLikeToken(token)) return undefined;
  try {
    const request = await deps.repos.fitRequests.findByRecipientTokenHash(hashToken(token));
    if (!request || CLOSED_STATUSES.includes(request.status)) return undefined;
    return request.giverLang ?? undefined;
  } catch {
    return undefined;
  }
}

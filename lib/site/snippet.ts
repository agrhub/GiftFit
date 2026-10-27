/** The one-line embed snippet for this deployment (owner: A6). Server-only (reads request headers). */
import { headers } from "next/headers";
import { appBaseUrl } from "@/lib/email/links";
import { exactOrigin } from "@/lib/widget/protocol";

/** APP_BASE_URL when set, else this request's origin (Host + X-Forwarded-Proto). */
export async function siteOrigin(): Promise<string> {
  if (process.env.APP_BASE_URL?.trim()) return appBaseUrl(null);
  const h = await headers();
  const host = h.get("host");
  const proto = h.get("x-forwarded-proto")?.split(",")[0]?.trim() || "http";
  return (host && exactOrigin(`${proto}://${host}`)) || appBaseUrl(null);
}

export function embedSnippet(origin: string): string {
  return `<script src="${origin}/giftfit.js" data-store="aurum" async></script>`;
}

/**
 * GET /api/recipient/tryons  (audience: recipient)
 * The session's rendered try-ons with fresh signed image URLs (<= 15 min, bound to this
 * recipient's token), keyed by the opaque carousel `itemId` and, for metal renders, `swatchId`
 * (catalog and variant ids never leave the server). Analysis tasks and renders whose image is gone
 * are not listed.
 */
import { itemIdFor, resolveCarousel } from "@/lib/privacy/carousel";
import { expiryFromKey } from "@/lib/privacy/photo-store";
import { parseRenderRef, tagOf } from "@/lib/privacy/renders";
import { getPrivacyDeps } from "@/lib/privacy/runtime";
import { isRenderFeature } from "@/lib/privacy/repos/types";
import { recipientError, recipientJson, resolveRecipientSession } from "@/lib/privacy/session";
import { signTryOnUrl } from "@/lib/privacy/signed-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const deps = await getPrivacyDeps();
  const session = await resolveRecipientSession(req, deps);
  if (!session.ok) return recipientError(session.status, session.error);
  const nowMs = deps.now().getTime();
  const carousel = await resolveCarousel(deps, session.request);
  const byCatalog = new Map(carousel.map((c) => [c.sku.id, c]));
  const allRenders = (await deps.repos.tryons.listForRequest(session.request.id)).filter((t) => isRenderFeature(t.feature) && t.catalogId && t.resultRef);
  const ids = (t: (typeof allRenders)[number]) => {
    const item = byCatalog.get(t.catalogId!);
    const tag = parseRenderRef(t.resultRef)?.variantTag;
    const swatch = item && tag ? item.swatches.find((s) => tagOf(s.variant.variantId) === tag) : undefined;
    return { itemId: item?.itemId ?? itemIdFor(deps.signingSecret, session.request.id, t.catalogId!), ...(swatch ? { swatchId: swatch.swatchId } : {}) };
  };

  // After "Delete my photo now": every render is reported deleted, with no image URL (A4 keys on this shape).
  if (session.request.photoDeletedAt) {
    const seen = new Set<string>();
    const tryOns = allRenders
      .map((t) => ({ ...ids(t), status: "failed" as const, failureReason: "photo_deleted" }))
      .filter((e) => {
        const k = e.itemId + "|" + (e.swatchId ?? "");
        return seen.has(k) ? false : (seen.add(k), true);
      });
    return recipientJson({ tryOns, label: "AI try-on preview" });
  }

  // Otherwise only renders whose image still exists (none after Done or past the 1 h TTL).
  const live = new Set(await deps.photos.listForRequest(session.request.id));
  const rows = allRenders.filter((t) => {
    if (t.resultRef!.startsWith("fixture:")) return session.request.status !== "completed" && t.expiresAt.getTime() > nowMs; // seeded judge demo
    const key = t.resultRef!.startsWith("store:") ? t.resultRef!.slice("store:".length) : "";
    return live.has(key) && (expiryFromKey(key) ?? 0) > nowMs;
  });
  const tryOns = rows.map((t) => {
    const signed = signTryOnUrl({ tryOnId: t.id, sessionToken: session.token, secret: deps.signingSecret, nowMs });
    return { ...ids(t), status: "ready" as const, imageUrl: signed.url, imageUrlExpiresAt: signed.exp };
  });
  return recipientJson({ tryOns, label: "AI try-on preview" });
}

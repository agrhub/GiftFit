/**
 * GET /api/recipient/purge-expired  (audience: internal, cron)
 * Deletes recipient data of every Fit Request past its 72 h expiry and every blob past its
 * <= 1 h TTL. Requires `Authorization: Bearer $CRON_SECRET` (Vercel Cron sends it). Expired
 * requests are also purged lazily on first touch, so this is the backstop, not the only path.
 */
import { purgeExpired } from "@/lib/privacy/delete-everything";
import { getPrivacyDeps } from "@/lib/privacy/runtime";
import { safeEqual } from "@/lib/privacy/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return Response.json({ error: "cron not configured" }, { status: 503 });
  const auth = req.headers.get("authorization") ?? "";
  if (!safeEqual(auth, `Bearer ${secret}`)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const summary = await purgeExpired(await getPrivacyDeps());
  return Response.json(
    {
      requests: summary.requests,
      sweptBlobs: summary.sweptBlobs,
      verified: summary.receipts.every((r) => r.verified),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

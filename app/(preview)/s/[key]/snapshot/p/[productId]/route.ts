/**
 * GET /s/<key>/snapshot/p/<productId> : the sanitized copy of a product page the preview shows, or GiftFit's
 * plain product card when that page wasn't captured (owner: A15). Same headers as the snapshot home.
 */
import { serveSnapshotProduct } from "@/server/preview/page-snapshot-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ key: string; productId: string }> }): Promise<Response> {
  const { key, productId } = await params;
  return serveSnapshotProduct(key, productId);
}

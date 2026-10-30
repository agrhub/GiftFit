/**
 * GET /s/<key>/snapshot : the sanitized copy of the merchant's home page for a preview in snapshot mode
 * (owner: A15). Only the inert HTML with a CSP that has no script-src; framed by /s/<key> in a sandboxed
 * iframe. See server/preview/page-snapshot-http.ts.
 */
import { serveSnapshotHome } from "@/server/preview/page-snapshot-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ key: string }> }): Promise<Response> {
  const { key } = await params;
  // The GiftFit strip reads in the viewer's language.
  return serveSnapshotHome(key, { acceptLanguage: req.headers.get("accept-language") });
}

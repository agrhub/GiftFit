/**
 * POST /api/preview/seed  { kind: "jewelry" | "generic", state? } (owner: A6; e2e only, ADR-055).
 * Stores a FIXTURE store-URL preview (fictional .example stores, app catalog images; nothing crawled)
 * and returns { key, previewPath, ownerPath }. Exists only when PREVIEW_FIXTURE_SEED=1 AND the caller
 * sends `Authorization: Bearer $CRON_SECRET`; otherwise 404 (production never sets the flag).
 * DELETE /api/preview/seed { key } (same gate) deletes a preview, to test gift links that outlive it.
 */
import { defaultPreviewRepo, PREVIEW_KEY_RE } from "@/lib/preview/repo";
import { safeEqual } from "@/lib/privacy/tokens";
import { fixturePreview, type FixtureKind } from "@/lib/widget/preview-fixtures";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NOT_FOUND = () => Response.json({ error: "not_found" }, { status: 404, headers: { "Cache-Control": "no-store" } });

function allowed(req: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (process.env.PREVIEW_FIXTURE_SEED !== "1" || !secret) return false;
  return safeEqual(req.headers.get("authorization") ?? "", `Bearer ${secret}`);
}

export async function DELETE(req: Request): Promise<Response> {
  if (!allowed(req)) return NOT_FOUND();
  const { key } = (await req.json().catch(() => ({}))) as { key?: unknown };
  if (typeof key !== "string" || !PREVIEW_KEY_RE.test(key)) return NOT_FOUND();
  await defaultPreviewRepo().delete(key);
  return new Response(null, { status: 204 });
}

export async function POST(req: Request): Promise<Response> {
  if (!allowed(req)) return NOT_FOUND();
  const body = (await req.json().catch(() => ({}))) as { kind?: unknown; state?: unknown };
  const kind: FixtureKind = body.kind === "generic" ? "generic" : "jewelry";
  const state = body.state === "refused" || body.state === "failed" || body.state === "crawling" ? body.state : "ready";
  // Images by absolute URL on this app's public catalog, as the browser sees the host (Host header).
  const host = req.headers.get("host");
  const imageBase = host ? `${new URL(req.url).protocol}//${host}` : new URL(req.url).origin;
  const f = fixturePreview(kind, { imageBase, state });
  await defaultPreviewRepo().create(f.record);
  return Response.json(
    { key: f.record.key, previewPath: `/s/${f.record.key}`, ownerPath: `/admin/${f.record.key}#t=${f.ownerToken}` },
    { status: 201, headers: { "Cache-Control": "no-store" } },
  );
}

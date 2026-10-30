/**
 * POST /api/preview/seed  { kind: "jewelry" | "generic", state? } (owner: A6; e2e only, ADR-055).
 * Stores a FIXTURE store-URL preview (fictional .example stores, app catalog images; nothing crawled)
 * and returns { key, previewPath, ownerPath }. Exists only when PREVIEW_FIXTURE_SEED=1 AND the caller
 * sends `Authorization: Bearer $CRON_SECRET`; otherwise 404 (production never sets the flag).
 * DELETE /api/preview/seed { key } (same gate) deletes a preview, to test gift links that outlive it.
 *
 * A15: `snapshotFixturePort` (jewelry + ready only) also takes the store-page snapshot of the fixture
 * store, served by the TEST's own HTTP server on 127.0.0.1:<port>. Only the transport is swapped (the
 * fixture host https://lumen-jewelry.example is "resolved" to a public test address and
 * the pinned socket goes to the local port over plain HTTP); every other SafeFetcher rule (URL policy,
 * robots.txt, User-Agent, size/time caps, redirects) and the sanitizer run unchanged.
 */
import { pinnedRequest } from "@/server/ingest/safe-fetch";
import { capturePageSnapshot } from "@/server/preview/page-snapshot";
import { defaultPageSnapshotStore } from "@/server/preview/page-snapshot-store";
import { defaultPreviewRepo, PREVIEW_KEY_RE } from "@/server/preview/repo";
import { safeEqual } from "@/server/privacy/tokens";
import { fixturePreview, type FixtureKind } from "@/server/widget/preview-fixtures";

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
  await defaultPageSnapshotStore().deleteFor(key);
  return new Response(null, { status: 204 });
}

export async function POST(req: Request): Promise<Response> {
  if (!allowed(req)) return NOT_FOUND();
  const body = (await req.json().catch(() => ({}))) as { kind?: unknown; state?: unknown; snapshotFixturePort?: unknown };
  const kind: FixtureKind = body.kind === "generic" ? "generic" : "jewelry";
  const state = body.state === "refused" || body.state === "failed" || body.state === "crawling" ? body.state : "ready";
  // Images by absolute URL on this app's public catalog, as the browser sees the host (Host header).
  const host = req.headers.get("host");
  const imageBase = host ? `${new URL(req.url).protocol}//${host}` : new URL(req.url).origin;
  const f = fixturePreview(kind, { imageBase, state });
  await defaultPreviewRepo().create(f.record);
  const port = body.snapshotFixturePort;
  if (kind === "jewelry" && state === "ready" && typeof port === "number" && Number.isInteger(port) && port >= 1024 && port <= 65535) {
    const snapshot = await capturePageSnapshot(
      { key: f.record.key, origin: f.record.storeUrl, products: f.record.products, expiresAt: f.record.expiresAt },
      {
        fetcherOptions: {
          resolver: async () => [{ address: "93.184.215.14", family: 4 }],
          transport: (r) => pinnedRequest({ ...r, address: "127.0.0.1", family: 4 }, { protocol: "http:", port }),
          sleep: async () => {},
        },
      },
    );
    await defaultPreviewRepo().update(f.record.key, { snapshot });
  }
  return Response.json(
    { key: f.record.key, previewPath: `/s/${f.record.key}`, ownerPath: `/admin/${f.record.key}#t=${f.ownerToken}` },
    { status: 201, headers: { "Cache-Control": "no-store" } },
  );
}

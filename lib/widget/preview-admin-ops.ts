/**
 * Admin v0 operations on a store-URL preview (owner: A6, ADR-055). Server-only; the /admin/<key> server
 * actions call these AFTER verifyOwner (lib/widget/preview-admin.ts). Kept apart from the auth helpers
 * so middleware never bundles the crawler.
 */
import { reservePreview } from "@/lib/preview/caps";
import { defaultPreviewRepo, type PreviewRecord, type PreviewRepo, type PreviewSettings } from "@/lib/preview/repo";
import { getPreviewDeps, requeuePreviewCrawl } from "@/lib/preview/service";
import { validateSettings, type SettingsInput } from "./preview-settings";
export type AdminResult = { ok: true; message: "saved" | "removed" | "restored" | "reingest_started" } | { ok: false; error: string; retryAfterSec?: number };

/** Hides one product from the preview (settings.removedProductIds). Unknown ids are refused. */
export async function removeProduct(rec: PreviewRecord, productId: string, repo: PreviewRepo = defaultPreviewRepo()): Promise<AdminResult> {
  if (!rec.products.some((p) => p.id === productId)) return { ok: false, error: "unknown_product" };
  const removed = [...new Set([...(rec.settings.removedProductIds ?? []), productId])].slice(0, 60);
  await repo.update(rec.key, { settings: { ...rec.settings, version: 0, removedProductIds: removed }, updatedAt: new Date() });
  return { ok: true, message: "removed" };
}

export async function restoreProducts(rec: PreviewRecord, repo: PreviewRepo = defaultPreviewRepo()): Promise<AdminResult> {
  await repo.update(rec.key, { settings: { ...rec.settings, version: 0, removedProductIds: [] }, updatedAt: new Date() });
  return { ok: true, message: "restored" };
}

/** Validates and stores the widget settings (character, languages, default language, accent, greeting). */
export async function saveWidgetSettings(rec: PreviewRecord, input: SettingsInput, repo: PreviewRepo = defaultPreviewRepo()): Promise<AdminResult> {
  const v = validateSettings(input);
  if (!v.ok) return { ok: false, error: v.errors.join(",") };
  const { character, languages, defaultLanguage, accentColor, greeting } = v.settings;
  const next: PreviewSettings = { ...rec.settings, version: 0, character, languages, defaultLanguage, accentColor, greeting };
  await repo.update(rec.key, { settings: next, updatedAt: new Date() });
  return { ok: true, message: "saved" };
}

/**
 * Crawls the store again with the same caps: one preview on the durable per-IP (5/day) and global
 * (100/day) counters, then A10's crawl queue. Refused while a crawl for this key is still running.
 */
export async function reingestPreview(rec: PreviewRecord, req: Request, nowMs: number = Date.now()): Promise<AdminResult> {
  if (rec.state === "queued" || rec.state === "crawling") return { ok: false, error: "busy" };
  const deps = getPreviewDeps();
  const cap = await reservePreview(req, deps.counters, nowMs, deps.env);
  if (!cap.ok) return { ok: false, error: cap.error, retryAfterSec: cap.retryAfterSec };
  const queued = await requeuePreviewCrawl(rec.key).catch(() => false);
  if (!queued) {
    await cap.refund();
    return { ok: false, error: "busy" };
  }
  return { ok: true, message: "reingest_started" };
}

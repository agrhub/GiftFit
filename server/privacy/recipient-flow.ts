/**
 * Recipient gift flow (owner: A5, ADR-021/032): consent, capture, swatches, hearts, wishes and
 * done, shared by the app/api/recipient/* routes. Contract: server/contracts/api.ts.
 *
 * Recipient responses never carry prices, catalog ids or variant ids: items and swatches are
 * opaque per-request ids (carousel.ts) mapped back server-side here.
 */
import type { CaptureResponse, DeletePhotoResponse, DoneResponse, SwatchResponse } from "@/server/contracts/api";
import type { JewelryCategory, JewelryRules } from "@/server/contracts/giftfit";
import type { ImageContentType, JewelryKind } from "@/server/youcam/types";
import { analysisFailureCode, analysisFailureLog } from "./analysis-errors";
import { purgeYoucamArtifacts, youcamArtifactsOf } from "./delete-everything";
import { demoSubjectOf, fixtureFileFor, isDemoRequest, isFixtureRow } from "./demo";
import { CaptureDailyCapError, deleteInputPhotos, photoTtlMs, renderAndStore, runCapture, type CaptureItem, type CapturePhoto, type CapturePorts, type RenderView } from "./capture";
import { HAND_CATEGORIES, resolveCarousel, type ResolvedItem, type ResolvedSwatch } from "./carousel";
import type { PrivacyDeps } from "./deps";
import { recipientFaceShapeLabel, recipientUndertoneLabel } from "./labels";
import { expiryFromKey } from "./photo-store";
import { fixtureRenderRef, parseInputKey, parseRenderRef, tagOf } from "./renders";
import { isRenderFeature, type FitRequestRecord, type RecipientProfileRecord, type TryOnRecord } from "./repos/types";
import { signTryOnUrl } from "./signed-url";
import { isPreviewStoreId } from "@/server/widget/preview-key";
import { isTryOnEligible, requestTryOn, type TryOnAccess } from "./tryon-mode";

/** 409 code when a call asks for a try-on that this recipient does not get (A16, tryon-mode.ts). */
export function tryOnOffCode(request: Pick<FitRequestRecord, "storeId">): string {
  return isPreviewStoreId(request.storeId) ? "tryon_disabled_preview" : "tryon_off";
}

export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const PHOTO_TYPES = ["image/jpeg", "image/png"] as const;
/** Extra (non-default) swatch renders per Fit Request (ADR-032). Cached repeats don't count. */
export const MAX_EXTRA_RENDERS = 4;

export class FlowError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 413 | 415 | 422 | 429 | 503,
    readonly code: string,
    /** For 429: seconds until the limit has room again. */
    readonly retryAfterSec?: number,
  ) {
    super(code);
  }
}

/** 503 daily_cap_reached with Retry-After until the next UTC day (A1's YOUCAM_DAILY_UNIT_CAP). */
export function dailyCapError(deps: Pick<PrivacyDeps, "now">): FlowError {
  const now = deps.now();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return new FlowError(503, "daily_cap_reached", Math.max(1, Math.ceil((next - now.getTime()) / 1000)));
}

/** Route helper: FlowError → JSON response; 429/503 carry Retry-After when known. */
export function flowErrorResponse(err: FlowError): Response {
  const headers: Record<string, string> = { "Cache-Control": "private, no-store" };
  if (err.retryAfterSec) headers["Retry-After"] = String(err.retryAfterSec);
  return Response.json({ error: err.code }, { status: err.status, headers });
}

export { recipientFaceShapeLabel as faceShapeLabel, recipientUndertoneLabel as undertoneLabel } from "./labels";

/** Reads and validates one multipart photo field. */
export async function readPhoto(form: FormData, field: "selfie" | "hand", required: boolean): Promise<CapturePhoto | undefined> {
  const v = form.get(field);
  if (v === null || v === "") {
    if (required) throw new FlowError(400, `${field}_required`);
    return undefined;
  }
  if (typeof v === "string") throw new FlowError(400, `${field}_must_be_a_file`);
  if (!(PHOTO_TYPES as readonly string[]).includes(v.type)) throw new FlowError(415, `${field}_must_be_jpeg_or_png`);
  if (v.size > MAX_PHOTO_BYTES) throw new FlowError(413, `${field}_too_large`);
  if (v.size === 0) throw new FlowError(400, `${field}_empty`);
  return { bytes: new Uint8Array(await v.arrayBuffer()), contentType: v.type as CapturePhoto["contentType"] };
}

export async function recordConsent(deps: PrivacyDeps, request: FitRequestRecord): Promise<FitRequestRecord> {
  if (request.status === "created" || request.status === "opened") {
    const existing = await deps.repos.profiles.get(request.id);
    await deps.repos.profiles.upsert({
      fitRequestId: request.id,
      undertoneEstimate: existing?.undertoneEstimate ?? null,
      undertoneConfidence: existing?.undertoneConfidence ?? null,
      undertoneOverride: existing?.undertoneOverride ?? null,
      faceShape: existing?.faceShape ?? null,
      hasHandCapture: existing?.hasHandCapture ?? false,
      consentAt: deps.now(),
      expiresAt: request.expiresAt,
    });
    await deps.repos.fitRequests.setStatus(request.id, "consented");
    return { ...request, status: "consented" };
  }
  return request;
}

const absolute = (url: string, baseUrl: string) => (/^https?:\/\//i.test(url) ? url : new URL(url, baseUrl).toString());

const isHandItem = (sku: { category: JewelryCategory }) => HAND_CATEGORIES.includes(sku.category);

function captureItemFor(item: ResolvedItem, swatch: ResolvedSwatch, baseUrl: string): CaptureItem {
  const v = swatch.variant;
  return {
    catalogId: item.sku.id,
    kind: item.sku.category as JewelryKind,
    productImage: absolute(v.vto_image || v.images[0] || item.sku.attributes.vto_image, baseUrl),
    variantId: v.variantId,
  };
}

export interface CaptureFlowInput {
  request: FitRequestRecord;
  sessionToken: string;
  selfie: CapturePhoto;
  hand?: CapturePhoto;
  /** Origin used to make catalog image paths absolute for YouCam. */
  baseUrl: string;
  rules: Pick<JewelryRules, "estimateUndertone">;
  ports: CapturePorts;
  /**
   * Per-IP limit, called once right before the first YouCam call (never for demo requests or after a
   * refusal). Returns ok=false to refuse with 429 and no YouCam call.
   */
  beforeYoucam?: () => { ok: boolean; retryAfterSec: number } | Promise<{ ok: boolean; retryAfterSec: number }>;
  /** Who gets a try-on (A16). Absent = a public call (no owner cookie). */
  access?: TryOnAccess;
}

export async function captureFlow(deps: PrivacyDeps, input: CaptureFlowInput): Promise<CaptureResponse> {
  const { request } = input;
  const initial = await resolveCarousel(deps, request);
  // A16: public production recipients are hearts-only (0 units); only the owner's recording session or mock mode capture.
  const access = input.access ?? (await requestTryOn(deps, request, undefined, { skus: initial.map((c) => c.sku) }));
  if (access.mode === "off") throw new FlowError(409, tryOnOffCode(request));
  if (request.status === "created" || request.status === "opened") throw new FlowError(409, "consent_required");
  if (request.status === "completed") throw new FlowError(409, "already_completed");
  // The seeded judge demo is pre-captured from fixtures: a real capture would spend units.
  if (await isDemoRequest(deps, request)) throw new FlowError(409, "demo_request");

  const before = await deps.repos.profiles.get(request.id);
  // A new capture is a new photo: an earlier "Delete my photo now" applied to the old one.
  if (request.photoDeletedAt) await deps.repos.fitRequests.setPhotoDeletedAt(request.id, null);
  // Store-URL preview pieces whose photo try-on can't use are never rendered (A16): hearts-only.
  const triable = (c: ResolvedItem) => isTryOnEligible(c.sku);
  // Keep a photo only if some design rendered on it has another metal to try (privacy by default).
  const multi = (hand: boolean) => initial.some((c) => triable(c) && isHandItem(c.sku) === hand && c.swatches.length > 1);
  let carousel: ResolvedItem[] = initial;

  // A1's daily unit cap, checked for the whole capture before any call: refuse, nothing stored.
  if (input.ports.preflight) {
    const renders = initial.filter((c) => triable(c) && (!isHandItem(c.sku) || input.hand)).map((c) => c.sku.category as JewelryKind);
    if ((await input.ports.preflight({ analysis: true, renders })) === "daily_cap") throw dailyCapError(deps);
  }
  if (input.beforeYoucam) {
    const d = await input.beforeYoucam();
    if (!d.ok) throw new FlowError(429, "rate_limited", d.retryAfterSec);
  }
  const started = performance.now();
  let view;
  try {
    view = await runCapture(deps, input.ports, {
      request,
      sessionToken: input.sessionToken,
      selfie: input.selfie,
      hand: input.hand,
      // Defaults are chosen after the estimate is stored (server/fit defaultVariant: tone match first).
      items: async () => {
        carousel = await resolveCarousel(deps, request);
        return carousel.filter(triable).map((c) => captureItemFor(c, c.defaultSwatch, input.baseUrl));
      },
      rules: input.rules,
      consentAt: before?.consentAt ?? deps.now(),
      keepInputs: { selfie: multi(false), hand: multi(true) },
      dropInputs: () => isPhotoDeleted(deps, request.id),
    });
  } catch (err) {
    if (err instanceof CaptureDailyCapError) throw dailyCapError(deps); // photos dropped, half-analysis purged
    console.error("[privacy] capture failed:", analysisFailureLog(err));
    throw new FlowError(422, analysisFailureCode(err));
  }
  const processingSeconds = Math.round((performance.now() - started) / 100) / 10;
  // "Delete my photo now" arrived while rendering: wipe what this capture produced, show no images.
  const deletedMidway = await isPhotoDeleted(deps, request.id);
  if (deletedMidway) await wipeFaceImages(deps, request.id);

  const profile = (await deps.repos.profiles.get(request.id)) as RecipientProfileRecord;
  const estimate = profile.undertoneEstimate ?? view.undertone.undertone;
  const rendered = new Map(view.tryOns.map((t) => [t.catalogId, t]));
  return {
    // Carousel order; pieces that were not rendered because their photo can't be used say so (A16).
    tryons: carousel.flatMap((c): CaptureResponse["tryons"] => {
      const swatchId = c.defaultSwatch.swatchId;
      const t = rendered.get(c.sku.id);
      if (!t) return triable(c) ? [] : [{ itemId: c.itemId, swatchId, status: "skipped_not_eligible" }];
      if (deletedMidway) return [{ itemId: c.itemId, swatchId, status: "failed", failureReason: "photo_deleted" }];
      if (t.ok) return [{ itemId: c.itemId, swatchId, status: "ready", imageUrl: t.imageUrl }];
      if (t.code === "hand_photo_required") return [{ itemId: c.itemId, swatchId, status: "skipped_needs_hand" }];
      return [{ itemId: c.itemId, swatchId, status: "failed", failureReason: t.code === "daily_cap" ? "daily_cap_reached" : t.code }];
    }),
    undertone: {
      estimate,
      confidence: profile.undertoneConfidence ?? view.undertone.confidence,
      override: profile.undertoneOverride,
      label: recipientUndertoneLabel(estimate, profile.undertoneOverride),
    },
    faceShapeLabel: recipientFaceShapeLabel(profile.faceShape),
    processingSeconds,
  };
}

/** Render rows of a request with their parsed variant tag; newest first. */
async function renderRows(deps: PrivacyDeps, request: FitRequestRecord) {
  const rows = (await deps.repos.tryons.listForRequest(request.id)).filter((t) => isRenderFeature(t.feature) && t.catalogId);
  return rows
    .map((row) => ({ row, parsed: parseRenderRef(row.resultRef) }))
    .sort((a, b) => (b.parsed?.exp ?? 0) - (a.parsed?.exp ?? 0));
}

/** Whether a render's image can still be served. Demo fixture renders (shared files) live as long as the request allows. */
function liveRender(row: TryOnRecord, live: Set<string>, nowMs: number, request: Pick<FitRequestRecord, "status" | "photoDeletedAt">): boolean {
  if (isFixtureRow(row)) return request.status !== "completed" && !request.photoDeletedAt && row.expiresAt.getTime() > nowMs;
  const key = row.resultRef?.startsWith("store:") ? row.resultRef.slice("store:".length) : undefined;
  return Boolean(key && live.has(key) && (expiryFromKey(key) ?? 0) > nowMs && row.expiresAt.getTime() > nowMs);
}

/**
 * GET /api/recipient/capture (ADR-023): the CaptureResponse of an already-captured session,
 * rebuilt from stored state with freshly signed URLs (the recipient reloaded the page): one entry
 * per item, its default swatch. Renders that no longer exist (deleted at `done` or past their 1 h
 * TTL) come back as `failed` / `expired`. processingSeconds is 0: nothing was processed.
 */
export async function capturedView(deps: PrivacyDeps, request: FitRequestRecord, sessionToken: string): Promise<CaptureResponse> {
  const profile = await deps.repos.profiles.get(request.id);
  if (!profile?.undertoneEstimate) throw new FlowError(404, "not_captured");

  const carousel = await resolveCarousel(deps, request);
  const rows = await renderRows(deps, request);
  const live = new Set(await deps.photos.listForRequest(request.id));
  const nowMs = deps.now().getTime();
  const photoDeleted = Boolean(request.photoDeletedAt);
  const demo = Boolean(request.demo) || rows.some((r) => isFixtureRow(r.row));

  const tryons = carousel.map((c): CaptureResponse["tryons"][number] => {
    const { itemId, sku, defaultSwatch } = c;
    const swatchId = defaultSwatch.swatchId;
    if (!isTryOnEligible(sku)) return { itemId, swatchId, status: "skipped_not_eligible" };
    if (photoDeleted) return { itemId, swatchId, status: "failed", failureReason: "photo_deleted" };
    const vTag = tagOf(defaultSwatch.variant.variantId);
    const forDesign = rows.filter((r) => r.row.catalogId === sku.id);
    const entry = forDesign.find((r) => r.parsed?.kind === "d" && r.parsed.variantTag === vTag) ?? forDesign.find((r) => !r.parsed);
    if (!entry) {
      if (isHandItem(sku) && !profile.hasHandCapture) return { itemId, swatchId, status: "skipped_needs_hand" };
      if (demo) return { itemId, swatchId, status: "failed", failureReason: "demo_metal_unavailable" };
      return { itemId, swatchId, status: "failed", failureReason: "render_failed" };
    }
    if (!entry.row.resultRef) return { itemId, swatchId, status: "failed", failureReason: "render_unavailable" };
    if (!liveRender(entry.row, live, nowMs, request)) return { itemId, swatchId, status: "failed", failureReason: "expired" };
    const signed = signTryOnUrl({ tryOnId: entry.row.id, sessionToken, secret: deps.signingSecret, nowMs });
    return { itemId, swatchId, status: "ready", imageUrl: signed.url };
  });

  return {
    tryons,
    undertone: {
      estimate: profile.undertoneEstimate,
      confidence: profile.undertoneConfidence ?? 0,
      override: profile.undertoneOverride,
      label: recipientUndertoneLabel(profile.undertoneEstimate, profile.undertoneOverride),
    },
    faceShapeLabel: recipientFaceShapeLabel(profile.faceShape),
    processingSeconds: 0,
    ...(demo ? { demo: true } : {}),
  };
}

/** Successful extra swatch renders so far (the cap counts these; cached repeats add none). */
export async function extraRenderCount(deps: PrivacyDeps, request: FitRequestRecord): Promise<number> {
  return (await renderRows(deps, request)).filter((r) => r.parsed?.kind === "x").length;
}

function findSwatch(carousel: ResolvedItem[], itemId: unknown, swatchId: unknown): { item: ResolvedItem; swatch: ResolvedSwatch } {
  if (typeof itemId !== "string") throw new FlowError(400, "itemId_required");
  const item = carousel.find((c) => c.itemId === itemId);
  if (!item) throw new FlowError(400, "unknown_item");
  if (typeof swatchId !== "string") throw new FlowError(400, "swatchId_required");
  const swatch = item.swatches.find((s) => s.swatchId === swatchId);
  if (!swatch) throw new FlowError(400, "unknown_swatch");
  return { item, swatch };
}

export interface SwatchFlowInput {
  request: FitRequestRecord;
  sessionToken: string;
  body: unknown;
  baseUrl: string;
  ports: CapturePorts;
  /** Per-IP limit, called only when a real render is about to happen (not cached, demo, capped or refused). */
  beforeYoucam?: () => { ok: boolean; retryAfterSec: number } | Promise<{ ok: boolean; retryAfterSec: number }>;
  /** Who gets a try-on (A16). Absent = a public call (no owner cookie). */
  access?: TryOnAccess;
}

/**
 * POST /api/recipient/swatch: render one metal of one design on the kept photo, lazily.
 * Order: validate → cached render (free, never counts) → hand photo needed → cap → render.
 * At the cap the kept photos are deleted at once (no further render is possible).
 */
export async function swatchFlow(deps: PrivacyDeps, input: SwatchFlowInput): Promise<SwatchResponse> {
  const { request } = input;
  const carousel = await resolveCarousel(deps, request);
  // A16: a cached or demo render stays viewable, but a new render needs the same access as capture.
  const access = input.access ?? (await requestTryOn(deps, request, undefined, { skus: carousel.map((c) => c.sku) }));
  if (access.mode === "off") throw new FlowError(409, tryOnOffCode(request));
  if (request.status === "completed") throw new FlowError(409, "already_completed");
  if (request.status !== "tried_on") throw new FlowError(409, "not_captured");
  const b = input.body as { itemId?: unknown; swatchId?: unknown } | null;
  const { item, swatch } = findSwatch(carousel, b?.itemId, b?.swatchId);
  // After "Delete my photo now" there is no image of the recipient left to show or to render on.
  if (await isPhotoDeleted(deps, request.id)) return { status: "failed", failureReason: "photo_deleted", rendersLeft: 0 };
  const profile = await deps.repos.profiles.get(request.id);

  const nowMs = deps.now().getTime();
  const keys = await deps.photos.listForRequest(request.id);
  const live = new Set(keys);
  const hand = isHandItem(item.sku);
  const inputKey = keys
    .filter((k) => parseInputKey(k)?.kind === (hand ? "hand" : "selfie") && (expiryFromKey(k) ?? 0) > nowMs)
    .sort((x, y) => (expiryFromKey(y) ?? 0) - (expiryFromKey(x) ?? 0))[0];
  const photoTag = inputKey ? parseInputKey(inputKey)!.photoTag : undefined;

  const rows = await renderRows(deps, request);
  const extras = rows.filter((r) => r.parsed?.kind === "x").length;
  const left = () => Math.max(0, MAX_EXTRA_RENDERS - extras);
  // A16: a store-URL preview piece whose photo try-on can't use is never rendered.
  if (!isTryOnEligible(item.sku)) return { status: "failed", failureReason: "not_eligible", rendersLeft: left() };

  // Cached: this variant already rendered on the current photo (or, with no photo kept, any live render of it).
  const vTag = tagOf(swatch.variant.variantId);
  const cached = rows.find(
    (r) => r.row.catalogId === item.sku.id && r.parsed?.variantTag === vTag && (!photoTag || r.parsed.photoTag === photoTag) && liveRender(r.row, live, nowMs, request),
  );
  if (cached) {
    const signed = signTryOnUrl({ tryOnId: cached.row.id, sessionToken: input.sessionToken, secret: deps.signingSecret, nowMs });
    return { status: "ready", imageUrl: signed.url, rendersLeft: left() };
  }
  // Seeded judge demo: metals with a committed fixture "render" from it; never a YouCam call.
  const demoSubject = demoSubjectOf(rows.map((r) => r.row));
  if (request.demo || demoSubject) {
    const file = demoSubject ? await fixtureFileFor(demoSubject, item.sku.id, swatch.variant.metal) : undefined;
    if (!file || !demoSubject) return { status: "failed", failureReason: "demo_metal_unavailable", rendersLeft: left() };
    if (extras >= MAX_EXTRA_RENDERS) return { status: "cap_reached", rendersLeft: 0 };
    const row = await deps.repos.tryons.insert({
      fitRequestId: request.id,
      catalogId: item.sku.id,
      feature: `2d-vto/${item.sku.category}`,
      taskId: null,
      cacheKey: `demo-x-${vTag}`,
      resultRef: fixtureRenderRef(demoSubject, file, "x", swatch.variant.variantId, request.expiresAt.getTime()),
      status: "success",
      unitsCharged: 0,
      expiresAt: request.expiresAt,
    });
    const signed = signTryOnUrl({ tryOnId: row.id, sessionToken: input.sessionToken, secret: deps.signingSecret, nowMs });
    return { status: "ready", imageUrl: signed.url, rendersLeft: Math.max(0, MAX_EXTRA_RENDERS - (extras + 1)) };
  }
  if (hand && !profile?.hasHandCapture) return { status: "skipped_needs_hand", rendersLeft: left() };
  if (extras >= MAX_EXTRA_RENDERS) return { status: "cap_reached", rendersLeft: 0 };
  if (!inputKey || !photoTag) return { status: "failed", failureReason: "photo_expired", rendersLeft: left() };

  if (input.ports.preflight && (await input.ports.preflight({ analysis: false, renders: [item.sku.category as JewelryKind] })) === "daily_cap") throw dailyCapError(deps);
  if (input.beforeYoucam) {
    const d = await input.beforeYoucam();
    if (!d.ok) throw new FlowError(429, "rate_limited", d.retryAfterSec);
  }
  const photo = await deps.photos.get(inputKey);
  if (!photo) return { status: "failed", failureReason: "photo_expired", rendersLeft: left() };
  const view: RenderView = await renderAndStore(deps, input.ports, {
    request,
    sessionToken: input.sessionToken,
    item: captureItemFor(item, swatch, input.baseUrl),
    src: { bytes: photo.bytes, contentType: photo.contentType as ImageContentType },
    photoTag,
    kind: "x",
    ttlMs: photoTtlMs(deps, request),
  });
  if (!view.ok && view.code === "daily_cap") throw dailyCapError(deps); // refused before any work: nothing stored
  if (!view.ok) return { status: "failed", failureReason: view.code, rendersLeft: left() };
  // Deleted while this render was in flight: wipe it too.
  if (await isPhotoDeleted(deps, request.id)) {
    await wipeFaceImages(deps, request.id);
    return { status: "failed", failureReason: "photo_deleted", rendersLeft: 0 };
  }

  const remaining = Math.max(0, MAX_EXTRA_RENDERS - (extras + 1));
  // At the cap no further render can happen: the kept photos have no purpose left.
  if (remaining === 0) await deleteInputPhotos(deps, request.id);
  return { status: "ready", imageUrl: view.imageUrl, rendersLeft: remaining };
}

/** Hearts: `{ hearts: [{itemId, swatchId}] }` (variant hearts) or legacy `{ itemIds }` (default swatch). Replaces the set. */
export async function setHeartsFlow(
  deps: PrivacyDeps,
  request: FitRequestRecord,
  body: unknown,
): Promise<{ hearted: string[]; hearts: Array<{ itemId: string; swatchId: string }> }> {
  if (request.status === "completed") throw new FlowError(409, "already_completed");
  if (request.status !== "consented" && request.status !== "tried_on") throw new FlowError(409, "consent_required");
  const b = body as { hearts?: unknown; itemIds?: unknown } | null;
  const carousel = await resolveCarousel(deps, request);

  let pairs: Array<{ item: ResolvedItem; swatch: ResolvedSwatch }>;
  if (b?.hearts !== undefined) {
    if (!Array.isArray(b.hearts) || b.hearts.length > 36) throw new FlowError(400, "hearts must be an array of { itemId, swatchId }");
    pairs = b.hearts.map((h) => findSwatch(carousel, (h as { itemId?: unknown })?.itemId, (h as { swatchId?: unknown })?.swatchId));
  } else {
    const ids = b?.itemIds;
    if (!Array.isArray(ids) || ids.length > 12 || !ids.every((x) => typeof x === "string")) throw new FlowError(400, "itemIds must be an array of strings");
    pairs = (ids as string[]).map((id) => {
      const item = carousel.find((c) => c.itemId === id);
      if (!item) throw new FlowError(400, "unknown_item");
      return { item, swatch: item.defaultSwatch };
    });
  }
  const unique = [...new Map(pairs.map((p) => [`${p.item.itemId}|${p.swatch.swatchId}`, p])).values()];
  await deps.repos.hearts.set(
    request.id,
    unique.map((p) => ({ catalogId: p.item.sku.id, variantId: p.swatch.variant.variantId })),
  );
  return {
    hearted: [...new Set(unique.map((p) => p.item.itemId))],
    hearts: unique.map((p) => ({ itemId: p.item.itemId, swatchId: p.swatch.swatchId })),
  };
}

/** "Love the style, wish it came in another metal": a metal_wishes row, no render. Idempotent. */
export async function wishMetalFlow(deps: PrivacyDeps, request: FitRequestRecord, body: unknown): Promise<{ wished: string[] }> {
  if (request.status === "completed") throw new FlowError(409, "already_completed");
  if (request.status !== "consented" && request.status !== "tried_on") throw new FlowError(409, "consent_required");
  const itemId = (body as { itemId?: unknown } | null)?.itemId;
  if (typeof itemId !== "string") throw new FlowError(400, "itemId_required");
  const carousel = await resolveCarousel(deps, request);
  const item = carousel.find((c) => c.itemId === itemId);
  if (!item) throw new FlowError(400, "unknown_item");
  await deps.repos.wishes.add(request.id, item.sku.id);
  const wishedDesigns = new Set(await deps.repos.wishes.list(request.id));
  return { wished: carousel.filter((c) => wishedDesigns.has(c.sku.id)).map((c) => c.itemId) };
}

/** "Delete my photo now" was used (fit_requests.photo_deleted_at; re-read so in-flight work sees it). */
export async function isPhotoDeleted(deps: PrivacyDeps, fitRequestId: string): Promise<boolean> {
  return Boolean((await deps.repos.fitRequests.findById(fitRequestId))?.photoDeletedAt);
}

/**
 * Deletes every face-derived image of a request: input photos and every try-on render (blobs), the
 * server/youcam result-cache entries and the YouCam tasks (which hold the inputs and outputs). Signed
 * URLs then 404. Hearts, wishes and the numeric profile stay.
 */
export async function wipeFaceImages(deps: PrivacyDeps, fitRequestId: string) {
  const blobs = await deps.photos.deleteForRequest(fitRequestId);
  const { taskIds, cacheKeys } = await youcamArtifactsOf(deps, fitRequestId);
  const youcam = await purgeYoucamArtifacts(deps, taskIds, cacheKeys);
  const left = await deps.photos.listForRequest(fitRequestId);
  return { blobs, ...youcam, verified: left.length === 0 };
}

/**
 * POST /api/recipient/delete-photo (ADR-036, clarified): sets photo_deleted_at, then wipes every
 * face-derived image. Work still in flight (capture, swatch) re-checks the flag and wipes what it
 * produced. Idempotent.
 */
export async function deletePhotoFlow(deps: PrivacyDeps, request: FitRequestRecord): Promise<DeletePhotoResponse> {
  if (!request.photoDeletedAt) await deps.repos.fitRequests.setPhotoDeletedAt(request.id, deps.now());
  const r = await wipeFaceImages(deps, request.id);
  if (!r.verified) throw new FlowError(503, "photo_delete_unverified");
  return { photoDeleted: true, rendersLeft: 0 };
}

/**
 * Finish: status completed, and every stored image of the recipient (kept input photos and try-on
 * renders) is deleted now rather than at its 1 h TTL, so "photos stored: 0" is literally true.
 */
export async function doneFlow(deps: PrivacyDeps, request: FitRequestRecord): Promise<DoneResponse> {
  if (request.status === "created" || request.status === "opened") throw new FlowError(409, "consent_required");
  await deps.photos.deleteForRequest(request.id);
  if (request.status !== "completed") await deps.repos.fitRequests.setStatus(request.id, "completed");
  const left = await deps.photos.listForRequest(request.id);
  if (left.length) throw new FlowError(503, "photo_delete_unverified");
  return { photosDeleted: true, photosStored: 0, completedAt: deps.now().toISOString() };
}

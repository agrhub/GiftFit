/**
 * Recipient capture lifecycle (owner: A5).
 *
 *   1. selfie (+ optional back-of-hand photo) -> PhotoStore, TTL <= 1 h (capped at link expiry)
 *   2. Facial Color Tones + Face Attributes -> undertone ESTIMATE + face shape (no hex stored)
 *   3. jewelry try-ons of each design's DEFAULT metal (chosen after the estimate is known); each
 *      render is copied into the PhotoStore (TTL <= 1 h) as `store:<key>`, served only by the
 *      signed, session-bound route
 *   4. input photos: deleted in `finally`, unless `keepInputs` says a photo is still needed for
 *      lazy metal-swatch renders (ADR-032). Kept photos are deleted at Done, at the 4-render cap,
 *      on delete-everything, and in any case by their <= 1 h TTL. A failed analysis always deletes.
 *
 * YouCam task ids and cache keys are recorded per request so deleteEverything can remove
 * YouCam's copy and purge the result cache. Hex colors are returned to the recipient once
 * (they may see them) and never persisted.
 */
import type { FaceShape, FacialColors, JewelryRules, UndertoneEstimate } from "@/lib/contracts/giftfit";
import type { PlanItem, YoucamClient } from "@/lib/youcam/client";
import { DailyCapError, YoucamTaskError } from "@/lib/youcam/errors";
import { fitRequestPlan } from "@/lib/youcam/fit-request";
import { GIFT_FACE_FEATURES, HAND_JEWELRY } from "@/lib/youcam/features";
import type { ImageContentType, ImageInput, JewelryKind } from "@/lib/youcam/types";
import type { PaidGrant } from "@/lib/youcam/recording";
import { analysisCrop } from "./analysis-crop";
import type { PrivacyDeps } from "./deps";
import { PHOTO_MAX_TTL_MS } from "./photo-store";
import { parseInputKey, renderName, tagOf, type RenderKind } from "./renders";
import type { FitRequestRecord, TryOnRecord } from "./repos/types";
import { signTryOnUrl } from "./signed-url";

/** Parallel VTO renders per capture (the shared rate limiter in lib/youcam still applies). */
export const RENDER_CONCURRENCY = 3;

export interface CapturePhoto {
  bytes: Uint8Array;
  contentType: ImageContentType;
}

export interface CaptureItem {
  catalogId: string;
  kind: JewelryKind;
  /** Spec-compliant product image (public catalog URL) of the metal being rendered. */
  productImage: string;
  /** Metal variant rendered (`<designId>:<metal>`); names the stored render (renders.ts). */
  variantId?: string;
}

export interface YoucamTaskRef {
  feature: string;
  taskId: string;
  cacheKey: string;
  unitsCharged: number;
}

export interface AnalysisOutcome {
  colors: FacialColors;
  faceShape?: FaceShape;
  tasks: YoucamTaskRef[];
}

export type RenderOutcome =
  | ({ catalogId: string; kind: JewelryKind; ok: true; url: string } & YoucamTaskRef)
  | { catalogId: string; kind: JewelryKind; ok: false; code: string };

/** The YouCam-facing half, injectable for tests. `youcamCapturePorts(client)` is the real one. */
export interface CapturePorts {
  analyze(selfie: ImageInput): Promise<AnalysisOutcome>;
  render(kind: JewelryKind, src: ImageInput, catalogId: string, productImage: string): Promise<RenderOutcome>;
  /** Downloads a render from YouCam's short-lived result URL. */
  fetchImage(url: string): Promise<{ bytes: Uint8Array; contentType: string }>;
  /**
   * Cost-guard check for a whole plan before any call (A1's daily unit cap). "daily_cap" means the
   * day's units would be exceeded: refuse up front so no partial work is left behind.
   */
  preflight?(plan: { analysis: boolean; renders: JewelryKind[] }): Promise<"ok" | "daily_cap">;
}

/** Thrown by youcamCapturePorts.analyze when A1's daily unit cap refuses a call (after cleaning up). */
export class CaptureDailyCapError extends Error {
  constructor() {
    super("daily_cap");
    this.name = "CaptureDailyCapError";
  }
}

export interface CaptureInput {
  request: FitRequestRecord;
  /** Recipient token in clear (only to sign this session's URLs; never stored). */
  sessionToken: string;
  selfie: CapturePhoto;
  hand?: CapturePhoto;
  /** Items to render, or a function of the fresh estimate (to pick each design's default metal). */
  items: CaptureItem[] | ((estimate: UndertoneEstimate) => CaptureItem[] | Promise<CaptureItem[]>);
  rules: Pick<JewelryRules, "estimateUndertone">;
  consentAt: Date;
  /** Keep input photos (<= 1 h) for lazy swatch renders. Default: delete both right after rendering. */
  keepInputs?: { selfie?: boolean; hand?: boolean };
  /** Checked in `finally`: true drops every input photo regardless of keepInputs ("Delete my photo now" mid-capture). */
  dropInputs?: () => Promise<boolean>;
}

export type RenderView =
  | { tryOnId: string; catalogId: string; kind: JewelryKind; variantId?: string; ok: true; imageUrl: string; imageUrlExpiresAt: number }
  | { catalogId: string; kind: JewelryKind; variantId?: string; ok: false; code: string };

/** Recipient-only view. The hex is for the recipient's own Transparency Card and is not stored. */
export interface CaptureView {
  undertone: Pick<UndertoneEstimate, "undertone" | "confidence">;
  skinHex: string;
  faceShape: FaceShape;
  tryOns: RenderView[];
  /** True when no input photo is stored any more. */
  photosDeleted: boolean;
}

export const photoTtlMs = (deps: PrivacyDeps, request: FitRequestRecord) =>
  Math.min(PHOTO_MAX_TTL_MS, Math.max(1, request.expiresAt.getTime() - deps.now().getTime()));

/** Deletes the request's stored input photos (selfie and/or hand). Returns how many. */
export async function deleteInputPhotos(deps: PrivacyDeps, fitRequestId: string, only?: "selfie" | "hand"): Promise<number> {
  const keys = (await deps.photos.listForRequest(fitRequestId)).filter((k) => k.startsWith("recipient/") && (!only || parseInputKey(k)?.kind === only));
  if (keys.length) await deps.photos.delete(keys);
  return keys.length;
}

/**
 * Renders one item on `src`, copies the image into the PhotoStore under a variant-named key and
 * records the YouCam task. Shared by capture (kind "d") and lazy swatch renders (kind "x").
 */
export async function renderAndStore(
  deps: PrivacyDeps,
  ports: CapturePorts,
  args: { request: FitRequestRecord; sessionToken: string; item: CaptureItem; src: ImageInput; photoTag: string; kind: RenderKind; ttlMs: number },
): Promise<RenderView> {
  const { request, item } = args;
  let out: RenderOutcome;
  try {
    out = await ports.render(item.kind, args.src, item.catalogId, item.productImage);
  } catch {
    out = { catalogId: item.catalogId, kind: item.kind, ok: false, code: "render_failed" };
  }
  if (!out.ok) return { catalogId: item.catalogId, kind: item.kind, variantId: item.variantId, ok: false, code: out.code };
  let ref: string | null = null;
  try {
    const img = await ports.fetchImage(out.url);
    const name = item.variantId ? renderName(args.kind, item.variantId, args.photoTag) : undefined;
    const stored = await deps.photos.put({ fitRequestId: request.id, kind: "tryon", bytes: img.bytes, contentType: img.contentType, ttlMs: args.ttlMs, name });
    ref = `store:${stored.key}`;
  } catch {
    // Record the task (so it is deleted later) but show the item as failed.
  }
  const row = await recordTask(deps, request, out, item.catalogId, ref);
  if (!ref) return { catalogId: item.catalogId, kind: item.kind, variantId: item.variantId, ok: false, code: "render_unavailable" };
  const signed = signTryOnUrl({ tryOnId: row.id, sessionToken: args.sessionToken, secret: deps.signingSecret, nowMs: deps.now().getTime() });
  return { tryOnId: row.id, catalogId: item.catalogId, kind: item.kind, variantId: item.variantId, ok: true, imageUrl: signed.url, imageUrlExpiresAt: signed.exp };
}

export async function runCapture(deps: PrivacyDeps, ports: CapturePorts, input: CaptureInput): Promise<CaptureView> {
  const { request } = input;
  const ttlMs = photoTtlMs(deps, request);
  const inputKeys: { key: string; kind: "selfie" | "hand" }[] = [];
  let analysed = false;
  try {
    // A re-capture replaces any photo kept from an earlier capture.
    await deleteInputPhotos(deps, request.id);
    const selfieTag = tagOf(input.selfie.bytes);
    const selfie = await deps.photos.put({ fitRequestId: request.id, kind: "selfie", bytes: input.selfie.bytes, contentType: input.selfie.contentType, ttlMs, name: selfieTag });
    inputKeys.push({ key: selfie.key, kind: "selfie" });
    const handTag = input.hand ? tagOf(input.hand.bytes) : "";
    if (input.hand) {
      const hand = await deps.photos.put({ fitRequestId: request.id, kind: "hand", bytes: input.hand.bytes, contentType: input.hand.contentType, ttlMs, name: handTag });
      inputKeys.push({ key: hand.key, kind: "hand" });
    }
    const selfieImg: ImageInput = { bytes: input.selfie.bytes, contentType: input.selfie.contentType };
    const handImg: ImageInput | undefined = input.hand ? { bytes: input.hand.bytes, contentType: input.hand.contentType } : undefined;

    // Analysis: estimate only.
    const analysis = await ports.analyze(selfieImg);
    analysed = true;
    for (const t of analysis.tasks) await recordTask(deps, request, t, null, null);
    const estimate = input.rules.estimateUndertone(analysis.colors);
    const faceShape = analysis.faceShape ?? "Unknown";
    const existing = await deps.repos.profiles.get(request.id);
    await deps.repos.profiles.upsert({
      fitRequestId: request.id,
      undertoneEstimate: estimate.undertone,
      undertoneConfidence: estimate.confidence,
      undertoneOverride: existing?.undertoneOverride ?? null,
      faceShape,
      hasHandCapture: Boolean(input.hand),
      consentAt: input.consentAt,
      expiresAt: request.expiresAt,
    });
    const items = typeof input.items === "function" ? await input.items(estimate) : input.items;

    // Renders, up to RENDER_CONCURRENCY at a time (keeps the whole capture under ~45 s); order kept.
    const renderOne = async (item: CaptureItem): Promise<RenderView> => {
      const isHand = HAND_JEWELRY.includes(item.kind);
      const src = isHand ? handImg : selfieImg;
      if (!src) return { catalogId: item.catalogId, kind: item.kind, variantId: item.variantId, ok: false, code: "hand_photo_required" };
      return renderAndStore(deps, ports, { request, sessionToken: input.sessionToken, item, src, photoTag: isHand ? handTag : selfieTag, kind: "d", ttlMs });
    };
    const tryOns: RenderView[] = new Array(items.length);
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const i = next++;
        tryOns[i] = await renderOne(items[i]);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(RENDER_CONCURRENCY, items.length)) }, worker));

    await deps.repos.fitRequests.setStatus(request.id, "tried_on");
    const kept = inputKeys.filter((k) => input.keepInputs?.[k.kind]);
    return {
      undertone: { undertone: estimate.undertone, confidence: estimate.confidence },
      skinHex: analysis.colors.skin_color,
      faceShape,
      tryOns,
      photosDeleted: kept.length === 0,
    };
  } finally {
    // Input photos never outlive the capture unless kept for swatches (and never if analysis failed).
    const dropAll = !analysed || (input.dropInputs ? await input.dropInputs().catch(() => true) : false);
    const drop = inputKeys.filter((k) => dropAll || !input.keepInputs?.[k.kind]).map((k) => k.key);
    if (drop.length) await deps.photos.delete(drop);
  }
}

async function recordTask(
  deps: PrivacyDeps,
  request: FitRequestRecord,
  t: YoucamTaskRef,
  catalogId: string | null,
  resultRef: string | null,
): Promise<TryOnRecord> {
  return deps.repos.tryons.insert({
    fitRequestId: request.id,
    catalogId,
    feature: t.feature,
    taskId: t.taskId,
    cacheKey: t.cacheKey,
    resultRef,
    status: resultRef || !t.feature.startsWith("2d-vto/") ? "success" : "unavailable",
    unitsCharged: t.unitsCharged,
    expiresAt: request.expiresAt,
  });
}

/**
 * Real ports over the lib/youcam client: the typed tasks, one per call, so every render can be
 * named by its metal variant and cached per (photo, variant).
 */
export function youcamCapturePorts(client: YoucamClient, opts: { fetch?: typeof fetch; baseUrl?: string; paidGrant?: PaidGrant } = {}): CapturePorts {
  const doFetch = opts.fetch ?? fetch;
  // A16: the owner-recording grant rides on every task; without it the shared client refuses paid tasks.
  const run = opts.paidGrant ? { paidGrant: opts.paidGrant } : undefined;
  /**
   * One analysis half on the face crop (analysis-crop.ts); if YouCam refuses it (a failed task is refunded), that half
   * alone runs once more on the full frame. So the analyses cost at most 20 + 10 whatever passes where.
   */
  const withFallback = async <T>(crop: ImageInput | null, full: ImageInput, task: (img: ImageInput) => Promise<T>): Promise<T> => {
    if (crop) {
      try {
        return await task(crop);
      } catch (err) {
        if (!(err instanceof YoucamTaskError)) throw err;
      }
    }
    return task(full);
  };
  return {
    // The analyses read the face crop; the try-ons keep the full frame (neck and ears in view).
    async analyze(selfie) {
      const crop = "bytes" in selfie ? await analysisCrop(selfie).catch(() => null) : null;
      const settled = await Promise.allSettled([
        withFallback(crop, selfie, (img) => client.facialColorTones(img, { faceAngleStrictness: "high" }, run)),
        withFallback(crop, selfie, (img) => client.faceAttributes(img, { features: GIFT_FACE_FEATURES }, run)),
      ]);
      const failed = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed) {
        // One half failed: delete the other half's YouCam task and cache entry so nothing is left behind.
        const done = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
        if (done.length) await client.purge({ cacheKeys: done.map((r) => r.cacheKey), taskIds: done.map((r) => r.taskId) }).catch(() => undefined);
        if (failed.reason instanceof DailyCapError) throw new CaptureDailyCapError();
        throw failed.reason;
      }
      const [tones, attrs] = settled.map((r) => (r as PromiseFulfilledResult<unknown>).value) as [
        Awaited<ReturnType<YoucamClient["facialColorTones"]>>,
        Awaited<ReturnType<YoucamClient["faceAttributes"]>>,
      ];
      return {
        colors: tones.result.color,
        faceShape: attrs.result.faceshape,
        tasks: [tones, attrs].map((r) => ({ feature: r.feature, taskId: r.taskId, cacheKey: r.cacheKey, unitsCharged: r.unitsCharged })),
      };
    },
    async render(kind, src, catalogId, productImage) {
      try {
        const r = await client.jewelryVto(kind, src, { products: [{ url: productImage }] }, run);
        return { catalogId, kind, ok: true, url: r.result.url, feature: r.feature, taskId: r.taskId, cacheKey: r.cacheKey, unitsCharged: r.unitsCharged };
      } catch (err) {
        const e = err as { code?: string; engineError?: string; reason?: string };
        return { catalogId, kind, ok: false, code: e.engineError ?? e.code ?? e.reason ?? "render_failed" };
      }
    },
    async preflight(plan) {
      const items = [
        ...(plan.analysis ? fitRequestPlan([]) : []),
        ...plan.renders.map((kind) => ({ feature: `2d-vto/${kind}` as const, params: { products: [{ url: "https://example.invalid/p.png" }] } })),
      ] as PlanItem[];
      if (!items.length) return "ok";
      const d = await client.preflight(items);
      return d.reason === "daily_cap" ? "daily_cap" : "ok";
    },
    async fetchImage(url) {
      const abs = url.startsWith("/") && opts.baseUrl ? new URL(url, opts.baseUrl).toString() : url;
      const res = await doFetch(abs, { cache: "no-store" });
      if (!res.ok) throw new Error(`render fetch failed: ${res.status}`);
      return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get("content-type") ?? "image/png" };
    },
  };
}

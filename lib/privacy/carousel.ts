/**
 * Recipient carousel (owner: A5, ADR-021/032). The recipient sees shortlist + decoys as one list of
 * 6 items with OPAQUE per-request item ids, in a per-request shuffled order:
 *   itemId   = base64url(HMAC(secret, "item|<requestId>|<catalogId>"))[0..16)
 *   swatchId = base64url(HMAC(secret, "swatch|<requestId>|<variantId>"))[0..16)
 *   order    = Fisher–Yates driven by HMAC(secret, "order|<requestId>|<i>")
 * Swatches are each design's eligible metal variants (giver's budget cap and metal lock), leveled
 * across shortlist and decoys by lib/fit's swatchCap so the swatch count betrays nothing. No prices,
 * no catalog ids and no variant ids ever leave the server on recipient routes.
 */
import { createHmac } from "node:crypto";
import type { CarouselItem, RecipientSessionResponse } from "@/lib/contracts/api";
import type { CatalogSku, JewelryCategory, Metal, MetalVariant, Occasion, Undertone } from "@/lib/contracts/giftfit";
import { SWATCH_LABEL, defaultVariant, swatchCap, variantsOf, visibleVariants, type VariantRequest } from "@/lib/fit/variants";
import type { PrivacyDeps } from "./deps";
import { parseRenderRef, tagOf } from "./renders";
import { isRenderFeature, type FitRequestRecord, type FitRequestStatus } from "./repos/types";
import { isPreviewStoreId } from "@/lib/widget/preview-key";
import { isTryOnEligible, requestTryOn } from "./tryon-mode";


export const HAND_CATEGORIES: readonly JewelryCategory[] = ["ring", "bracelet", "watch"];

/** Swatch chip colors: product metal colors, not face colors. */
export const METAL_SWATCH_COLOR: Record<Metal, string> = {
  yellow_gold: "#D4AF37",
  rose_gold: "#B76E79",
  white_gold: "#E8E6E1",
  silver: "#C0C0C0",
  platinum: "#E5E4E2",
  mixed_two_tone: "#CFC09A",
};

const hmac16 = (secret: string, msg: string) => createHmac("sha256", secret).update(msg, "utf8").digest("base64url").slice(0, 16);

export function itemIdFor(secret: string, requestId: string, catalogId: string): string {
  return hmac16(secret, `item|${requestId}|${catalogId}`);
}

export function swatchIdFor(secret: string, requestId: string, variantId: string): string {
  return hmac16(secret, `swatch|${requestId}|${variantId}`);
}

function orderFor<T>(secret: string, requestId: string, list: readonly T[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const r = createHmac("sha256", secret).update(`order|${requestId}|${i}`, "utf8").digest().readUInt32BE(0);
    const j = r % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function variantRequestOf(request: FitRequestRecord): VariantRequest {
  return {
    budgetMax: request.budgetMax ?? Number.MAX_SAFE_INTEGER,
    currency: request.currency ?? "USD",
    metalLock: request.metalLock && request.metalLock.length ? request.metalLock : undefined,
  };
}

export interface ResolvedSwatch {
  swatchId: string;
  variant: MetalVariant;
  isDefault: boolean;
}

export interface ResolvedItem {
  itemId: string;
  sku: CatalogSku;
  /** Visible swatches in listing order; exactly one isDefault. */
  swatches: ResolvedSwatch[];
  defaultSwatch: ResolvedSwatch;
}

type CarouselDeps = Pick<PrivacyDeps, "signingSecret" | "catalog" | "repos"> & Partial<Pick<PrivacyDeps, "youcamMode" | "youcamPaidReady">>;

/** Tone input for lib/fit defaultVariant: the override, else the estimate; null before capture. */
function toneOf(p: { undertoneEstimate: Undertone | null; undertoneOverride: Undertone | null } | undefined) {
  if (!p || (!p.undertoneEstimate && !p.undertoneOverride)) return null;
  return { undertoneEstimate: (p.undertoneEstimate ?? p.undertoneOverride)!, undertoneOverride: p.undertoneOverride ?? undefined };
}

/** All carousel items of a request, in display order, with their (server-only) catalog SKU and variants. */
export async function resolveCarousel(deps: CarouselDeps, request: FitRequestRecord): Promise<ResolvedItem[]> {
  const secret = deps.signingSecret;
  const [shortlist, decoys, profile, rows] = await Promise.all([
    deps.catalog.getSkus([...new Set(request.shortlistIds)]),
    deps.catalog.getSkus([...new Set(request.decoyIds)].filter((id) => !request.shortlistIds.includes(id))),
    deps.repos.profiles.get(request.id),
    deps.repos.tryons.listForRequest(request.id),
  ]);
  const vr = variantRequestOf(request);
  const cap = swatchCap(shortlist, decoys, vr);

  // The variant rendered at capture wins as default, so the default never moves after capture.
  const renderedDefault = new Map<string, { tag: string; exp: number }>();
  for (const r of rows) {
    if (!r.catalogId || !isRenderFeature(r.feature)) continue;
    const p = parseRenderRef(r.resultRef);
    if (p?.kind !== "d") continue;
    const prev = renderedDefault.get(r.catalogId);
    if (!prev || p.exp > prev.exp) renderedDefault.set(r.catalogId, { tag: p.variantTag, exp: p.exp });
  }

  const items: ResolvedItem[] = [...shortlist, ...decoys].map((sku) => {
    const visible = visibleVariants(sku, vr, cap);
    const variants = visible.length ? visible : variantsOf(sku).slice(0, 1);
    const rendered = renderedDefault.get(sku.id);
    const def =
      (rendered && variants.find((v) => tagOf(v.variantId) === rendered.tag)) ??
      defaultVariant(sku, vr, toneOf(profile), cap) ??
      variants[0];
    const swatches = variants.map((variant) => ({ swatchId: swatchIdFor(secret, request.id, variant.variantId), variant, isDefault: variant.variantId === def.variantId }));
    if (!swatches.some((s) => s.isDefault)) swatches[0].isDefault = true;
    return { itemId: itemIdFor(secret, request.id, sku.id), sku, swatches, defaultSwatch: swatches.find((s) => s.isDefault)! };
  });
  items.sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0)); // input order must not leak
  return orderFor(secret, request.id, items);
}

export function toCarouselItem(r: ResolvedItem): CarouselItem {
  const { sku } = r;
  const def = r.defaultSwatch.variant;
  return {
    itemId: r.itemId,
    title: sku.title,
    category: sku.category,
    productImage: def.images[0] ?? sku.images[0] ?? def.vto_image,
    needsHandPhoto: HAND_CATEGORIES.includes(sku.category),
    // A16: a store-URL preview photo that try-on can't use; hearts-only for this piece.
    ...(isTryOnEligible(sku) ? {} : { tryOn: false as const }),
    swatches: r.swatches.map((s) => ({
      swatchId: s.swatchId,
      metalLabel: SWATCH_LABEL[s.variant.metal],
      swatchColor: METAL_SWATCH_COLOR[s.variant.metal],
      isDefault: s.isDefault,
    })),
  };
}

export function sessionStatus(status: FitRequestStatus): RecipientSessionResponse["status"] {
  switch (status) {
    case "created":
    case "opened":
      return "awaiting_consent";
    case "consented":
      return "awaiting_capture";
    case "tried_on":
      return "trying_on";
    case "completed":
      return "completed";
    default:
      return "expired";
  }
}

/**
 * `req` carries the owner-recording cookie (A16, tryon-mode.ts); without it the call is treated as public.
 */
export async function sessionResponse(deps: CarouselDeps, request: FitRequestRecord, req?: Pick<Request, "headers">): Promise<RecipientSessionResponse> {
  const items = await resolveCarousel(deps, request);
  // Who gets a try-on (A16): owner recording / mock rehearsal → try-on; public production → hearts-only.
  // Seeded judge demo (demo.ts): fixture try-on rows or the memory flag; A4 shows an "AI-generated model, demo" badge.
  const access = await requestTryOn(deps, request, req, { skus: items.map((i) => i.sku) });
  const demo = access.mode === "demo";
  const preview = isPreviewStoreId(request.storeId);
  return {
    status: sessionStatus(request.status),
    occasion: (request.occasion as Occasion | null) ?? null,
    expiresAt: request.expiresAt.toISOString(),
    items: items.map(toCarouselItem),
    ...(demo ? { demo: true } : {}),
    ...(access.mode === "off" ? { tryOn: false as const, ...(access.note ? { tryOnNote: access.note } : {}) } : {}),
    ...(preview ? { preview: true as const } : {}),
    // The gift pages' header names the preview's store, never the Aurum demo store (ADR-055).
    ...(isPreviewStoreId(request.storeId) && request.storeName ? { storeName: request.storeName } : {}),
    // The preview behind it is gone (ADR-055): its pieces can't be shown any more.
    ...(isPreviewStoreId(request.storeId) && items.length === 0 ? { previewExpired: true as const } : {}),
  };
}

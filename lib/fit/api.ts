/**
 * Handlers behind app/api/fit/* (route files stay thin; Next.js route modules may only export
 * HTTP methods and config). All routes are GIVER-FACING: responses carry only the explicit types
 * below (lib/contracts/api.ts for create and report), built field by field and sent through A5's
 * `giverJson`, so no recipient image, hex, CIELAB, face attribute or undertone number can reach
 * the giver (MASTER_PLAN v2 §4.4). Requests are stored only in lib/privacy (ADR-021).
 */
import { createHash, createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import type { CreateFitRequestResponse, GiverReportStatus } from "@/lib/contracts/api";
import { type CatalogSku, type FitResult, METALS, OCCASIONS, type RecipientProfile } from "@/lib/contracts/giftfit";
import { findGiverLeaks, giverJson } from "@/lib/privacy/giver-guard";
import { fitRequestExpiresAt, newFitRequestTokens } from "@/lib/privacy/tokens";
import { type DecoyReasonCode, selectDecoys } from "./decoys";
import type { FitDeps } from "./deps";
import { explainFit } from "./explain";
import { FACE_SHAPE_LABEL, UNDERTONE_LABEL, capitalize } from "./labels";
import type { StoredFitRequest } from "./repository";
import { RETURN_RISK_DEFAULTS, RETURN_RISK_FORMULA, RETURN_RISK_LABEL, RETURN_RISK_SOURCES, type ReturnRiskInputs } from "./returnRisk";
import { effectiveUndertone, scoreSkus } from "./score";
import { type VariantRequest, eligibleVariants, swatchCap, variantView, variantsOf, visibleVariants } from "./variants";
import { FIT_FORMULA, FIT_PARAMS, FIT_WEIGHTS, FIT_WEIGHTS_VERSION } from "./weights";

export type { CreateFitRequestResponse, GiverReportStatus };

export const FIT_DISCLAIMER = "AI try-on preview. Undertone and face shape are estimates. Not a sizing guarantee.";

/** @deprecated P2 name; POST /api/fit/report now returns the contract's `GiverReportStatus`. */
export type GiverFitReportResponse = GiverReportStatus;

/**
 * POST /api/fit/decoys → 200. A preview for an arbitrary shortlist with a fresh random seed; it can
 * never reproduce the decoys of a stored request (those are chosen in POST /api/fit/requests).
 */
export interface DecoysResponse {
  decoyIds: string[];
  carouselSize: number;
  ok: boolean;
  reasons: DecoyReasonCode[];
}

/** GET /api/fit/weights → 200. The published scoring and return-risk formulas. */
export interface FitWeightsResponse {
  version: string;
  weights: typeof FIT_WEIGHTS;
  params: typeof FIT_PARAMS;
  formula: readonly string[];
  returnRisk: { formula: string; defaults: ReturnRiskInputs; label: string; sources: readonly string[] };
}

/** Error body (the contract's `ApiError` shape). */
export interface FitErrorResponse {
  error: "bad_request" | "not_found" | "fit_rules_not_configured" | "unknown_sku" | "insufficient_catalog" | "no_eligible_variant";
  message?: string;
}

/** Every giver route's response body type, for A5's route enumeration test. */
export type GiverFitResponse = CreateFitRequestResponse | GiverReportStatus | DecoysResponse | FitWeightsResponse | FitErrorResponse;

/** Every giver response goes through A5's guard (fails closed with a 500 on any recipient-data leak). */
const json = <T extends GiverFitResponse>(body: T, status = 200) => giverJson(body, { status });

const ReportBody = z.object({ giverToken: z.string().min(16).max(256) });
const DecoysBody = z.object({ shortlistIds: z.array(z.string().min(1).max(128)).min(1).max(4) });
const CreateBody = z
  .object({
    storeId: z.string().min(1).max(128).optional(),
    occasion: z.enum(OCCASIONS),
    budgetMin: z.number().finite().min(0).max(1_000_000).optional(),
    budgetMax: z.number().finite().min(0).max(1_000_000),
    metalLock: z.array(z.enum(METALS)).min(1).max(METALS.length).optional(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    shortlistIds: z.array(z.string().min(1).max(128)).min(1).max(4),
  })
  .refine((b) => b.budgetMax > 0 && b.budgetMax >= (b.budgetMin ?? 0), { message: "budgetMax must be > 0 and ≥ budgetMin" })
  .refine((b) => !b.metalLock || new Set(b.metalLock).size === b.metalLock.length, { message: "metalLock must be unique" })
  .refine((b) => new Set(b.shortlistIds).size === b.shortlistIds.length, { message: "shortlistIds must be unique" });

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

/** Seed = HMAC(server secret, request id): reproducible for audits, unguessable for the recipient. */
export function decoySeed(secret: string, requestId: string): string {
  return createHmac("sha256", secret).update(requestId).digest("hex");
}

// ------------------------------------------------------------------ POST /api/fit/requests

/**
 * Creates a Fit Request: validates the shortlist, picks decoys server-side (never returned), mints
 * the giver and recipient tokens (only their SHA-256 hashes are stored, in lib/privacy) with the
 * 72 h expiry. Refuses (422 insufficient_catalog) rather than create a request with < 2 decoys.
 */
export async function handleCreateRequest(req: Request, deps: FitDeps): Promise<Response> {
  const parsed = CreateBody.safeParse(await readJson(req));
  if (!parsed.success) return json<FitErrorResponse>({ error: "bad_request", message: parsed.error.issues[0]?.message }, 400);
  const body = parsed.data;
  const shortlist = await deps.repository.getSkus(body.shortlistIds);
  if (shortlist.length !== body.shortlistIds.length) return json<FitErrorResponse>({ error: "unknown_sku" }, 404);
  const storeId = body.storeId ?? shortlist[0].storeId;
  if (shortlist.some((s) => s.storeId !== storeId)) {
    return json<FitErrorResponse>({ error: "bad_request", message: "shortlist must come from one store" }, 400);
  }

  // Only variants under the cap and inside the lock reach the recipient (ADR-032): every design needs one.
  const variantRequest: VariantRequest = { budgetMax: body.budgetMax, currency: body.currency, metalLock: body.metalLock };
  const blocked = shortlist.find((s) => eligibleVariants(s, variantRequest).length === 0);
  if (blocked) {
    return json<FitErrorResponse>({ error: "no_eligible_variant", message: `no metal of ${blocked.title} fits the budget cap and metal lock` }, 422);
  }

  const id = randomUUID();
  const sel = selectDecoys(shortlist, await deps.repository.listCatalog(storeId), { seed: decoySeed(deps.decoySecret, id), request: variantRequest });
  if (sel.decoyIds.length < 2) return json<FitErrorResponse>({ error: "insufficient_catalog" }, 422);

  const tokens = newFitRequestTokens();
  const now = deps.now();
  const created = await deps.repository.createRequest({
    id,
    storeId: storeId ?? null,
    giverTokenHash: tokens.giverTokenHash,
    recipientTokenHash: tokens.recipientTokenHash,
    occasion: body.occasion,
    budgetMin: body.budgetMin ?? null,
    budgetMax: body.budgetMax,
    ...(body.metalLock ? { metalLock: [...body.metalLock] } : {}),
    currency: body.currency,
    shortlistIds: [...body.shortlistIds],
    decoyIds: sel.decoyIds,
    createdAt: now,
    expiresAt: fitRequestExpiresAt(now),
  });
  return json<CreateFitRequestResponse>(
    {
      fitRequestId: created.id,
      giverToken: tokens.giverToken,
      recipientPath: `/r/${tokens.recipientToken}`,
      giverReportPath: `/g/${tokens.giverToken}`,
      expiresAt: created.expiresAt.toISOString(),
      carouselSize: shortlist.length + sel.decoyIds.length,
    },
    201,
  );
}

// ------------------------------------------------------------------ POST /api/fit/report

/** Maps the stored request status to what the giver may know (a deleted request reads as expired). */
export function giverStatus(request: StoredFitRequest, now: Date): GiverReportStatus["status"] {
  if (request.status === "expired" || request.status === "deleted" || request.expiresAt.getTime() <= now.getTime()) return "expired";
  if (request.status === "completed") return "completed";
  if (request.status === "created") return "waiting";
  return "in_progress";
}

/** Label strings the giver may see (MASTER_PLAN §3.3 step 6): words only, never numbers. */
export function recipientLabels(profile: RecipientProfile | null): GiverReportStatus["recipientLabels"] {
  if (!profile) return undefined;
  const labels: NonNullable<GiverReportStatus["recipientLabels"]> = {};
  const { undertone, confidence, override } = effectiveUndertone(profile);
  const tone = capitalize(UNDERTONE_LABEL[undertone]);
  if (override) labels.undertone = `${tone} undertone (their choice)`;
  else if (confidence > 0) labels.undertone = `${tone} undertone estimate${confidence < FIT_PARAMS.lowConfidence ? " (low confidence)" : ""}`;
  if (profile.faceShape !== "Unknown") labels.faceShape = `${capitalize(FACE_SHAPE_LABEL[profile.faceShape])} face shape estimate`;
  return Object.keys(labels).length ? labels : undefined;
}

/** Hash of everything a report is computed from; a cached fit_reports row is reused only on a match. */
function reportFingerprint(request: StoredFitRequest): string {
  const material = JSON.stringify({ v: FIT_WEIGHTS_VERSION, input: request.input, decoys: request.decoyIds, profile: request.profile });
  return createHash("sha256").update(material).digest("hex");
}

/**
 * Sends a GiverReportStatus. The contract's `recipientLabels` keys (`undertone`, `faceShape`) are
 * also on lib/privacy's forbidden-key list; while the guard rejects them the (optional) labels are
 * dropped instead of failing the whole report. The same words still appear in the reasons.
 */
function reportJson(body: GiverReportStatus): Response {
  if (body.recipientLabels && findGiverLeaks({ recipientLabels: body.recipientLabels }).length > 0) {
    const rest: GiverReportStatus = { ...body };
    delete rest.recipientLabels;
    return json<GiverReportStatus>(rest);
  }
  return json<GiverReportStatus>(body);
}

/** Hearted designs as the metal they were hearted in (else their visible default), for look-alike credit. */
function heartedViews(designs: readonly CatalogSku[], profile: RecipientProfile, request: VariantRequest, cap?: number): CatalogSku[] {
  const hv = new Set(profile.heartedVariantIds ?? []);
  return designs.flatMap((d) => {
    const hearted = variantsOf(d).filter((v) => hv.has(v.variantId));
    const shown = hearted.length > 0 ? hearted : visibleVariants(d, request, cap).slice(0, 1);
    return shown.length > 0 ? shown.map((v) => variantView(d, v)) : [d];
  });
}

export async function handleReport(req: Request, deps: FitDeps): Promise<Response> {
  const headerToken = req.headers.get("x-giver-token");
  const parsed = ReportBody.safeParse(headerToken ? { giverToken: headerToken } : await readJson(req));
  if (!parsed.success) return json<FitErrorResponse>({ error: "bad_request" }, 400);

  const request = await deps.repository.findByGiverToken(parsed.data.giverToken);
  if (!request) return json<FitErrorResponse>({ error: "not_found" }, 404);
  const status = giverStatus(request, deps.now());
  const expiresAt = request.expiresAt.toISOString();
  if (status !== "completed") return reportJson({ status, expiresAt });
  if (!deps.rules) return json<FitErrorResponse>({ error: "fit_rules_not_configured" }, 503);

  const profile: RecipientProfile = request.profile ?? { undertoneEstimate: "neutral", undertoneConfidence: 0, faceShape: "Unknown", heartedSkuIds: [] };
  const fingerprint = reportFingerprint(request);
  const cached = await deps.repository.getReport(request.id);
  let results: FitResult[];
  if (cached && cached.fingerprint === fingerprint && Array.isArray(cached.items)) {
    results = cached.items as FitResult[];
  } else {
    const shortlist = await deps.repository.getSkus(request.input.shortlistIds);
    const decoys = await deps.repository.getSkus(request.decoyIds);
    const cap = swatchCap(shortlist, decoys, request.input);
    const hearted = heartedViews(await deps.repository.getSkus(profile.heartedSkuIds), profile, request.input, cap);
    const scored = scoreSkus(profile, shortlist, request.input, deps.rules, { heartedSkus: hearted, swatchCap: cap }).map((s) => ({
      ...s,
      category: shortlist.find((k) => k.id === s.skuId)!.category,
    }));
    const catalog = (await deps.repository.listCatalog(request.storeId)).map((s) => ({ id: s.id, title: s.title }));
    const explained = await explainFit(scored, { client: deps.explainer, catalog });
    results = explained.results;
    await deps.repository.saveReport(request.id, { fingerprint, items: results, weights: FIT_WEIGHTS, model: explained.model ?? null });
  }
  const hearts = new Set(profile.heartedSkuIds);
  const wishes = new Set(profile.wishOtherMetalSkuIds ?? []);
  const otherMetalWishes = request.input.shortlistIds.filter((id) => wishes.has(id));
  return reportJson({
    status,
    expiresAt,
    results,
    recipientLabels: recipientLabels(request.profile),
    // Hearts on the shortlist only: a hearted decoy is never revealed as a decoy.
    heartedShortlistIds: request.input.shortlistIds.filter((id) => hearts.has(id)),
    // Wishes on the shortlist only, like hearts.
    ...(otherMetalWishes.length > 0 ? { otherMetalWishes } : {}),
  });
}

// ------------------------------------------------------------------ POST /api/fit/decoys, GET /api/fit/weights

export async function handleDecoys(req: Request, deps: FitDeps): Promise<Response> {
  const parsed = DecoysBody.safeParse(await readJson(req));
  if (!parsed.success) return json<FitErrorResponse>({ error: "bad_request" }, 400);
  const ids = [...new Set(parsed.data.shortlistIds)];
  const shortlist = await deps.repository.getSkus(ids);
  if (shortlist.length !== ids.length) return json<FitErrorResponse>({ error: "unknown_sku" }, 404);
  const catalog = await deps.repository.listCatalog(shortlist[0].storeId);
  // Fresh random seed: this preview can never reproduce the decoys of a stored request.
  const sel = selectDecoys(shortlist, catalog, { seed: decoySeed(deps.decoySecret, randomUUID()) });
  return json<DecoysResponse>({ decoyIds: sel.decoyIds, carouselSize: shortlist.length + sel.decoyIds.length, ok: sel.ok, reasons: sel.reasons });
}

export function handleWeights(): Response {
  return json<FitWeightsResponse>({
    version: FIT_WEIGHTS_VERSION,
    weights: FIT_WEIGHTS,
    params: FIT_PARAMS,
    formula: FIT_FORMULA,
    returnRisk: { formula: RETURN_RISK_FORMULA, defaults: RETURN_RISK_DEFAULTS, label: RETURN_RISK_LABEL, sources: RETURN_RISK_SOURCES },
  });
}

/** Every route under app/api/fit, for A5's "no giver route leaks recipient data" enumeration test. */
export const GIVER_FIT_ROUTES = [
  { method: "POST", path: "/api/fit/requests", response: "CreateFitRequestResponse | FitErrorResponse" },
  { method: "POST", path: "/api/fit/report", response: "GiverReportStatus | FitErrorResponse" },
  { method: "POST", path: "/api/fit/decoys", response: "DecoysResponse | FitErrorResponse" },
  { method: "GET", path: "/api/fit/weights", response: "FitWeightsResponse" },
] as const;

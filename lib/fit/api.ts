/**
 * Handlers behind app/api/fit/* (route files stay thin; Next.js route modules may only export
 * HTTP methods and config). All routes are GIVER-FACING: responses carry only the explicit types
 * below (lib/contracts/api.ts for create and report), built field by field and sent through A5's
 * `giverJson`, so no recipient image, hex, CIELAB, face attribute or undertone number can reach
 * the giver (MASTER_PLAN v2 §4.4). Requests are stored only in lib/privacy (ADR-021).
 */
import { createHash, createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import { type CreateFitRequestResponse, GIFT_MODES, type GiverReportStatus, STYLE_FAMILIES } from "@/lib/contracts/api";
import { type CatalogSku, type FitResult, METALS, OCCASIONS, type RecipientProfile } from "@/lib/contracts/giftfit";
import { findGiverLeaks, giverJson } from "@/lib/privacy/giver-guard";
import { fitRequestExpiresAt, newFitRequestTokens } from "@/lib/privacy/tokens";
import { curate, inferGender } from "./curate";
import { type DecoyReasonCode, selectDecoys } from "./decoys";
import type { FitDeps } from "./deps";
import { explainFit } from "./explain";
import { FACE_SHAPE_LABEL, UNDERTONE_LABEL, capitalize } from "./labels";
import type { StoredBrief, StoredFitRequest } from "./repository";
import { RETURN_RISK_DEFAULTS, RETURN_RISK_FORMULA, RETURN_RISK_LABEL, RETURN_RISK_SOURCES, type ReturnRiskInputs } from "./returnRisk";
import { effectiveUndertone, scoreSkus } from "./score";
import { type HeartedDesign, type NotTriedPick, type TasteSummary, buildTasteInput, similarNotTried, tasteSummary } from "./taste";
import { type VariantRequest, defaultVariant, eligibleVariants, swatchCap, variantView, variantsOf, visibleVariants } from "./variants";
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
const CATEGORIES = ["earring", "necklace", "ring", "bracelet", "watch"] as const;
const GENDER_PRESENTATIONS = ["feminine", "masculine", "unisex"] as const;
const unique = (xs: readonly string[] | undefined) => !xs || new Set(xs).size === xs.length;
const isIdeas = (b: { mode?: string }) => (b.mode ?? "i_have_ideas") === "i_have_ideas";
const CreateBody = z
  .object({
    storeId: z.string().min(1).max(128).optional(),
    /** Absent = "i_have_ideas" (backward compatible, ADR-045). */
    mode: z.enum(GIFT_MODES).optional(),
    occasion: z.enum(OCCASIONS),
    budgetMin: z.number().finite().min(0).max(1_000_000).optional(),
    budgetMax: z.number().finite().min(0).max(1_000_000),
    metalLock: z.array(z.enum(METALS)).min(1).max(METALS.length).optional(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    /** "i_have_ideas": 1–4 designs. Ignored for "help_me_choose". */
    shortlistIds: z.array(z.string().min(1).max(128)).max(16).default([]),
    categories: z.array(z.enum(CATEGORIES)).max(CATEGORIES.length).optional(),
    styleHints: z.array(z.enum(STYLE_FAMILIES)).max(STYLE_FAMILIES.length).optional(),
    genderPresentation: z.enum(GENDER_PRESENTATIONS).optional(),
  })
  .refine((b) => b.budgetMax > 0 && b.budgetMax >= (b.budgetMin ?? 0), { message: "budgetMax must be > 0 and ≥ budgetMin" })
  .refine((b) => unique(b.metalLock), { message: "metalLock must be unique" })
  .refine((b) => !isIdeas(b) || (b.shortlistIds.length >= 1 && b.shortlistIds.length <= 4), { message: "shortlistIds must list 1–4 designs" })
  .refine((b) => !isIdeas(b) || unique(b.shortlistIds), { message: "shortlistIds must be unique" })
  .refine((b) => unique(b.categories) && unique(b.styleHints), { message: "categories and styleHints must be unique" });
type CreateInput = z.infer<typeof CreateBody>;

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
  if (body.mode === "help_me_choose") return createHelpMeChoose(body, deps);
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

  return storeRequest(deps, id, body, { mode: "i_have_ideas", storeId, shortlistIds: [...body.shortlistIds], decoyIds: sel.decoyIds });
}

/**
 * "Help me choose" (ADR-045): GiftFit curates 6–8 real candidates (lib/fit/curate.ts) within the cap,
 * lock, categories and gender presentation; no decoys. The curated designs are stored as the request's
 * shortlist, so the recipient flow is unchanged. Refuses (422 insufficient_catalog) below 4 designs.
 */
async function createHelpMeChoose(body: CreateInput, deps: FitDeps): Promise<Response> {
  const catalog = await deps.repository.listCatalog(body.storeId);
  const storeId = body.storeId ?? catalog[0]?.storeId;
  const pool = storeId ? catalog.filter((s) => s.storeId === storeId) : catalog;
  const id = randomUUID();
  const cur = curate(pool, {
    seed: decoySeed(deps.decoySecret, id),
    request: { budgetMax: body.budgetMax, currency: body.currency, metalLock: body.metalLock },
    occasion: body.occasion,
    categories: body.categories,
    styleHints: body.styleHints,
    genderPresentation: body.genderPresentation,
    rules: deps.rules,
  });
  if (!cur.ok) {
    return json<FitErrorResponse>({ error: "insufficient_catalog", message: "not enough designs within the budget cap, metal and categories" }, 422);
  }
  return storeRequest(deps, id, body, {
    mode: "help_me_choose",
    storeId,
    shortlistIds: cur.ids,
    decoyIds: [],
    ...(body.categories?.length ? { categories: [...body.categories] } : {}),
    ...(body.styleHints?.length ? { styleHints: [...body.styleHints] } : {}),
    ...(body.genderPresentation ? { genderPresentation: body.genderPresentation } : {}),
  });
}

/** Mints the tokens (only their SHA-256 hashes are stored, in lib/privacy) and stores the request with the 72 h expiry. */
async function storeRequest(
  deps: FitDeps,
  id: string,
  body: CreateInput,
  shape: StoredBrief & { storeId?: string; shortlistIds: string[]; decoyIds: string[] },
): Promise<Response> {
  const tokens = newFitRequestTokens();
  const now = deps.now();
  const created = await deps.repository.createRequest({
    id,
    storeId: shape.storeId ?? null,
    giverTokenHash: tokens.giverTokenHash,
    recipientTokenHash: tokens.recipientTokenHash,
    occasion: body.occasion,
    budgetMin: body.budgetMin ?? null,
    budgetMax: body.budgetMax,
    ...(body.metalLock ? { metalLock: [...body.metalLock] } : {}),
    currency: body.currency,
    shortlistIds: shape.shortlistIds,
    decoyIds: shape.decoyIds,
    mode: shape.mode,
    ...(shape.categories ? { categories: shape.categories } : {}),
    ...(shape.styleHints ? { styleHints: shape.styleHints } : {}),
    ...(shape.genderPresentation ? { genderPresentation: shape.genderPresentation } : {}),
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
      carouselSize: shape.shortlistIds.length + shape.decoyIds.length,
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
  const material = JSON.stringify({ v: FIT_WEIGHTS_VERSION, input: request.input, decoys: request.decoyIds, profile: request.profile, brief: request.brief ?? null });
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

/** "help_me_choose" report extras, cached with the results (fit_reports) so Claude runs once per report. */
interface HelpExtras {
  tasteSummary: TasteSummary;
  similarNotTried: NotTriedPick[];
}

function isHelpExtras(x: unknown): x is HelpExtras {
  const e = x as HelpExtras | undefined;
  return Boolean(e && typeof e.tasteSummary?.text === "string" && Array.isArray(e.similarNotTried));
}

/** Hearted curated designs in the metal they were hearted in (else their default eligible metal). */
function heartedDesigns(designs: readonly CatalogSku[], profile: RecipientProfile, request: VariantRequest): HeartedDesign[] {
  const hearts = new Set(profile.heartedSkuIds);
  const hv = new Set(profile.heartedVariantIds ?? []);
  return designs
    .filter((d) => hearts.has(d.id))
    .map((d) => {
      const v = variantsOf(d).find((x) => hv.has(x.variantId)) ?? defaultVariant(d, request) ?? variantsOf(d)[0];
      return { sku: d, metal: v.metal };
    });
}

/**
 * Taste summary (Claude or template) and 2–3 "not tried on" designs, from the hearts on the curated
 * set. Inputs are catalog attributes and counts only (lib/fit/taste.ts).
 */
async function helpExtras(request: StoredFitRequest, brief: StoredBrief, profile: RecipientProfile, shown: readonly CatalogSku[], deps: FitDeps): Promise<{ extras: HelpExtras; model?: string }> {
  const hearted = heartedDesigns(shown, profile, request.input);
  const wished = shown.filter((d) => (profile.wishOtherMetalSkuIds ?? []).includes(d.id)).length;
  const catalog = await deps.repository.listCatalog(request.storeId);
  const refs = catalog.map((s) => ({ id: s.id, title: s.title }));
  const taste = await tasteSummary(buildTasteInput(hearted, shown.length, wished), { client: deps.taster ?? null, catalog: refs });
  const similar = similarNotTried(catalog, hearted, {
    request: request.input,
    shownIds: shown.map((s) => s.id),
    // The brief's presentation; rows without one (Drizzle) infer it from the curated set.
    genderPresentation: brief.genderPresentation ?? inferGender(shown),
    seed: decoySeed(deps.decoySecret, request.id),
  });
  return { extras: { tasteSummary: taste.summary, similarNotTried: similar }, model: taste.summary.source === "claude" ? taste.model : undefined };
}

export async function handleReport(req: Request, deps: FitDeps): Promise<Response> {
  const headerToken = req.headers.get("x-giver-token");
  const parsed = ReportBody.safeParse(headerToken ? { giverToken: headerToken } : await readJson(req));
  if (!parsed.success) return json<FitErrorResponse>({ error: "bad_request" }, 400);

  const request = await deps.repository.findByGiverToken(parsed.data.giverToken);
  if (!request) return json<FitErrorResponse>({ error: "not_found" }, 404);
  const brief: StoredBrief = request.brief ?? { mode: "i_have_ideas" };
  const meta: Pick<GiverReportStatus, "mode" | "demo"> = { mode: brief.mode, ...(request.demo ? { demo: true } : {}) };
  const status = giverStatus(request, deps.now());
  const expiresAt = request.expiresAt.toISOString();
  if (status !== "completed") return reportJson({ status, expiresAt, ...meta });
  if (!deps.rules) return json<FitErrorResponse>({ error: "fit_rules_not_configured" }, 503);

  const profile: RecipientProfile = request.profile ?? { undertoneEstimate: "neutral", undertoneConfidence: 0, faceShape: "Unknown", heartedSkuIds: [] };
  const fingerprint = reportFingerprint(request);
  const cached = await deps.repository.getReport(request.id);
  const help = brief.mode === "help_me_choose";
  let results: FitResult[];
  let extras: HelpExtras | undefined;
  if (cached && cached.fingerprint === fingerprint && Array.isArray(cached.items) && (!help || isHelpExtras(cached.extras))) {
    results = cached.items as FitResult[];
    if (help) extras = cached.extras as HelpExtras;
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
    const [explained, extra] = await Promise.all([explainFit(scored, { client: deps.explainer, catalog }), help ? helpExtras(request, brief, profile, shortlist, deps) : undefined]);
    results = explained.results;
    extras = extra?.extras;
    await deps.repository.saveReport(request.id, {
      fingerprint,
      items: results,
      weights: FIT_WEIGHTS,
      model: explained.model ?? extra?.model ?? null,
      ...(extras ? { extras } : {}),
    });
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
    ...meta,
    ...(extras ? { tasteSummary: extras.tasteSummary, ...(extras.similarNotTried.length > 0 ? { similarNotTried: extras.similarNotTried } : {}) } : {}),
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

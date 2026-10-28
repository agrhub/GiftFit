/**
 * Who gets a try-on, decided per recipient call (A16). The giver's link alone never decides it: the
 * recipient session, capture and swatch routes each ask `requestTryOn(deps, request, req)`.
 *
 *   mode "live"  the owner's recording session (gf_rec cookie, YOUCAM_RECORDING=on): the capture ports carry a
 *                paid grant. With YOUCAM_MOCK=1 the same path runs on fixtures (0 units, the rehearsal).
 *   mode "mock"  YOUCAM_MOCK=1 with the switch off: everyone gets fixture try-ons (local dev, CI). 0 units.
 *   mode "off"   everyone else, i.e. every public visitor in production: no selfie, hearts-only, with copy
 *                that says why ("demo_mode" on the demo store, "preview_off" on a store-URL preview).
 *   mode "demo"  the seeded judge demo: pre-recorded fixture try-ons of an AI-generated model.
 * Per piece: a store-URL preview product whose photo can't be used (attributes.tryon_eligible === false) is
 * never rendered; a preview with no usable photo at all is "off" with note "no_eligible".
 *
 * | env                                   | public recipient | owner recipient          |
 * |---------------------------------------|------------------|--------------------------|
 * | YOUCAM_MOCK=0, recording off (prod)   | off              | off                      |
 * | YOUCAM_MOCK=0, YOUCAM_RECORDING=on    | off              | live (paid, capped)      |
 * | YOUCAM_MOCK=1, recording off          | mock             | mock                     |
 * | YOUCAM_MOCK=1, YOUCAM_RECORDING=on    | off              | live on fixtures (0 units)|
 */
import type { CatalogSku } from "@/lib/contracts/giftfit";
import type { Env } from "@/lib/store/config";
import { loadYoucamConfig } from "@/lib/youcam/config";
import { isOwnerRecording, mintPaidGrant, paidReadiness, recordingSwitchOn, type HeaderSource, type PaidGrant } from "@/lib/youcam/recording";
import { isPreviewStoreId } from "@/lib/widget/preview-key";
import type { PrivacyDeps } from "./deps";
import type { FitRequestRecord } from "./repos/types";

export type TryOnMode = "live" | "mock" | "off";
/** Why a recipient gets no try-on (drives the copy). */
export type TryOnNote = "demo_mode" | "preview_off" | "no_eligible";

export interface TryOnAccess {
  mode: TryOnMode | "demo";
  /** The call carries a valid owner-recording cookie (switch on). */
  owner: boolean;
  note?: TryOnNote;
}

/** A piece a try-on may render: anything but a preview product whose photo failed the checks. */
export const isTryOnEligible = (sku: Pick<CatalogSku, "attributes">) => sku.attributes.tryon_eligible !== false;

/** The table in the header, before per-request details. */
export function baseTryOnMode(args: { youcamMode: "mock" | "real"; owner: boolean; env?: Env; paidReady?: boolean }): TryOnMode {
  const env = args.env ?? process.env;
  if (recordingSwitchOn(env)) {
    if (!args.owner) return "off";
    return args.youcamMode === "mock" || (args.paidReady ?? paidReadiness(env).youcamPaid) ? "live" : "off";
  }
  return args.youcamMode === "mock" ? "mock" : "off";
}

/**
 * Giver-side copy before a request exists (widget brief, Concierge, create response): would a recipient opening a
 * gift from this browser be offered a try-on? Reads the YouCam mode from the environment (no client is built).
 */
export function tryOnOfferedTo(req?: HeaderSource, env: Env = process.env): boolean {
  try {
    const youcamMode = loadYoucamConfig(env).mock ? "mock" : "real";
    return baseTryOnMode({ youcamMode, owner: req ? isOwnerRecording(req, env) : false, env }) !== "off";
  } catch {
    return false;
  }
}

type Deps = Pick<PrivacyDeps, "repos"> & Partial<Pick<PrivacyDeps, "youcamMode" | "youcamPaidReady">>;

/**
 * The try-on access of one recipient call. `skus` are the request's pieces when the caller already resolved
 * them (to tell "no eligible piece" apart); `req` carries the owner cookie (absent = public).
 */
export async function requestTryOn(
  deps: Deps,
  request: FitRequestRecord,
  req?: HeaderSource,
  opts: { skus?: readonly Pick<CatalogSku, "attributes">[]; env?: Env } = {},
): Promise<TryOnAccess> {
  const env = opts.env ?? process.env;
  const owner = req ? isOwnerRecording(req, env) : false;
  const demo = request.demo || (await deps.repos.tryons.listForRequest(request.id)).some((r) => r.resultRef?.startsWith("fixture:"));
  if (demo) return { mode: "demo", owner };
  const preview = isPreviewStoreId(request.storeId);
  const mode = baseTryOnMode({ youcamMode: deps.youcamMode?.() ?? "mock", owner, env, paidReady: deps.youcamPaidReady?.() });
  if (mode === "off") return { mode, owner, note: preview ? "preview_off" : "demo_mode" };
  if (preview && opts.skus && !opts.skus.some(isTryOnEligible)) return { mode: "off", owner, note: "no_eligible" };
  return { mode, owner };
}

/**
 * Giver-side copy (e-card, share text): will this gift offer a try-on to a recipient opening it from the same kind of
 * browser as `req` (the giver's)? Public production: no. Unknown pieces count as not triable only for previews.
 */
export async function giftOffersTryOn(deps: Pick<PrivacyDeps, "catalog"> & Partial<Pick<PrivacyDeps, "youcamMode">>, request: FitRequestRecord, req?: HeaderSource, env: Env = process.env): Promise<boolean> {
  const youcamMode = deps.youcamMode?.() ?? "mock";
  if (baseTryOnMode({ youcamMode, owner: req ? isOwnerRecording(req, env) : false, env }) === "off") return false;
  if (!isPreviewStoreId(request.storeId)) return true;
  const skus = await deps.catalog.getSkus([...request.shortlistIds, ...request.decoyIds]).catch(() => []);
  return skus.some(isTryOnEligible);
}

/** The paid grant for a "live" call (undefined in mock mode or when the deployment is not paid-ready). */
export function grantFor(access: TryOnAccess, req: HeaderSource, env: Env = process.env): PaidGrant | undefined {
  return access.mode === "live" ? mintPaidGrant(req, env) : undefined;
}

/**
 * GiftFit HTTP contract for P3 (owner: R0, ADR-021). Types only. A4's UI codes against these;
 * route owners implement them exactly. Every giver response goes through `giverJson`
 * (lib/privacy); every route is registered in lib/privacy/route-manifest.ts.
 *
 * Auth
 *   - Giver: the giver token is in the report URL (/g/[giverToken]) and is sent in the JSON body
 *     (`giverToken`). It never opens a recipient route.
 *   - Recipient: the recipient token is in the link (/r/[recipientToken]); API calls send
 *     `Authorization: Bearer <recipientToken>`. POST /api/recipient/session also sets the HttpOnly
 *     `gf_recipient` cookie so <img src> of signed try-on URLs works.
 *
 * Single store (ADR-021): lib/privacy `PrivacyRepos` is the system of record for fit requests,
 * profiles, try-ons, hearts and reports. lib/fit reads it through an adapter, never a second copy.
 */
import type { FitResult, JewelryCategory, Metal, Occasion, Undertone } from "./giftfit";

export interface ApiError {
  error: string;
  message?: string;
}

// ---------------------------------------------------------------------------------------------
// Giver (owner A3, app/api/fit/*)
// ---------------------------------------------------------------------------------------------

/** POST /api/fit/requests — create a Fit Request. Decoys are chosen server-side and never returned. */
/**
 * Giver modes (ADR-045). "help_me_choose" (default): GiftFit curates 6–8 informative, real candidates
 * within budget and lock; no decoys. "i_have_ideas": the giver's 1–4 picks plus decoys (the original mode).
 */
export const GIFT_MODES = ["help_me_choose", "i_have_ideas"] as const;
export type GiftMode = (typeof GIFT_MODES)[number];

/** Style families in the catalog (`attributes.style`). */
export const STYLE_FAMILIES = ["classic", "minimal", "statement", "modern", "boho", "vintage", "sport"] as const;
export type StyleFamily = (typeof STYLE_FAMILIES)[number];

/**
 * The structured gift brief (ADR-045/040). The Giver Panel form and the Gift Concierge both produce
 * exactly this; the Concierge never creates a request without the giver confirming it.
 */
export interface GiftBrief {
  mode: GiftMode;
  occasion: Occasion;
  budgetMax: number;
  currency: string;
  /** Categories to draw from; empty/absent = all. */
  categories?: JewelryCategory[];
  metalLock?: Metal[];
  /** Optional hints, e.g. ["minimal"]; they bias coverage, never exclude. */
  styleHints?: StyleFamily[];
  /** From hints or the occasion; decoys/curation respect it. Absent = any. */
  genderPresentation?: "feminine" | "masculine" | "unisex";
  /** "i_have_ideas" only: 1–4 catalog ids. */
  shortlistIds?: string[];
}

export interface CreateFitRequestBody {
  storeId?: string;
  /** Absent = "i_have_ideas" for backward compatibility with existing clients and tests. */
  mode?: GiftMode;
  occasion: Occasion;
  /** Optional floor (legacy). */
  budgetMin?: number;
  /** Cap: only variants priced ≤ budgetMax (and within metalLock) reach the recipient (ADR-032). */
  budgetMax: number;
  /** Optional metal lock, e.g. ["yellow_gold", "rose_gold"]. */
  metalLock?: Metal[];
  currency: string;
  /** "i_have_ideas": 1–4 catalog ids the giver picked. Ignored (may be empty) for "help_me_choose". */
  shortlistIds: string[];
  /** "help_me_choose" inputs (ADR-045). */
  categories?: JewelryCategory[];
  styleHints?: StyleFamily[];
  genderPresentation?: "feminine" | "masculine" | "unisex";
}
export interface CreateFitRequestResponse {
  fitRequestId: string;
  /** Secret; shown to the giver once, stored only as a SHA-256 hash. */
  giverToken: string;
  /** Path the giver shares: /r/<recipientToken>. */
  recipientPath: string;
  /** Path of the giver's report: /g/<giverToken>. */
  giverReportPath: string;
  expiresAt: string;
  /** Always 6 when the catalog allows (shortlist + decoys). */
  carouselSize: number;
}

/** POST /api/fit/report — existing route (body `{ giverToken }`), response unchanged. */
export interface GiverReportStatus {
  status: "waiting" | "in_progress" | "completed" | "expired";
  expiresAt: string;
  /** Present once the recipient finished. Scores, breakdown and reasons only. */
  results?: FitResult[];
  /** Labels the giver may see, e.g. "Warm undertone estimate". Never hex, LAB or photos. */
  recipientLabels?: { undertone?: string; faceShape?: string };
  heartedShortlistIds?: string[];
  /** Shortlist designs the recipient wished came in another metal (ADR-032). */
  otherMetalWishes?: string[];
  /** Which mode created the request (ADR-045). */
  mode?: GiftMode;
  /** Seeded judge demo (AI-generated model), never a real request. */
  demo?: boolean;
  /**
   * "help_me_choose": a short taste summary built from the hearts (style family, metal, silhouette).
   * Claude-written when the key is present, else the template; `source` says which.
   */
  tasteSummary?: { text: string; source: "claude" | "template" };
  /** 2–3 catalog designs the recipient did NOT see, matching the taste. The giver may buy these. */
  similarNotTried?: Array<{ catalogId: string; variantId?: string; price: number; currency: string; label: "not tried on" }>;
}

// ---------------------------------------------------------------------------------------------
// Recipient (owner A5, app/api/recipient/*)
// ---------------------------------------------------------------------------------------------

export interface CarouselItem {
  /** Opaque per-request item id (not the catalog id), so the order and ids leak nothing. */
  itemId: string;
  title: string;
  category: JewelryCategory;
  /** Public product image (catalog) of the default metal, not a try-on. Recipients never see prices (ADR-032). */
  productImage: string;
  /** Ring, bracelet and watch need the back-of-hand photo. */
  needsHandPhoto: boolean;
  /**
   * Eligible metal variants of this design (within the giver's cap and lock), never with prices
   * (ADR-032). Always present (≥ 1); decoys carry swatches in the same shape, leveled in count.
   */
  swatches: Array<{
    /** Opaque per-request id (not the catalog variant id). */
    swatchId: string;
    /** e.g. "Yellow gold", "Sterling silver". */
    metalLabel: string;
    /** Product metal color for the swatch chip (not a face color). */
    swatchColor: string;
    /** Rendered first: best tone match to the low-confidence estimate, else the giver's first pick. */
    isDefault: boolean;
  }>;
}

/** POST /api/recipient/session — open the link (Bearer recipient token). Sets the gf_recipient cookie. */
export interface RecipientSessionResponse {
  status: "awaiting_consent" | "awaiting_capture" | "trying_on" | "completed" | "expired";
  occasion: Occasion | null;
  expiresAt: string;
  /** 6 items, shuffled per request; shortlist and decoys are indistinguishable. */
  items: CarouselItem[];
  /** Seeded judge demo: the recipient is an AI-generated model; show an "AI-generated model, demo" badge. */
  demo?: boolean;
}

/** POST /api/recipient/consent — body `{ accepted: true }` → RecipientSessionResponse. */
export interface ConsentBody {
  accepted: true;
}

/**
 * POST /api/recipient/capture — multipart/form-data: `selfie` (required, jpeg/png ≤ 10 MB),
 * `hand` (optional). Runs analysis + try-ons (YOUCAM_MOCK=1 in dev), deletes the photos in
 * `finally`, and returns the recipient-only view.
 */
export interface CaptureResponse {
  tryons: Array<{
    itemId: string;
    /** The default swatch rendered at capture time. */
    swatchId?: string;
    status: "ready" | "failed" | "skipped_needs_hand";
    /** Short-lived signed URL, recipient session only. */
    imageUrl?: string;
    failureReason?: string;
  }>;
  undertone: { estimate: Undertone; confidence: number; override: Undertone | null; label: string };
  faceShapeLabel: string;
  /** Seconds spent on analysis + try-ons (for the "< 45 s" number in the video). */
  processingSeconds: number;
  /** Seeded judge demo (pre-captured fixture try-ons of an AI-generated model). */
  demo?: boolean;
}

/**
 * GET /api/recipient/capture — the same `CaptureResponse` for an already-captured session, with
 * freshly signed image URLs (recipient reloads the page). 404 `not_captured` before capture.
 * Added in P3 integration (ADR-023).
 */

/**
 * POST /api/recipient/swatch — body `{ itemId, swatchId }`: renders that metal variant lazily
 * (1 unit, cached by image + variant), capped at ~4 extra renders per request (ADR-032).
 */
export interface SwatchBody {
  itemId: string;
  swatchId: string;
}
export interface SwatchResponse {
  status: "ready" | "failed" | "cap_reached" | "skipped_needs_hand";
  imageUrl?: string;
  failureReason?: string;
  /** Extra renders left for this request. */
  rendersLeft: number;
}

/**
 * POST /api/recipient/hearts — replaces the set. Hearts attach to a specific metal variant
 * (ADR-032): `{ hearts: [{ itemId, swatchId }] }`. Legacy `{ itemIds }` hearts the default swatch.
 */
export interface HeartsBody {
  hearts?: Array<{ itemId: string; swatchId: string }>;
  /** @deprecated use `hearts`. */
  itemIds?: string[];
}

/** POST /api/recipient/wish-metal — body `{ itemId }`: "Love the style, wish it came in another metal". No render. */
export interface WishMetalBody {
  itemId: string;
}

/**
 * POST /api/recipient/delete-photo — "Delete my photo now" (ADR-036, clarified): deletes **every image
 * derived from the recipient's face**, immediately, at any point in the flow: the selfie, the hand photo,
 * all try-on renders (blob, result cache, YouCam tasks; their signed URLs return 404 afterwards). Hearts,
 * metal wishes and the numeric profile stay until Done or expiry. The carousel then shows product photos
 * with hearts intact; further metal renders are off (`/swatch` returns `failed` / `photo_deleted`).
 */
export interface DeletePhotoResponse {
  photoDeleted: true;
  /** Extra metal renders still possible: always 0 after this call. */
  rendersLeft: 0;
}

/** POST /api/recipient/done — finish; photos already gone; returns the closing screen data. */
export interface DoneResponse {
  photosDeleted: true;
  photosStored: 0;
  completedAt: string;
}

// Existing A5 routes kept as-is: GET /api/recipient/tryons, GET /api/recipient/tryon/[id],
// GET|POST /api/recipient/undertone, POST /api/recipient/delete, GET /api/recipient/purge-expired.

// ---------------------------------------------------------------------------------------------
// Seeded judge demo (owner A5, app/api/demo/*; MASTER_PLAN §8, ADR-030/037)
// ---------------------------------------------------------------------------------------------

/** Showcase AI-generated models with committed fixtures (fixtures/youcam/ai-demo/showcase). */
export type DemoSubject = "showcase-latina-medium-warm" | "showcase-black-deep-warm" | "showcase-man-lightmed-neutral";

/** POST /api/demo/seed — body `{ subject? }` (default the hero). Creates a fresh demo Fit Request; 0 units. */
export interface DemoSeedBody {
  subject?: DemoSubject;
}
export interface DemoSeedResponse {
  /** /r/<recipientToken>: opens on the carousel (consent and capture are pre-done). */
  recipientPath: string;
  /** /g/<giverToken>. */
  giverReportPath: string;
  expiresAt: string;
  subject: DemoSubject;
  label: "AI-generated model";
}

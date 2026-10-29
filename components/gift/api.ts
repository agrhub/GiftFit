/**
 * Typed client for the GiftFit HTTP contract (lib/contracts/api.ts, ADR-021). Owner: A4.
 * UI code talks to a `GiftApi`; the default is `httpGiftApi`. Components accept an `api` prop so
 * tests (and the opt-in UI mock, NEXT_PUBLIC_GIFTFIT_UI_MOCK=1) can swap it.
 *
 * Routes that have not landed yet answer Next's HTML 404; that surfaces as `ApiError.routeMissing`
 * so pages can say "not available yet" instead of "link not found".
 */
import type {
  CaptureResponse,
  CreateFitRequestBody,
  CreateFitRequestResponse,
  DeletePhotoResponse,
  DemoSeedResponse,
  DemoSubject,
  DoneResponse,
  GiftMode,
  GiverReportStatus,
  HeartsBody,
  RecipientSessionResponse,
  SwatchResponse,
} from "@/lib/contracts/api";
import type { FitResult, Undertone } from "@/lib/contracts/giftfit";
import { type Locale, normalizeLocale } from "@/lib/i18n";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
    /** The route itself is not deployed (HTML 404), as opposed to a JSON "not found". */
    readonly routeMissing = false,
    /** Seconds from a `Retry-After` header (429). */
    readonly retryAfter?: number,
  ) {
    super(message ?? code);
    this.name = "ApiError";
  }
}

/** What the giver's report page renders (GiverReportStatus, defaulted). */
export interface GiverReportView {
  state: "waiting" | "in_progress" | "completed" | "expired";
  expiresAt?: string;
  results: FitResult[];
  labels: { undertone?: string; faceShape?: string };
  /** Catalog ids of shortlist pieces the recipient hearted. */
  heartedIds: string[];
  /** Shortlist designs the recipient wished came in another metal (ADR-032). */
  otherMetalWishes: string[];
  /** Seeded judge demo request (AI-generated model). */
  demo: boolean;
  /** How the request was made (ADR-045); older servers omit it = "i_have_ideas". */
  mode: GiftMode;
  /** "help_me_choose": what their hearts say (Claude or template). */
  tasteSummary?: GiverReportStatus["tasteSummary"];
  /** "help_me_choose": 2–3 similar designs they did not see, labelled "not tried on". */
  similarNotTried: NonNullable<GiverReportStatus["similarNotTried"]>;
  /** Store-URL preview requests (ADR-055): frozen names, prices, images and merchant links. */
  products: NonNullable<GiverReportStatus["products"]>;
  /** The store preview behind the request is gone. */
  previewExpired: boolean;
  /** false when no try-on happened (store previews, or no photo): no estimates, no try-on wording. */
  tryOn: boolean;
  /** A store-URL preview's display name (absent = the Aurum demo store). */
  storeName?: string;
  /** The report's UI locale (GiverReportStatus.lang); absent on older servers = the page's own. */
  lang?: Locale;
}

/** A heart on one design; `swatchId` is the metal shown (absent only for swatch-less items). */
export interface HeartChoice {
  itemId: string;
  swatchId?: string;
}

/** `{ hearts }` when every heart names its swatch, else the legacy `{ itemIds }` (default swatch). */
export function heartsBody(hearts: readonly HeartChoice[]): HeartsBody {
  if (hearts.every((h) => h.swatchId))
    return {
      hearts: hearts.map((h) => ({ itemId: h.itemId, swatchId: h.swatchId! })),
    };
  return { itemIds: [...new Set(hearts.map((h) => h.itemId))] };
}

export interface GiftApi {
  createFitRequest(
    body: CreateFitRequestBody,
  ): Promise<CreateFitRequestResponse>;
  giverReport(giverToken: string): Promise<GiverReportView>;
  openSession(token: string): Promise<RecipientSessionResponse>;
  consent(token: string): Promise<RecipientSessionResponse>;
  capture(
    token: string,
    photos: { selfie: Blob; hand?: Blob | null },
  ): Promise<CaptureResponse>;
  /** GET /api/recipient/capture: the earlier capture with fresh signed URLs; null before capture (404 not_captured). */
  resumeCapture(token: string): Promise<CaptureResponse | null>;
  /** Replaces the hearted set. Each heart is the variant shown when it was tapped (ADR-032). */
  saveHearts(token: string, hearts: HeartChoice[]): Promise<void>;
  /** POST /api/recipient/swatch: render another metal of a design (lazy, capped). */
  trySwatch(
    token: string,
    itemId: string,
    swatchId: string,
  ): Promise<SwatchResponse>;
  /** POST /api/recipient/wish-metal: "Love the style, wish it came in another metal". */
  wishMetal(token: string, itemId: string): Promise<void>;
  /** POST /api/recipient/delete-photo: delete the kept selfie (and hand photo) now (ADR-036). */
  deletePhoto(token: string): Promise<DeletePhotoResponse>;
  finish(token: string): Promise<DoneResponse>;
  /** Undertone override; null = use the estimate. */
  setUndertone(token: string, value: Undertone | null): Promise<void>;
  /** True when this API is the in-browser UI mock (shown as a banner). */
  readonly isMock?: boolean;
}

async function request<T>(
  path: string,
  init: RequestInit & { bearer?: string } = {},
): Promise<T> {
  const { bearer, headers, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: "same-origin",
      cache: "no-store",
      ...rest,
      headers: {
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...(headers as Record<string, string> | undefined),
      },
    });
  } catch {
    throw new ApiError(
      0,
      "network",
      "We couldn't reach GiftFit. Check your connection and try again.",
    );
  }
  const type = res.headers.get("content-type") ?? "";
  const isJson = type.includes("json");
  const body = isJson
    ? ((await res.json().catch(() => null)) as unknown)
    : null;
  if (!res.ok) {
    const err = (body ?? {}) as { error?: string; message?: string };
    throw new ApiError(
      res.status,
      err.error ?? `http_${res.status}`,
      err.message,
      res.status === 404 && !isJson,
      Number(res.headers.get("retry-after")) || undefined,
    );
  }
  return body as T;
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/** GiverReportStatus (lib/contracts/api.ts) → the page's view model. */
export function normalizeReport(raw: GiverReportStatus): GiverReportView {
  const results = raw.results ?? [];
  const state: GiverReportView["state"] = [
    "waiting",
    "in_progress",
    "completed",
    "expired",
  ].includes(raw.status)
    ? raw.status
    : "waiting";
  const wished = new Set([
    ...(raw.otherMetalWishes ?? []),
    ...results.filter((r) => r.wishOtherMetal).map((r) => r.skuId),
  ]);
  return {
    state,
    expiresAt: raw.expiresAt,
    results,
    labels: raw.recipientLabels ?? {},
    heartedIds: raw.heartedShortlistIds ?? [],
    otherMetalWishes: [...wished],
    demo: raw.demo === true,
    mode: raw.mode === "help_me_choose" ? "help_me_choose" : "i_have_ideas",
    ...(raw.tasteSummary?.text
      ? {
          tasteSummary: {
            text: raw.tasteSummary.text,
            source:
              raw.tasteSummary.source === "claude" ? "claude" : "template",
          },
        }
      : {}),
    similarNotTried: (raw.similarNotTried ?? []).filter(
      (p) => typeof p?.catalogId === "string",
    ),
    products: (raw.products ?? []).filter(
      (p) => typeof p?.catalogId === "string" && typeof p?.title === "string",
    ),
    previewExpired: raw.previewExpired === true,
    tryOn: raw.tryOn !== false,
    ...(typeof raw.storeName === "string" && raw.storeName
      ? { storeName: raw.storeName }
      : {}),
    ...(normalizeLocale(raw.lang) ? { lang: normalizeLocale(raw.lang) } : {}),
  };
}

/** POST /api/demo/seed: a fresh seeded judge demo (pre-recorded try-ons of an AI-generated model, 0 units). */
export function seedJudgeDemo(
  subject?: DemoSubject,
): Promise<DemoSeedResponse> {
  return request<DemoSeedResponse>(
    "/api/demo/seed",
    json(subject ? { subject } : {}),
  );
}

export const httpGiftApi: GiftApi = {
  createFitRequest: (body) =>
    request<CreateFitRequestResponse>("/api/fit/requests", json(body)),
  giverReport: async (giverToken) =>
    normalizeReport(
      await request<GiverReportStatus>("/api/fit/report", json({ giverToken })),
    ),
  openSession: (token) =>
    request<RecipientSessionResponse>("/api/recipient/session", {
      method: "POST",
      bearer: token,
    }),
  consent: (token) =>
    request<RecipientSessionResponse>("/api/recipient/consent", {
      ...json({ accepted: true }),
      bearer: token,
    }),
  capture: (token, { selfie, hand }) => {
    const form = new FormData();
    form.append("selfie", selfie, "selfie.jpg");
    if (hand) form.append("hand", hand, "hand.jpg");
    return request<CaptureResponse>("/api/recipient/capture", {
      method: "POST",
      body: form,
      bearer: token,
    });
  },
  resumeCapture: async (token) => {
    try {
      return await request<CaptureResponse>("/api/recipient/capture", {
        method: "GET",
        bearer: token,
      });
    } catch (err) {
      if (
        err instanceof ApiError &&
        err.status === 404 &&
        err.code === "not_captured"
      )
        return null;
      throw err;
    }
  },
  saveHearts: async (token, hearts) => {
    await request<unknown>("/api/recipient/hearts", {
      ...json(heartsBody(hearts)),
      bearer: token,
    });
  },
  trySwatch: (token, itemId, swatchId) =>
    request<SwatchResponse>("/api/recipient/swatch", {
      ...json({ itemId, swatchId }),
      bearer: token,
    }),
  deletePhoto: (token) =>
    request<DeletePhotoResponse>("/api/recipient/delete-photo", {
      method: "POST",
      bearer: token,
    }),
  wishMetal: async (token, itemId) => {
    await request<unknown>("/api/recipient/wish-metal", {
      ...json({ itemId }),
      bearer: token,
    });
  },
  finish: (token) =>
    request<DoneResponse>("/api/recipient/done", {
      method: "POST",
      bearer: token,
    }),
  setUndertone: async (token, value) => {
    await request<unknown>("/api/recipient/undertone", {
      ...json({ undertone: value }),
      bearer: token,
    });
  },
};

/** The UI mock is opt-in at build time and never the default. */
export const UI_MOCK = process.env.NEXT_PUBLIC_GIFTFIT_UI_MOCK === "1";

let cached: Promise<GiftApi> | null = null;
export function loadGiftApi(): Promise<GiftApi> {
  if (!UI_MOCK) return Promise.resolve(httpGiftApi);
  cached ??= import("./mockApi").then((m) => m.mockGiftApi);
  return cached;
}

export function friendlyError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.routeMissing)
      return "This part of GiftFit isn't available yet. Please try again shortly.";
    if (err.status === 0) return err.message;
    if (err.status === 410) return "This link has expired.";
    if (err.status === 413)
      return "That photo is too large. Please use one under 10 MB.";
    if (err.status === 429)
      return "Too many tries in a short time. Please wait a minute and try again.";
    if (err.message && err.message !== err.code) return err.message;
    return "Something went wrong on our side. Please try again.";
  }
  return "Something went wrong. Please try again.";
}

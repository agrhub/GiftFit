/**
 * Route-audience manifest (owner: A5). Every app/api route file must be listed here with who
 * calls it. server/privacy/__tests__/route-manifest.test.ts globs app/api/** /route.ts and fails
 * when a route is missing, and checks every `giver` route:
 *   - its source sends JSON through giverJson()/assertGiverSafe() (server/privacy/giver-guard.ts);
 *   - its source does not touch recipient imagery or raw analysis (resultRef, PhotoStore,
 *     signTryOnUrl, skin_color, analyzeRecipient, ...);
 *   - its declared sample responses (if any) pass assertGiverSafe.
 *
 * Adding a route? Add a line here in the same change. Owners: A3 app/api/fit/*, A10
 * app/api/ingest/*, A1 app/api/youcam/*, A5 app/api/recipient/*, A6 retailer routes.
 */

export type RouteAudience = "giver" | "recipient" | "retailer" | "internal";

export interface RouteManifestEntry {
  audience: RouteAudience;
  owner: string;
  description: string;
  /** Giver catalog routes may return product images (never recipient images). */
  allowsProductImages?: boolean;
  /**
   * Repo-relative module exporting `giverResponseSamples: unknown[]`: representative giver
   * responses (built from a recipient with full hex/face data), checked by the manifest test.
   */
  samplesModule?: string;
  /**
   * Set while a giver route still sends JSON without giverJson(): the static guard check is
   * reported instead of failing. The forbidden-identifier scan and the dynamic probe
   * (server/privacy/__tests__/giver-routes.probe.test.ts) still apply. Remove once fixed; a stale
   * flag fails the test.
   */
  guardPending?: string;
  /** Declared ahead of the owner's work (ADR-021); allowed to be missing on disk until it lands. */
  planned?: boolean;
  /**
   * A giver route that streams application/x-ndjson (A7 Gift Concierge): the one raw `new Response(stream)`
   * is allowed because every line passes assertGiverSafe before it is written (the guard pattern is still
   * required in its sources, and its route tests scan every streamed event). The value says why.
   */
  ndjsonStream?: string;
  /**
   * A giver route whose success response is audio bytes (A13 voice TTS): the one raw `new Response(bytes)`
   * is allowed because the audio is synthesized from shopper-facing reply text only; JSON (errors) still
   * goes through giverJson. The value says why.
   */
  audioResponse?: string;
}

export const ROUTE_MANIFEST: Record<string, RouteManifestEntry> = {
  // A1 platform
  "app/api/youcam/webhook/route.ts": {
    audience: "internal",
    owner: "A1",
    description: "YouCam task-completion webhook (HMAC-verified), server-to-server only",
  },
  "app/api/youcam/mock-asset/[name]/route.ts": {
    audience: "internal",
    owner: "A1",
    description: "Synthetic mock-mode assets for YOUCAM_MOCK=1 runs",
  },
  // A3 Fit Engine (thin route files; responses are built in server/fit/api.ts, scanned too)
  "app/api/fit/report/route.ts": {
    audience: "giver",
    owner: "A3",
    description: "Giver's Fit Report: scores, breakdown, short reasons for the shortlist",
  },
  "app/api/fit/decoys/route.ts": {
    audience: "giver",
    owner: "A3",
    description: "Decoy ids for a shortlist (created before any recipient data exists)",
  },
  "app/api/fit/weights/route.ts": {
    audience: "giver",
    owner: "A3",
    description: "Published Fit Score weights and Return-Risk formula (public, giver-visible)",
  },
  "app/api/fit/requests/route.ts": {
    audience: "giver",
    owner: "A3",
    description: "Create a Fit Request (decoys chosen server-side, never returned); returns giver token and links",
  },
  // A10 ingest (retailer console; allow-listed hosts, optional INGEST_ADMIN_TOKEN)
  "app/api/ingest/route.ts": {
    audience: "retailer",
    owner: "A10",
    description: "Start an ingest job for an allow-listed store URL; returns a job id",
  },
  "app/api/ingest/[jobId]/route.ts": {
    audience: "retailer",
    owner: "A10",
    description: "Ingest job status: tier, progress, SKU count",
  },
  // A10 store-URL preview (ADR-055): public, SSRF-guarded crawl of public product data; JSON through giverJson
  "app/api/preview/route.ts": {
    audience: "giver",
    owner: "A10",
    description: "Start a store-URL preview from a public https URL (SSRF-guarded async crawl); returns key, preview/status paths and a one-time owner link; 10/h, 5/day per IP, 100/day global",
  },
  "app/api/preview/[key]/route.ts": {
    audience: "giver",
    owner: "A10",
    description: "Preview crawl status: state, domain, store name, product count, refusal/failure reason (no products, no URLs)",
  },
  "app/api/preview/seed/route.ts": {
    audience: "internal",
    owner: "A6",
    description: "e2e only: stores a fixture store-URL preview (fictional .example store, nothing crawled); 404 unless PREVIEW_FIXTURE_SEED=1 and Bearer CRON_SECRET",
  },
  // A6 Admin v0 for store-URL previews (ADR-055): preview OWNER only (token → HttpOnly cookie), no recipient data
  "app/api/preview/[key]/session/route.ts": {
    audience: "retailer",
    owner: "A6",
    description: "Preview owner: turns the one-time owner token (#t= link fragment) into the HttpOnly, SameSite=Strict Admin v0 cookie for /admin/<key>; 204 or 403, never echoes the token",
  },
  // A16 owner-only real-credit recording switch (server/youcam/recording.ts): flags only, never a token
  "app/api/owner/recording/route.ts": {
    audience: "internal",
    owner: "A16",
    description: "GiftFit operator only: turns GIFTFIT_RECORDING_TOKEN into the HttpOnly gf_rec owner-recording cookie (POST), reports switch/owner/paid flags (GET), clears it (DELETE); 409 while YOUCAM_RECORDING is off",
  },
  // A6 retailer (aggregates and product data only; responses pass assertGiverSafe)
  "app/api/retailer/lookup/route.ts": { audience: "retailer", owner: "A6", description: "Public catalog lookup for the script tag (CORS): is this PDP's product in the store's catalog" },
  "app/api/retailer/purchase/route.ts": { audience: "retailer", owner: "A6", description: "Record a gift purchase of shortlisted pieces against the giver's Fit Request (no recipient data)" },
  "app/api/retailer/metrics/route.ts": { audience: "retailer", owner: "A6", description: "Retailer Console snapshot: funnel, hearted→bought, Undertone Coverage, Return-Risk; aggregates only" },
  // A5 seeded judge demo (public bootstrap; response = links + label only, through giverJson)
  "app/api/demo/seed/route.ts": {
    audience: "giver",
    owner: "A5",
    description: "Seeded judge demo: fresh Fit Request for an AI-generated model from committed fixtures; 0 units; 10/hour per IP",
  },
  // A7 Gift Concierge (catalog-only tools; draft brief, never creates a request)
  "app/api/concierge/route.ts": {
    audience: "giver",
    owner: "A7",
    description: "Gift Concierge: natural language → streamed reply, tool transcript and a DRAFT gift brief with ≤ 3 grounded catalog suggestions; 20/h, 60/day per IP",
    allowsProductImages: true,
    ndjsonStream: "streamed chat; each NDJSON event passes assertGiverSafe (server/concierge/stream.ts)",
  },
  // A6 embeddable widget (ADR-046): giver-token routes; e-mail addresses are sealed, request-scoped, never returned
  "app/api/widget/send-card/route.ts": {
    audience: "giver",
    owner: "A6",
    description: "E-mail the gift card for the giver's own Fit Request (giver + recipient token of the same request); per-giver/per-IP e-mail limits; returns sent/logged only",
  },
  "app/api/widget/notify/route.ts": {
    audience: "giver",
    owner: "A6",
    description: "Save the giver's e-mail for one 'Fit Report ready' note sent at Done; 10/h per IP; returns saved/ready only",
  },
  // A13 voice (ADR-052): shopper-facing, no recipient data; audio/text never logged or stored
  "app/api/voice/stt/route.ts": {
    audience: "giver",
    owner: "A13",
    description: "Push-to-talk clip (≤ 15 s, ≤ 1 MiB) → transcript via Speech-to-Text V2 chirp_3 (us); 20/h, 60/day per IP; 12 per widget session; daily audio-seconds cap",
  },
  "app/api/voice/tts/route.ts": {
    audience: "giver",
    owner: "A13",
    description: "Reply text (≤ 400 chars, any language with a Google voice) → MP3 from Google Cloud Text-to-Speech (or mock WAV), the only server voice (ADR-059); 40/h, 150/day per IP; 12 per widget session; daily character cap",
    audioResponse: "audio bytes synthesized from the shopper-facing reply text; errors through giverJson",
  },
  // A5 recipient
  "app/api/recipient/session/route.ts": {
    audience: "recipient",
    owner: "A5",
    description: "Open the recipient link: 6 opaque, shuffled carousel items; sets the gf_recipient cookie",
  },
  "app/api/recipient/consent/route.ts": {
    audience: "recipient",
    owner: "A5",
    description: "Record the recipient's consent",
  },
  "app/api/recipient/capture/route.ts": {
    audience: "recipient",
    owner: "A5",
    description: "POST: selfie (+ optional hand) → estimate + signed try-ons, photos deleted in finally. GET: same view on reload with fresh signed URLs (404 not_captured before capture)",
  },
  "app/api/recipient/swatch/route.ts": {
    audience: "recipient",
    owner: "A5",
    description: "Lazy render of one metal swatch (cached per photo + variant; at most 4 extra per request)",
  },
  "app/api/recipient/delete-photo/route.ts": {
    audience: "recipient",
    owner: "A5",
    description: "Delete my photo now: removes the kept selfie/hand photo immediately; no further metal renders (ADR-036)",
  },
  "app/api/recipient/wish-metal/route.ts": {
    audience: "recipient",
    owner: "A5",
    description: "Record 'wish it came in another metal' for one item (no render)",
  },
  "app/api/recipient/hearts/route.ts": {
    audience: "recipient",
    owner: "A5",
    description: "Replace the recipient's hearted set: opaque item + swatch ids (variant hearts); legacy itemIds",
  },
  "app/api/recipient/done/route.ts": {
    audience: "recipient",
    owner: "A5",
    description: "Finish: status completed, try-on renders deleted",
  },
  "app/api/recipient/delete/route.ts": {
    audience: "recipient",
    owner: "A5",
    description: "One-tap delete everything for the recipient session",
  },
  "app/api/recipient/undertone/route.ts": {
    audience: "recipient",
    owner: "A5",
    description: "Read the undertone estimate and set or clear the recipient's override",
  },
  "app/api/recipient/tryons/route.ts": {
    audience: "recipient",
    owner: "A5",
    description: "List the session's try-ons with fresh short-lived signed image URLs",
  },
  "app/api/recipient/tryon/[id]/route.ts": {
    audience: "recipient",
    owner: "A5",
    description: "Signed, session-bound try-on image fetch",
  },
  "app/api/recipient/purge-expired/route.ts": {
    audience: "internal",
    owner: "A5",
    description: "Cron: delete recipient data of expired Fit Requests and overdue blobs (CRON_SECRET)",
  },
  // A8 deployment
  "app/api/health/route.ts": {
    audience: "internal",
    owner: "A8",
    description: "Cloud Run health and deploy smoke: config flags and version only (no secrets, no request data)",
  },
};

/** Normalises a path to the manifest's key form (forward slashes, repo-relative). */
export function manifestKey(repoRelativePath: string): string {
  return repoRelativePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Identifiers that must not appear in giver route sources: they reach recipient imagery or
 * raw analysis output. Matching is on source text, so comments count too (keep giver routes clean).
 */
export const GIVER_FORBIDDEN_SOURCE_PATTERNS: Array<[RegExp, string]> = [
  [/\bresultRef\b|result_ref/, "try-on image reference"],
  [/\bPhotoStore\b|createPhotoStore|photo-store/, "photo store"],
  [/signTryOnUrl|signed-url/, "signed try-on URLs"],
  [/skin_color|lip_color|hair_color|eye_color|eyebrow_color/, "raw facial colors"],
  [/analyzeRecipient|facialColorTones|faceAttributes\s*\(/, "raw YouCam analysis"],
  // Scoring may read the RecipientProfile contract (labels + confidence); the raw estimator and
  // CIELAB internals stay out of giver code. Outputs are checked by giverJson and the probe.
  [/estimateUndertone|hueDeg|\blab\s*:/, "raw undertone estimate"],
  [/youcamResults|youcam_results/, "YouCam result cache"],
];

/** A giver route must send JSON through one of these. */
export const GIVER_GUARD_PATTERN = /\bgiverJson\s*\(|\bassertGiverSafe\s*\(/;

/** Violations of the giver-route rules in one route source file (empty = compliant). */
export function giverSourceViolations(source: string): string[] {
  const v: string[] = [];
  const guarded = GIVER_GUARD_PATTERN.test(source);
  if (!guarded) {
    v.push(
      /Response\.json\s*\(|NextResponse\.json\s*\(|new Response\s*\(/.test(source)
        ? "sends a response without giverJson()/assertGiverSafe()"
        : "never calls giverJson()/assertGiverSafe()",
    );
  }
  if (/new Response\s*\(/.test(source)) v.push("builds a raw Response (giver routes return JSON through giverJson only)");
  for (const [re, what] of GIVER_FORBIDDEN_SOURCE_PATTERNS) if (re.test(source)) v.push(`touches ${what}`);
  return v;
}

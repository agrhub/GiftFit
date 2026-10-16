/**
 * Giver-safety guard (owner: A5). MASTER_PLAN v2 §2 rule 1 and §4.4: a giver-facing response
 * never contains the recipient's images, hex colors, CIELAB values, face attributes or
 * structured undertone data. Scores, reasons, hearts and catalog data are fine.
 *
 * Use `giverJson(payload)` instead of `Response.json(payload)` in every giver route; it runs
 * `assertGiverSafe` and returns a 500 (without the payload) when a leak is found, so a bug
 * fails closed. lib/privacy/__tests__/route-manifest.test.ts checks every giver route uses it.
 */

import { GIVER_FACE_SHAPE_LABELS, GIVER_UNDERTONE_LABELS } from "./labels";

export interface GiverLeak {
  /** JSON path, e.g. "$.items[0].skin_color". */
  path: string;
  rule:
    | "forbidden_key"
    | "hex_color"
    | "lab_values"
    | "recipient_image"
    | "image_url";
  detail: string;
}

export class GiverLeakError extends Error {
  constructor(readonly leaks: GiverLeak[]) {
    super(`giver payload leaks recipient data: ${leaks.map((l) => `${l.path} (${l.rule}: ${l.detail})`).join("; ")}`);
    this.name = "GiverLeakError";
  }
}

export interface GiverGuardOptions {
  /**
   * Catalog routes may return product images under PRODUCT_IMAGE_KEYS. Recipient images
   * (signed try-on paths, blob storage, YouCam result hosts, data:/blob: URLs) are never allowed.
   */
  allowProductImages?: boolean;
}

/** Face-attribute keys from face-attr-analysis (request names and result names). */
const FACE_ATTRIBUTE_KEYS = [
  "faceshape",
  "face_shape",
  "faceaspectratio",
  "face_aspect_ratio",
  "facialratio",
  "cheekbone",
  "cheekbones",
  "eyedistance",
  "eye_distance",
  "eyeshape",
  "eyesize",
  "eyeangle",
  "eyelid",
  "eyebrow",
  "eyebrowshape",
  "eyebrowthickness",
  "eyebrowdistance",
  "eyebrowshortness",
  "lipshape",
  "nose",
  "nosewidth",
  "nose_width",
  "noselength",
  "agegender",
  "age",
  "gender",
  "horizontalthird",
  "verticalfifth",
  "eyeaspectratio",
  "eyebrowposition",
  "eyebrowarch",
  "eyeheighttoeyebrowdistance",
  "noseaspectratio",
  "nosewidthtomouthwidth",
  "nosetoliptochin",
  "upperliptolowerlip",
  "face_quality",
  "facequality",
];

const FORBIDDEN_KEY_PATTERNS: Array<[RegExp, string]> = [
  [/(skin|lip|eye|eyebrow|brow|hair|face)[_-]?(colou?r|tone|hex)s?$/i, "facial color"],
  [/^colou?rs?$/i, "colors object"],
  [/hex/i, "hex"],
  [/^lab$|^cielab$/i, "CIELAB"],
  [/^hue(deg|_?angle)?$/i, "hue angle"],
  [/undertone/i, "undertone data"],
  [/fitzpatrick|skin[_-]?type|skin[_-]?depth|monk/i, "skin type"],
  [/selfie|photo|portrait|picture|face[_-]?image|hand[_-]?image/i, "recipient image"],
  [/result[_-]?(ref|url|image)|try[_-]?on[_-]?(url|image|ref)|signed[_-]?url|render[_-]?url/i, "try-on image"],
  [/landmark|bbox|bounding[_-]?box|keypoint/i, "face geometry"],
];

/** Paths whose value may be a recipient label from the fixed vocabulary, and nothing else. */
const ALLOWED_LABEL_PATHS: Record<string, ReadonlySet<string>> = {
  "$.recipientLabels.undertone": GIVER_UNDERTONE_LABELS,
  "$.recipientLabels.faceShape": GIVER_FACE_SHAPE_LABELS,
};

/** Keys under which catalog routes may carry product images. */
export const PRODUCT_IMAGE_KEYS = new Set(["images", "image", "imageurl", "image_url", "vto_image", "thumbnail", "thumbnailurl"]);

const HEX_RE = /#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?\b/;
const IMAGE_EXT_RE = /\.(?:jpe?g|png|webp|gif|avif|heic|heif|bmp|tiff?)(?:[?#]|$)/i;
/** Things that are only ever recipient imagery. */
const RECIPIENT_IMAGE_RES: Array<[RegExp, string]> = [
  [/^data:image\//i, "data: image"],
  [/^blob:/i, "blob: URL"],
  [/\/api\/recipient\//i, "signed try-on path"],
  [/blob\.vercel-storage\.com/i, "Vercel Blob URL"],
  [/(makeupar|perfectcorp|youcam)[a-z0-9.-]*\.(com|net|io)/i, "YouCam result URL"],
  [/(^|\/)(recipient|tryon)\/[A-Za-z0-9_-]+\/(selfie|hand|tryon)-/i, "photo-store key"],
  [/^store:/i, "photo-store reference"],
];

function normaliseKey(k: string): string {
  return k.toLowerCase();
}

function looksLikeImageUrl(s: string): boolean {
  return (/^(https?:)?\/\//i.test(s) || s.startsWith("/")) && IMAGE_EXT_RE.test(s);
}

function isLabObject(v: Record<string, unknown>): boolean {
  return typeof v.L === "number" && typeof v.a === "number" && typeof v.b === "number";
}

/** Returns every leak in `payload` (empty when giver-safe). */
export function findGiverLeaks(payload: unknown, opts: GiverGuardOptions = {}): GiverLeak[] {
  const leaks: GiverLeak[] = [];
  const seen = new WeakSet<object>();

  const visitString = (s: string, path: string, parentKey: string | undefined) => {
    for (const [re, detail] of RECIPIENT_IMAGE_RES) {
      if (re.test(s)) {
        leaks.push({ path, rule: "recipient_image", detail });
        return;
      }
    }
    if (HEX_RE.test(s)) leaks.push({ path, rule: "hex_color", detail: s.match(HEX_RE)![0] });
    if (looksLikeImageUrl(s)) {
      const allowed = opts.allowProductImages === true && parentKey !== undefined && PRODUCT_IMAGE_KEYS.has(normaliseKey(parentKey));
      if (!allowed) leaks.push({ path, rule: "image_url", detail: "image URL on a giver route" });
    }
  };

  const visit = (v: unknown, path: string, parentKey: string | undefined) => {
    if (typeof v === "string") return visitString(v, path, parentKey);
    if (v === null || typeof v !== "object") return;
    if (seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      v.forEach((item, i) => visit(item, `${path}[${i}]`, parentKey));
      return;
    }
    const obj = v as Record<string, unknown>;
    if (isLabObject(obj)) leaks.push({ path, rule: "lab_values", detail: "object with numeric L, a, b" });
    for (const [k, child] of Object.entries(obj)) {
      const childPath = `${path}.${k}`;
      const nk = normaliseKey(k);
      // The only recipient-derived words a giver may see (lib/contracts/api.ts GiverReportStatus):
      // exactly these two paths, and only with a value from the fixed vocabulary (lib/privacy/labels.ts).
      const vocabulary = ALLOWED_LABEL_PATHS[childPath];
      if (vocabulary) {
        if (typeof child !== "string" || !vocabulary.has(child)) leaks.push({ path: childPath, rule: "forbidden_key", detail: "label not in the allowed vocabulary" });
        continue;
      }
      let flagged = false;
      if (FACE_ATTRIBUTE_KEYS.includes(nk)) {
        leaks.push({ path: childPath, rule: "forbidden_key", detail: "face attribute" });
        flagged = true;
      } else {
        for (const [re, detail] of FORBIDDEN_KEY_PATTERNS) {
          if (re.test(k)) {
            leaks.push({ path: childPath, rule: "forbidden_key", detail });
            flagged = true;
            break;
          }
        }
      }
      if (!flagged) visit(child, childPath, k);
    }
  };

  visit(payload, "$", undefined);
  return leaks;
}

/** Throws GiverLeakError if `payload` is not safe to send to a giver. */
export function assertGiverSafe<T>(payload: T, opts: GiverGuardOptions = {}): T {
  const leaks = findGiverLeaks(payload, opts);
  if (leaks.length) throw new GiverLeakError(leaks);
  return payload;
}

/**
 * Response.json for giver routes. On a leak it logs the paths (never the values) and returns
 * a generic 500, so recipient data cannot reach the giver even when a route has a bug.
 */
export function giverJson(payload: unknown, init: ResponseInit & GiverGuardOptions = {}): Response {
  const { allowProductImages, ...responseInit } = init;
  const leaks = findGiverLeaks(payload, { allowProductImages });
  const headers = new Headers(responseInit.headers);
  headers.set("Cache-Control", "private, no-store");
  if (leaks.length) {
    console.error("[privacy] blocked giver response:", leaks.map((l) => `${l.path} ${l.rule}`).join(", "));
    return Response.json({ error: "internal_error" }, { status: 500, headers });
  }
  return Response.json(payload, { ...responseInit, headers });
}

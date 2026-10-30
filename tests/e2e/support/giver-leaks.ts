/**
 * Independent leak scanner for giver-facing HTTP responses (owner: A8).
 *
 * Deliberately separate from A5's server/privacy/giver-guard.ts: the route handlers already run
 * giverJson(), so re-using the same function here would only prove the guard agrees with itself.
 * This scanner works on the raw bytes the browser would receive (body text, parsed JSON and the
 * response headers) and fails on:
 *   - any image URL (http(s), protocol-relative, root-relative or data:/blob: image), any YouCam,
 *     Vercel Blob or recipient try-on URL;
 *   - any hex colour value (#rrggbb / #rrggbbaa anywhere in the text, or a bare rrggbb under a
 *     colour/tone/hex key);
 *   - any face attribute or raw analysis key (face shape, eye/lip/nose shape, landmarks, skin colour,
 *     undertone numbers, Fitzpatrick / Monk type, CIELAB values).
 *   - a Set-Cookie header (a giver must never be handed a recipient session).
 */

export interface Leak {
  path: string;
  kind: "image_url" | "hex_color" | "face_attribute" | "header";
  detail: string;
}

export interface ScanOptions {
  /** Root-relative product image prefixes a giver catalog route may return (none for /api/fit/*). */
  allowProductImagePrefixes?: readonly string[];
  /**
   * Absolute product image URL prefixes (A6, ADR-055): a store-URL preview's products carry the
   * store's own image URLs (fixtures use the app's public catalog images by absolute URL).
   */
  allowProductImageUrls?: readonly string[];
}

const HEX_IN_TEXT = /#[0-9a-f]{6}(?:[0-9a-f]{2})?(?![0-9a-z])/i;
const BARE_HEX = /^(?:0x)?[0-9a-f]{6}(?:[0-9a-f]{2})?$/i;
const COLOR_KEY = /colou?r|hex|tone|rgb|lab$/i;

const IMAGE_EXT = /\.(?:jpe?g|png|webp|gif|avif|heic|heif|bmp|tiff?|svg)(?:[?#]|$)/i;
const URLISH = /^(?:https?:)?\/\/|^\//i;
const ALWAYS_IMAGE: Array<[RegExp, string]> = [
  [/data:image\//i, "data: image"],
  [/^blob:/i, "blob: URL"],
  [/blob\.vercel-storage\.com/i, "Vercel Blob URL"],
  [/(?:makeupar|perfectcorp|youcam)[a-z0-9.-]*\.(?:com|net|io)/i, "YouCam host"],
  [/\/api\/recipient\/tryon/i, "signed try-on path"],
  [/\/api\/youcam\/mock-asset/i, "mock try-on asset"],
];

/** JSON keys that carry face attributes or raw analysis (compared case-insensitively, _/- ignored). */
const FACE_KEYS = [
  "faceshape",
  "eyeshape",
  "eyesize",
  "eyeangle",
  "eyedistance",
  "eyelid",
  "lipshape",
  "lipthickness",
  "noseshape",
  "nosewidth",
  "noselength",
  "eyebrowshape",
  "browshape",
  "cheekbone",
  "cheekbones",
  "jawline",
  "chinshape",
  "landmarks",
  "landmark",
  "facebbox",
  "boundingbox",
  "skincolor",
  "skintone",
  "skinhex",
  "lipcolor",
  "eyecolor",
  "haircolor",
  "eyebrowcolor",
  "undertone",
  "undertoneestimate",
  "undertoneconfidence",
  "undertoneoverride",
  "fitzpatrick",
  "monk",
  "mst",
  "cielab",
  "lab",
  "huedeg",
  "hueangle",
  "selfie",
  "photo",
  "resultref",
  "resulturl",
  "tryonurl",
  "signedurl",
];
const FACE_KEY_SET = new Set(FACE_KEYS);
const norm = (k: string) => k.toLowerCase().replace(/[_\-\s]/g, "");

function isImageUrl(s: string, opts: ScanOptions): string | null {
  for (const [re, what] of ALWAYS_IMAGE) if (re.test(s)) return what;
  if (URLISH.test(s) && IMAGE_EXT.test(s)) {
    if (s.startsWith("/") && !s.startsWith("//") && opts.allowProductImagePrefixes?.some((p) => s.startsWith(p))) return null;
    if (/^https?:\/\//i.test(s) && opts.allowProductImageUrls?.some((p) => s.startsWith(p))) return null;
    return "image URL";
  }
  return null;
}

/**
 * The only face-related keys a giver may receive (server/contracts/api.ts GiverReportStatus, ADR-021):
 * label strings under recipientLabels. Matched by an independent strict pattern (not imported from
 * server/privacy) so a bug in the production label builder is still caught here.
 */
const ALLOWED_LABELS: Record<string, RegExp> = {
  "recipientLabels.undertone": /^(Warm|Neutral|Cool) undertone (estimate( \(low confidence\))?|\(their choice\))$/,
  "recipientLabels.faceShape": /^(Oval|Round|Square|Heart|InvTriangle|Inverted triangle|Oblong|Diamond|Triangle) face shape estimate$/,
};

function walk(value: unknown, path: string, key: string | null, out: Leak[], opts: ScanOptions): void {
  const allowedLabel = ALLOWED_LABELS[path];
  if (allowedLabel && typeof value === "string" && allowedLabel.test(value)) return;
  if (key !== null && FACE_KEY_SET.has(norm(key))) out.push({ path, kind: "face_attribute", detail: `key "${key}"` });
  if (typeof value === "string") {
    const img = isImageUrl(value.trim(), opts);
    if (img) out.push({ path, kind: "image_url", detail: `${img}: ${value.slice(0, 80)}` });
    if (HEX_IN_TEXT.test(value)) out.push({ path, kind: "hex_color", detail: value.slice(0, 80) });
    else if (key !== null && COLOR_KEY.test(key) && BARE_HEX.test(value.trim())) out.push({ path, kind: "hex_color", detail: `${key}=${value}` });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => walk(v, `${path}[${i}]`, null, out, opts));
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k, k, out, opts);
  }
}

/** Every leak in one giver response (empty array = clean). */
export function scanGiverResponse(bodyText: string, headers: Record<string, string>, opts: ScanOptions = {}): Leak[] {
  const out: Leak[] = [];
  // Raw-text pass first: catches anything a JSON walk could miss (HTML error pages, escaped strings).
  if (HEX_IN_TEXT.test(bodyText)) out.push({ path: "<body>", kind: "hex_color", detail: bodyText.match(HEX_IN_TEXT)![0] });
  for (const [re, what] of ALWAYS_IMAGE) if (re.test(bodyText)) out.push({ path: "<body>", kind: "image_url", detail: what });
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    parsed = undefined;
  }
  if (parsed !== undefined) walk(parsed, "", null, out, opts);
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "set-cookie") out.push({ path: `header:${name}`, kind: "header", detail: "giver response sets a cookie" });
    if (name.toLowerCase() === "link" && isImageUrl(value, opts)) out.push({ path: `header:${name}`, kind: "image_url", detail: value });
  }
  return out;
}

/**
 * Render and input-photo naming (owner: A5, ADR-032). The schema has no per-render variant
 * column, so the photo-store key name carries it (keys never leave the server):
 *
 *   recipient/<req>/<selfie|hand>-<exp>-<photoTag>                input photo
 *   tryon/<req>/tryon-<exp>-<d|x><variantTag><photoTag>            render of one metal variant
 *
 * d = rendered at capture (the default swatch), x = an extra swatch render (counts toward the cap).
 * variantTag/photoTag = first 16 base64url chars of SHA-256(variant id / photo bytes). The render
 * cache is per (photo, variant): a re-capture with a new photo never reuses an old render.
 */
import { createHash } from "node:crypto";

export const TAG_LENGTH = 16;
export type RenderKind = "d" | "x";

export function tagOf(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("base64url").slice(0, TAG_LENGTH);
}

export function renderName(kind: RenderKind, variantId: string, photoTag: string): string {
  return `${kind}${tagOf(variantId)}${photoTag}`;
}

export interface ParsedRender {
  exp: number;
  kind: RenderKind;
  variantTag: string;
  photoTag: string;
}

const RENDER_KEY = /^tryon\/[A-Za-z0-9_-]+\/tryon-(\d{10,16})-([dx])([A-Za-z0-9_-]{16})([A-Za-z0-9_-]{16})$/;

/**
 * Seeded judge demo (demo.ts): a render served from a committed fixture JPEG of an AI-generated model.
 *   fixture:<subject>/tryons/<file>.jpg|<d|x><variantTag><photoTag>|<exp>
 * Shared files are never deleted; revoking the request's rows/URLs is what "delete" means for them.
 */
const FIXTURE_REF = /^fixture:(showcase-[a-z-]+)\/tryons\/([A-Za-z0-9_-]+\.jpg)\|([dx])([A-Za-z0-9_-]{16})([A-Za-z0-9_-]{16})\|(\d{10,16})$/;

export function fixtureRenderRef(subject: string, file: string, kind: RenderKind, variantId: string, exp: number): string {
  return `fixture:${subject}/tryons/${file}|${kind}${tagOf(variantId)}${tagOf(subject)}|${exp}`;
}

export function parseFixtureRef(ref: string | null | undefined): { subject: string; file: string } | undefined {
  const m = ref ? FIXTURE_REF.exec(ref) : null;
  return m ? { subject: m[1], file: m[2] } : undefined;
}

/** Parses a render key, a `store:<key>` or a `fixture:` result ref; undefined for legacy/unnamed renders. */
export function parseRenderRef(ref: string | null | undefined): ParsedRender | undefined {
  if (!ref) return undefined;
  const f = FIXTURE_REF.exec(ref);
  if (f) return { exp: Number(f[6]), kind: f[3] as RenderKind, variantTag: f[4], photoTag: f[5] };
  const key = ref.startsWith("store:") ? ref.slice("store:".length) : ref;
  const m = RENDER_KEY.exec(key);
  return m ? { exp: Number(m[1]), kind: m[2] as RenderKind, variantTag: m[3], photoTag: m[4] } : undefined;
}

const INPUT_KEY = /^recipient\/[A-Za-z0-9_-]+\/(selfie|hand)-(\d{10,16})-([A-Za-z0-9_-]{16})$/;

export function parseInputKey(key: string): { kind: "selfie" | "hand"; exp: number; photoTag: string } | undefined {
  const m = INPUT_KEY.exec(key);
  return m ? { kind: m[1] as "selfie" | "hand", exp: Number(m[2]), photoTag: m[3] } : undefined;
}

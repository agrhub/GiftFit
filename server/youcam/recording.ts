/**
 * Owner-only real-credit recording switch (A16). Server-only.
 *
 * The public site spends 0 YouCam units. A paid YouCam call can happen only when ALL of these hold:
 *   1. YOUCAM_RECORDING=on (Cloud Run env; default off), and GIFTFIT_RECORDING_TOKEN (Secret Manager,
 *      ≥ 32 chars) is set;
 *   2. the client is in real mode with paid calls allowed and a key (YOUCAM_MOCK=0, YOUCAM_ALLOW_PAID=1,
 *      YOUCAM_API_KEY), and a durable counter backs the caps (STORE=firestore) with YOUCAM_DAILY_UNIT_CAP > 0;
 *   3. the recipient request carries the owner cookie `gf_rec` (minted only by POST /api/owner/recording with
 *      the token; HMAC-signed with the token, ≤ 6 h, HttpOnly);
 *   4. the route minted a short-lived paid grant from (1)–(3), and passed it to the shared client, which
 *      refuses every paid task without one (`requirePaidGrant`, CostGuardReason "recording_off");
 *   5. the cost guard still agrees (daily cap, total cap, per-process cap, live price, balance).
 * Anything else, including a leaked gift link opened by someone else, gets the 0-unit flow. Turning the switch
 * off (or rotating the token) invalidates every cookie and grant at once.
 *
 * Store-URL preview owner tokens are NOT owner credentials here: anyone can create a preview and own it.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isFirestoreStore } from "../store/config";
import { loadYoucamConfig, type Env } from "./config";
import { youcamState } from "./global-state";

export const RECORDING_COOKIE = "gf_rec";
/** Site-wide: the widget frame (/w) reads it for the giver's copy, the API for the recipient's try-on. */
export const RECORDING_COOKIE_PATH = "/";
export const RECORDING_SESSION_MS = 6 * 60 * 60 * 1000;
export const MIN_RECORDING_TOKEN_LENGTH = 32;
/** A paid grant lives for one capture or swatch call. */
export const PAID_GRANT_TTL_MS = 5 * 60 * 1000;

/** Anything with request headers (a Request, or next/headers in a server component). */
export type HeaderSource = { headers: { get(name: string): string | null } };

const flag = (v: string | undefined) => ["1", "true", "yes", "on"].includes((v ?? "").trim().toLowerCase());

/** YOUCAM_RECORDING=on. */
export function recordingSwitchOn(env: Env = process.env): boolean {
  return flag(env.YOUCAM_RECORDING);
}

/** The owner token (GIFTFIT_RECORDING_TOKEN), or undefined when missing or too short (= recording off). */
export function recordingToken(env: Env = process.env): string | undefined {
  const t = env.GIFTFIT_RECORDING_TOKEN?.trim();
  return t && t.length >= MIN_RECORDING_TOKEN_LENGTH && /^[\x21-\x7e]+$/.test(t) ? t : undefined;
}

/** The switch is on and a usable token exists (paid readiness is separate: paidReadiness). */
export function recordingEnabled(env: Env = process.env): boolean {
  return recordingSwitchOn(env) && recordingToken(env) !== undefined;
}

export type PaidBlocker =
  | "recording_switch_off"
  | "no_recording_token"
  | "youcam_mock"
  | "paid_not_allowed"
  | "no_api_key"
  | "no_durable_counter"
  | "no_daily_cap"
  | "config_error";

export interface PaidReadiness {
  /** True only when an owner-recording session could make a paid call right now (caps still apply). */
  youcamPaid: boolean;
  recording: "on" | "off";
  /** Why paid calls are impossible (empty when youcamPaid). No secrets. */
  blockers: PaidBlocker[];
  dailyUnitCap: number;
  totalUnitCap: number;
}

/** Whether the deployment can make a paid call for an owner session. Pure on `env`; free (no network). */
export function paidReadiness(env: Env = process.env): PaidReadiness {
  const blockers: PaidBlocker[] = [];
  if (!recordingSwitchOn(env)) blockers.push("recording_switch_off");
  if (!recordingToken(env)) blockers.push("no_recording_token");
  let dailyUnitCap = 0;
  let totalUnitCap = 0;
  try {
    const cfg = loadYoucamConfig(env);
    dailyUnitCap = cfg.dailyUnitCap;
    totalUnitCap = cfg.totalUnitCap;
    if (cfg.mock) blockers.push("youcam_mock");
    else if (!cfg.allowPaid) blockers.push("paid_not_allowed");
    if (!cfg.apiKey) blockers.push("no_api_key");
    if (cfg.dailyUnitCap <= 0) blockers.push("no_daily_cap");
  } catch {
    blockers.push("config_error");
  }
  let durable = false;
  try {
    durable = isFirestoreStore(env);
  } catch {
    durable = false;
  }
  if (!durable) blockers.push("no_durable_counter");
  return { youcamPaid: blockers.length === 0, recording: recordingEnabled(env) ? "on" : "off", blockers, dailyUnitCap, totalUnitCap };
}

// ---------------------------------------------------------------------------------------------------
// Owner cookie
// ---------------------------------------------------------------------------------------------------

const sign = (token: string, exp: number) => createHmac("sha256", token).update(`giftfit-recording-owner|v1|${exp}`, "utf8").digest("base64url");

/** Constant-time check of a presented owner token (hash both sides so lengths never leak). */
export function recordingTokenMatches(presented: unknown, env: Env = process.env): boolean {
  const token = recordingToken(env);
  if (!token || typeof presented !== "string" || presented.length > 512) return false;
  const a = createHash("sha256").update(presented.trim(), "utf8").digest();
  const b = createHash("sha256").update(token, "utf8").digest();
  return timingSafeEqual(a, b);
}

export function recordingCookieValue(token: string, nowMs: number = Date.now(), ttlMs: number = RECORDING_SESSION_MS): string {
  const exp = nowMs + Math.min(ttlMs, RECORDING_SESSION_MS);
  return `v1.${exp}.${sign(token, exp)}`;
}

export function verifyRecordingCookieValue(value: string | undefined, token: string | undefined, nowMs: number = Date.now()): boolean {
  if (!value || !token) return false;
  const m = /^v1\.(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!m) return false;
  const exp = Number(m[1]);
  if (!(exp > nowMs) || exp - nowMs > RECORDING_SESSION_MS) return false;
  const want = Buffer.from(sign(token, exp));
  const got = Buffer.from(m[2]);
  return want.length === got.length && timingSafeEqual(want, got);
}

/**
 * Set-Cookie for the owner session. On https it is `SameSite=None; Secure` so the owner is also recognised
 * inside the widget frame on the demo store (another site); the cookie only ever adds the owner's own
 * try-on, and recipient routes still need the recipient token (Bearer or the SameSite=Strict gf_recipient).
 */
export function recordingCookie(token: string, opts: { secure: boolean; nowMs?: number; ttlMs?: number }): string {
  const nowMs = opts.nowMs ?? Date.now();
  const ttl = Math.min(opts.ttlMs ?? RECORDING_SESSION_MS, RECORDING_SESSION_MS);
  return [
    `${RECORDING_COOKIE}=${recordingCookieValue(token, nowMs, ttl)}`,
    `Path=${RECORDING_COOKIE_PATH}`,
    "HttpOnly",
    ...(opts.secure ? ["Secure", "SameSite=None"] : ["SameSite=Lax"]),
    `Max-Age=${Math.floor(ttl / 1000)}`,
  ].join("; ");
}

export function clearRecordingCookie(opts: { secure: boolean }): string {
  return [`${RECORDING_COOKIE}=`, `Path=${RECORDING_COOKIE_PATH}`, "HttpOnly", ...(opts.secure ? ["Secure", "SameSite=None"] : ["SameSite=Lax"]), "Max-Age=0"].join("; ");
}

export function readCookie(req: HeaderSource, name: string): string | undefined {
  const cookie = req.headers.get("cookie");
  if (!cookie) return undefined;
  for (const part of cookie.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

/** The request comes from the owner's recording session (switch on, token set, valid unexpired cookie). */
export function isOwnerRecording(req: HeaderSource, env: Env = process.env, nowMs: number = Date.now()): boolean {
  if (!recordingSwitchOn(env)) return false;
  return verifyRecordingCookieValue(readCookie(req, RECORDING_COOKIE), recordingToken(env), nowMs);
}

// ---------------------------------------------------------------------------------------------------
// Paid grants (capabilities handed to the shared client for one owner call)
// ---------------------------------------------------------------------------------------------------

export interface PaidGrant {
  readonly kind: "giftfit.youcam.paid-grant";
  readonly exp: number;
}

function grants(): WeakSet<object> {
  return (youcamState().paidGrants ??= new WeakSet());
}

/**
 * A grant for an owner-recording request when the deployment is paid-ready; undefined otherwise. Grants are
 * registered on globalThis (every route bundle and the shared client see the same registry, ADR-023), so an
 * object that merely looks like one is refused.
 */
export function mintPaidGrant(req: HeaderSource, env: Env = process.env, nowMs: number = Date.now()): PaidGrant | undefined {
  if (!isOwnerRecording(req, env, nowMs) || !paidReadiness(env).youcamPaid) return undefined;
  const g: PaidGrant = Object.freeze({ kind: "giftfit.youcam.paid-grant" as const, exp: nowMs + PAID_GRANT_TTL_MS });
  grants().add(g);
  return g;
}

export function isValidPaidGrant(g: unknown, nowMs: number = Date.now(), env: Env = process.env): g is PaidGrant {
  if (!g || typeof g !== "object" || !grants().has(g)) return false;
  return (g as PaidGrant).exp > nowMs && recordingEnabled(env);
}

// ---------------------------------------------------------------------------------------------------
// Observability (no PII, no secrets)
// ---------------------------------------------------------------------------------------------------

/** One structured line saying whether paid mode is possible (boot, and on every switch-relevant start). */
export function logPaidMode(where: string, env: Env = process.env): PaidReadiness {
  const r = paidReadiness(env);
  console.info(
    JSON.stringify({
      severity: r.youcamPaid ? "NOTICE" : "INFO",
      message: `youcam paid mode ${r.youcamPaid ? "ON for owner recording sessions" : "off"}`,
      where,
      youcamPaid: r.youcamPaid,
      recording: r.recording,
      blockers: r.blockers,
      dailyUnitCap: r.dailyUnitCap,
      totalUnitCap: r.totalUnitCap,
    }),
  );
  return r;
}

/** One structured line per paid call that the guard allowed (feature and units only). */
export function logPaidCall(e: { feature: string; units: number; dayUnits: number; dailyUnitCap: number }): void {
  console.info(JSON.stringify({ severity: "NOTICE", message: "youcam paid call (owner recording)", paidMode: "on", ...e }));
}

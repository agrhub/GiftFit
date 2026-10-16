/**
 * Runtime configuration for the YouCam client, read from environment variables.
 *
 * Mode resolution (binding rule from the P1 orchestrator):
 *   - YOUCAM_MOCK=1            -> mock mode (fixtures, zero network, zero units)
 *   - YOUCAM_MOCK=0            -> real mode; paid tasks still need YOUCAM_ALLOW_PAID=1
 *   - YOUCAM_MOCK unset        -> real mode only when YOUCAM_ALLOW_PAID=1, otherwise mock
 * So a paid call always needs YOUCAM_MOCK unset/0 AND YOUCAM_ALLOW_PAID=1, and an
 * unconfigured checkout defaults to mock.
 */
import os from "node:os";
import path from "node:path";
import { DEFAULT_FIXTURES_ROOT } from "./mock";

export const DEFAULT_BASE_URL = "https://yce-api-01.makeupar.com";
/** Judges' reserve (MASTER_PLAN v2 4.3): never let the balance drop below this. */
export const DEFAULT_RESERVE_UNITS = 300;
/** Per-run (per client instance / process) spending cap. One full Fit Request is 36 units. */
export const DEFAULT_MAX_UNITS_PER_RUN = 40;
/** Process-wide units per UTC day (A8 deploy requirement 4). 0 disables. */
export const DEFAULT_DAILY_UNIT_CAP = 150;

/** Jewelry 2d-vto body variants from docs/hackathon/first_real_calls.md (see buildJewelryBody). */
export type JewelryBodyVariant = "A" | "B" | "C";
export const JEWELRY_BODY_VARIANTS: readonly JewelryBodyVariant[] = ["A", "B", "C"];
export const DEFAULT_POLL_INTERVAL_MS = 5_000;
export const DEFAULT_MAX_POLLS = 60;

export type Env = Record<string, string | undefined>;

export interface YoucamConfig {
  /** Server-side only. Never logged. */
  apiKey?: string;
  baseUrl: string;
  /** True when no network call to YouCam is made at all. */
  mock: boolean;
  /** True when paid (task-creating) calls are permitted by configuration. */
  allowPaid: boolean;
  reserveUnits: number;
  maxUnitsPerRun: number;
  /**
   * Max units committed per UTC day across the process (YOUCAM_DAILY_UNIT_CAP). Default 150 in
   * real mode; 0 disables it, and it is disabled in mock mode unless set explicitly.
   */
  dailyUnitCap: number;
  webhookSecret?: string;
  pollIntervalMs: number;
  maxPolls: number;
  mockLatencyMs: number;
  /**
   * Jewelry 2d-vto body variant (docs ambiguous, api_matrix.md section 9). Default "A"
   * (superset). The smoke script resolves the real one; pin it with YOUCAM_JEWELRY_BODY_VARIANT.
   */
  jewelryBodyVariant: JewelryBodyVariant;
  fixturesDir: string;
  /** Local runtime data (audit JSONL fallback, file result cache). Gitignored. */
  dataDir: string;
  databaseUrl?: string;
}

function flag(v: string | undefined): boolean | undefined {
  if (v === undefined || v.trim() === "") return undefined;
  return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
}

function int(v: string | undefined, fallback: number, name: string): number {
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${name} must be a non-negative number, got "${v}"`);
  }
  return Math.floor(n);
}

function jewelryVariant(v: string | undefined): JewelryBodyVariant {
  if (v === undefined || v.trim() === "") return "A";
  const u = v.trim().toUpperCase();
  if ((JEWELRY_BODY_VARIANTS as readonly string[]).includes(u)) return u as JewelryBodyVariant;
  throw new Error(`YOUCAM_JEWELRY_BODY_VARIANT must be one of ${JEWELRY_BODY_VARIANTS.join(", ")}, got "${v}"`);
}

export function defaultDataDir(env: Env = process.env): string {
  if (env.GIFTFIT_DATA_DIR) return path.resolve(env.GIFTFIT_DATA_DIR);
  // Serverless filesystems are read-only except the temp dir.
  if (env.VERCEL) return path.join(os.tmpdir(), "giftfit");
  return path.join(process.cwd(), ".giftfit");
}

export function loadYoucamConfig(env: Env = process.env): YoucamConfig {
  const mockFlag = flag(env.YOUCAM_MOCK);
  const allowPaid = flag(env.YOUCAM_ALLOW_PAID) === true;
  const mock = mockFlag === undefined ? !allowPaid : mockFlag;
  return {
    apiKey: env.YOUCAM_API_KEY?.trim() || undefined,
    baseUrl: (env.YOUCAM_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    mock,
    allowPaid: !mock && allowPaid,
    reserveUnits: int(env.YOUCAM_RESERVE_UNITS, DEFAULT_RESERVE_UNITS, "YOUCAM_RESERVE_UNITS"),
    maxUnitsPerRun: int(env.YOUCAM_MAX_UNITS_PER_RUN, DEFAULT_MAX_UNITS_PER_RUN, "YOUCAM_MAX_UNITS_PER_RUN"),
    dailyUnitCap: int(env.YOUCAM_DAILY_UNIT_CAP, mock ? 0 : DEFAULT_DAILY_UNIT_CAP, "YOUCAM_DAILY_UNIT_CAP"),
    webhookSecret: env.YOUCAM_WEBHOOK_SECRET?.trim() || undefined,
    pollIntervalMs: int(env.YOUCAM_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS, "YOUCAM_POLL_INTERVAL_MS"),
    maxPolls: Math.max(1, int(env.YOUCAM_MAX_POLLS, DEFAULT_MAX_POLLS, "YOUCAM_MAX_POLLS")),
    mockLatencyMs: int(env.YOUCAM_MOCK_LATENCY_MS, 0, "YOUCAM_MOCK_LATENCY_MS"),
    jewelryBodyVariant: jewelryVariant(env.YOUCAM_JEWELRY_BODY_VARIANT),
    // Default from mock.ts's static root (ADR-019); only an explicit override is resolved at runtime.
    fixturesDir: env.YOUCAM_FIXTURES_DIR ? path.resolve(env.YOUCAM_FIXTURES_DIR) : DEFAULT_FIXTURES_ROOT,
    dataDir: defaultDataDir(env),
    databaseUrl: env.DATABASE_URL?.trim() || undefined,
  };
}
